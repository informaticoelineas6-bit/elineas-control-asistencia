import { z } from "zod";

/**
 * Esquemas de notificaciones (spec 14).
 *
 * Sólo el servidor las crea (RN-14.2) y cada usuario ve exclusivamente las
 * suyas (RN-14.1) — ni un `global_manager` ve las de otro.
 */

/**
 * Catálogo de tipos. Como el de auditoría, cerrado y creciendo spec a spec:
 * hoy están los dos que la spec 01 §5.1 pide (pausa y reanudación de
 * departamento). El resto del catálogo de la spec 14 §4 se añade cuando su
 * spec de origen se implemente.
 */
export const notificationTypeSchema = z.enum([
	"department.paused",
	"department.resumed",
	/** Alta a medias: existe la cuenta en el IS pero falta el perfil (RN-02.12). */
	"profile.incomplete",
	/** Tu perfil quedó completo: ya puedes marcar (spec 02 §5.1 paso 2). */
	"profile.department_changed",
	/**
	 * El horario del departamento cambió (spec 07 RN-07.10). Lleva `dedupeKey` por
	 * departamento: dos ajustes seguidos actualizan el mismo aviso en vez de
	 * apilar dos, que es lo que pasa cuando alguien corrige una hora mal puesta.
	 */
	"schedule.changed",
	/**
	 * Tu sede de trabajo se desactivó y con ella tu selección (spec 08 RN-08.6). El
	 * aviso lo genera el servidor al desactivar, no el cliente al descubrirlo: la
	 * persona tiene que enterarse antes de plantarse en la puerta a marcar.
	 */
	"work_location.deactivated",
]);

export const notificationSchema = z.object({
	id: z.uuid(),
	type: notificationTypeSchema,
	title: z.string(),
	body: z.string(),
	/** A dónde lleva al tocarla. Nulo = puramente informativa. */
	actionUrl: z.string().nullable(),
	/** Nulo = no leída. */
	readAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
});

export const listNotificationsQuerySchema = z.object({
	unreadOnly: z.stringbool().default(false),
	limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const unreadCountSchema = z.object({
	count: z.number().int().nonnegative(),
});

export type Notification = z.infer<typeof notificationSchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;
