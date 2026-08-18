import { notificationsSpec } from "@elineas/contracts";
import { listNotificationsQuerySchema } from "@elineas/validations";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
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
 * para un `global_manager`.
 */
export const notifications = new Hono();

notifications.use("*", requireAuth);

notifications.get(
	"/",
	validate("query", listNotificationsQuerySchema),
	async (c) => {
		const { unreadOnly, limit } = c.req.valid("query");
		const rows = await listNotifications(getAuth(c).profile.id, {
			unreadOnly,
			limit,
		});
		return c.json(notificationsSpec.list.response.parse(rows));
	},
);

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
