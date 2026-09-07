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
	/**
	 * No tienes descansos configurados para la semana en curso (spec 10 RN-10.10).
	 * Lleva `dedupeKey` por persona: es un recordatorio, y tres copias del mismo
	 * recordatorio en la campana no recuerdan más, sólo tapan lo demás.
	 *
	 * ⚠️ Hallazgo H-4: en el legacy esta regla vivía en el contexto de
	 * notificaciones del **frontend**, así que sólo se disparaba si la persona
	 * abría la aplicación. Aquí la evalúa el servidor al iniciar sesión.
	 */
	"rest_schedule.missing",
	/**
	 * Vacaciones (spec 11 §5). Tres momentos del flujo, cada uno a su
	 * destinatario: la solicitud avisa al jefe (cuando es localizable, ver
	 * `vacations.ts`), la revisión avisa a quien la pidió, y una cancelación de
	 * lo ya aprobado también — es lo que evita que alguien se presente a
	 * trabajar sin saber que su descanso dejó de existir.
	 */
	"vacation.requested",
	"vacation.reviewed",
	"vacation.cancelled",
	/**
	 * Incidencias de asistencia (spec 12 RN-12.10). Dos momentos: al crear avisa
	 * al jefe —con la misma limitación que las vacaciones, sólo alcanza a quien
	 * gestiona el departamento como responsabilidad adicional (ver
	 * `services/incidents.ts`)— y al revisar avisa a quien la reportó.
	 *
	 * Sin `dedupeKey`: cada incidencia es un hecho distinto aunque coincidan el
	 * día y el tipo, y agrupar dos avisos escondería el segundo.
	 */
	"incident.reported",
	"incident.reviewed",
	/**
	 * Tu ausencia fue clasificada (spec 13 RN-13.7), y con qué efecto en la
	 * nómina (spec 17 RN-17.10).
	 *
	 * ⚠️ **Los dos son huecos del legacy** (punto 76): allí el empleado se
	 * enteraba del descuento en la boleta. Es **un** tipo y no dos porque para
	 * quien lo recibe es un solo hecho —"me clasificaron el día 3 y me
	 * descontaron"—, y partirlo en dos avisos que llegan juntos sólo llena la
	 * campana. Cuando la spec 17 traiga los ajustes **manuales**, que no nacen de
	 * una ausencia, ésos sí necesitarán su propio tipo.
	 */
	"absence.reviewed",
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
