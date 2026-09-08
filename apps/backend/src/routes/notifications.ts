import { notificationsSpec } from "@elineas/contracts";
import {
	listNotificationsQuerySchema,
	notificationEventSchema,
} from "@elineas/validations";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { subscribeLiveUpdates } from "#/lib/live.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth } from "#/middleware/auth";
import {
	countUnread,
	listNotifications,
	markAllRead,
	markRead,
} from "#/services/notifications.ts";

/**
 * Notificaciones del usuario autenticado (spec 14 §7). Montado en
 * `/api/notifications`.
 *
 * **Ningún endpoint recibe un `userId`** (RN-14.1): el destinatario es siempre
 * quien tiene la sesión. Así no existe la posibilidad de pedir las de otro, ni
 * para un `global_manager`. Y **ninguno crea** (RN-14.2): las notificaciones
 * nacen en la transacción del hecho que las origina, así que un `POST` aquí sólo
 * serviría para inventarse un aviso.
 */
export const notifications = new Hono();

notifications.use("*", requireAuth);

notifications.get(
	"/",
	validate("query", listNotificationsQuerySchema),
	async (c) => {
		const page = await listNotifications(
			getAuth(c).profile.id,
			c.req.valid("query"),
		);
		return c.json(notificationsSpec.list.response.parse(page));
	},
);

/**
 * `GET /notifications/stream` (RN-14.4) — la entrega en vivo, por **SSE**.
 *
 * Decisión 1 de la §10, cerrada. El tráfico va en un solo sentido, así que un
 * WebSocket añadiría un canal de vuelta que no se usaría y una negociación de
 * protocolo que los proxys tratan aparte; `EventSource` reconecta solo y Hono
 * trae `streamSSE`, sin dependencias nuevas.
 *
 * Tres detalles que hacen que esto aguante una tarde abierto:
 *
 * - **Va antes que `/:id/read`**, como `read-all`, para que el patrón no se lo
 *   coma.
 * - **Late.** Un `ping` cada 25 s sin tocar la base: los intermediarios cierran
 *   las conexiones calladas, y una conexión cerrada sin que el cliente lo sepa
 *   es peor que no tenerla. El latido **no** consulta el contador — con
 *   doscientas conexiones abiertas eso serían ocho consultas por segundo para
 *   decir "sigo aquí".
 * - **Se da de baja siempre.** Si el suscriptor se quedara en el mapa, cada
 *   recarga de pestaña dejaría uno muerto.
 *
 * Lo que viaja es un aviso, no la notificación: el contenido lo pide el cliente
 * por `GET /notifications`, que filtra por la sesión (RN-14.1).
 */
notifications.get("/stream", (c) => {
	const userId = getAuth(c).profile.id;

	return streamSSE(c, async (stream) => {
		let changed = Promise.resolve();
		let wake = () => {};
		const rearm = () => {
			changed = new Promise<void>((resolve) => {
				wake = resolve;
			});
		};
		rearm();

		let open = true;
		const unsubscribe = subscribeLiveUpdates(userId, () => wake());
		stream.onAbort(() => {
			open = false;
			wake();
		});

		try {
			// El primer evento va sin esperar: así el cliente sabe que la conexión
			// está viva y sincroniza el contador al conectar, que es justo cuando
			// puede haber cambiado sin que se enterara.
			await send(stream, userId);

			while (open) {
				const awakened = await Promise.race([
					changed.then(() => true),
					sleep(HEARTBEAT_MS).then(() => false),
				]);
				if (!open) break;

				if (awakened) {
					rearm();
					await send(stream, userId);
				} else {
					await stream.writeSSE({ event: "ping", data: "" });
				}
			}
		} finally {
			unsubscribe();
		}
	});
});

const HEARTBEAT_MS = 25_000;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		// `unref` para que un latido pendiente no retenga el proceso: si no, cerrar
		// el servidor —o terminar una prueba— esperaría hasta 25 s por un
		// temporizador que ya no le importa a nadie.
		setTimeout(resolve, ms).unref?.();
	});

async function send(
	stream: { writeSSE: (message: { data: string }) => Promise<void> },
	userId: string,
): Promise<void> {
	const unread = await countUnread(userId);
	await stream.writeSSE({
		data: JSON.stringify(
			notificationEventSchema.parse({
				type: "notifications.changed",
				unread,
			}),
		),
	});
}

/** Sonda del contador del aside: barata y sondeable cada pocos segundos. */
notifications.get("/unread-count", async (c) => {
	const count = await countUnread(getAuth(c).profile.id);
	return c.json(notificationsSpec.unreadCount.response.parse({ count }));
});

/** RN-14.3: marcar todas. Antes que `/:id/read`, para que no se lo coma el patrón. */
notifications.post("/read-all", async (c) => {
	const updated = await markAllRead(getAuth(c).profile.id);
	return c.json(notificationsSpec.markAllRead.response.parse({ updated }));
});

notifications.post(
	"/:id/read",
	validate("param", z.object({ id: z.uuid("Identificador no válido.") })),
	async (c) => {
		const updated = await markRead(
			getAuth(c).profile.id,
			c.req.valid("param").id,
		);
		// Una notificación de otra persona da el mismo 404 que una inexistente: no
		// hay diferencia observable, así que no se puede sondear ids ajenos.
		if (!updated) {
			throw new HTTPException(404, { message: "Esa notificación no existe." });
		}
		return c.json(notificationsSpec.markRead.response.parse(updated));
	},
);
