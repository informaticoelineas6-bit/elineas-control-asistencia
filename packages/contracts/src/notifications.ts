import {
	listNotificationsQuerySchema,
	notificationPageSchema,
	notificationSchema,
	unreadCountSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de notificaciones (spec 14 §7).
 *
 * Todo exige sesión y está acotado al usuario autenticado (RN-14.1): no hay
 * ningún endpoint que reciba un `userId`, precisamente para que no exista la
 * posibilidad de leer las de otro. **Y no hay ninguno que cree una**: RN-14.2
 * dice que sólo el servidor las genera, en la transacción del hecho que las
 * origina, así que un `POST /notifications` sólo serviría para inventarse un
 * aviso.
 *
 * **Decisión 1 de la §10, cerrada: la entrega en vivo es SSE.** El tráfico va en
 * un solo sentido —servidor → cliente—, así que un WebSocket añadiría un canal
 * de vuelta que nunca se usaría, más una negociación de protocolo que los proxys
 * tratan aparte. `EventSource` reconecta solo, Hono trae `streamSSE` y no hace
 * falta ninguna dependencia nueva. El sondeo **se queda** como respaldo, que es
 * lo que RN-14.4 exige mantener en cualquier caso.
 */
export const notificationsSpec = {
	list: {
		method: "GET",
		path: "/api/notifications",
		query: listNotificationsQuerySchema,
		response: notificationPageSchema,
	},
	/**
	 * RN-14.4 — El flujo de eventos. **No devuelve JSON**: es un `text/event-stream`
	 * que se lee con `EventSource`, y por eso no lleva `response`.
	 *
	 * Lo que viaja es un **aviso**, no la notificación (ver `notificationEventSchema`):
	 * el contenido sale siempre de `list`, que filtra por la sesión.
	 */
	stream: {
		method: "GET",
		path: "/api/notifications/stream",
	},
	unreadCount: {
		method: "GET",
		path: "/api/notifications/unread-count",
		response: unreadCountSchema,
	},
	/** Única mutación que hace el usuario (RN-14.3). */
	markRead: {
		method: "POST",
		path: "/api/notifications/:id/read",
		response: notificationSchema,
	},
	markAllRead: {
		method: "POST",
		path: "/api/notifications/read-all",
		response: z.object({ updated: z.number().int().nonnegative() }),
	},
} as const;
