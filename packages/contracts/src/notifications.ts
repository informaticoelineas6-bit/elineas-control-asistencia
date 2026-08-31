import {
	listNotificationsQuerySchema,
	notificationSchema,
	unreadCountSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de notificaciones (spec 14 §7), en su mínimo viable.
 *
 * Todo exige sesión y está acotado al usuario autenticado (RN-14.1): no hay
 * ningún endpoint que reciba un `userId`, precisamente para que no exista la
 * posibilidad de leer las de otro.
 *
 * No hay `stream` todavía: la entrega en vivo (SSE o WebSocket) es decisión
 * abierta de la spec 14. El frontend sondea, que es el respaldo que RN-14.4
 * exige mantener en cualquier caso.
 */
export const notificationsSpec = {
	list: {
		method: "GET",
		path: "/api/notifications",
		query: listNotificationsQuerySchema,
		response: z.array(notificationSchema),
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
