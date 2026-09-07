import { z } from "zod";
import { attendanceDaySchema, attendanceMarkSchema } from "./attendance.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Incidencias de asistencia (spec 12): la vía formal para que un empleado
 * reporte un problema con su marcaje —olvidó marcar, llegó tarde por una razón,
 * el GPS falló, la geocerca lo rechazó— y el jefe deje constancia de la
 * revisión.
 *
 * **No es la justificación de ausencias de la spec 13** (§2): esa la inicia el
 * jefe, va sobre un día completo y mueve la nómina. Aquí no se mueve nada —
 * RN-12.9, aprobar es un acto documental.
 *
 * Como en las specs 10 y 11, aquí vive el vocabulario y **lo que comparten
 * servidor e interfaz**: qué tipos exigen motivo (RN-12.1) y si la fecha que se
 * reporta es admisible (RN-12.3 y RN-12.4). El formulario tiene que poder decir
 * "esto no se va a aceptar" antes de enviarlo, y con la misma función con la que
 * el servidor lo rechaza.
 *
 * Decisiones de la §9 que se cierran aquí:
 *
 * 2. **RN-12.4 — el plazo para reportar es configuración, y `0` significa "sin
 *    plazo".** La spec proponía un default de 7 días; el default es 0 por el
 *    criterio de la spec 06 §3 —el valor por defecto se comporta *como si la
 *    clave no estuviera configurada*— y por el mismo motivo que
 *    `rest_days_min_separation` (spec 10 RN-10.5): la cifra es una regla laboral
 *    y la pone el negocio. Lo que sí tiene que existir ya es el sitio donde
 *    ponerla (`incident_report_window_days`), o el día que se decida será un
 *    despliegue en vez de un cambio de configuración.
 * 3. **Aprobar «olvidé marcar» no crea el marcaje que falta.** RN-12.9 ya lo
 *    dice para el caso general y aquí se confirma para el caso concreto que
 *    pregunta la decisión 3: la incidencia **no captura una hora declarada** —la
 *    §3 no tiene ese campo—, así que no hay de dónde sacar el instante de la
 *    marca. Cambiarlo no es tocar la aprobación: es añadir la hora al modelo,
 *    un valor nuevo de `source` (spec 09 RN-09.14) y decidir qué hace la
 *    secuencia (RN-09.9) con una marca insertada a posteriori.
 * 4. **No hay adjuntos.** Ni evidencia en foto ni certificados: este sistema no
 *    almacena archivos en ninguna parte, y el caso técnico —"intenté marcar y no
 *    me dejó"— ya trae su prueba dentro (RN-12.2, el marcaje bloqueado con su
 *    motivo tipado).
 *
 * Y sigue **abierta a propósito la decisión 1**, la más importante de la spec:
 * si aprobar una incidencia debe justificar la ausencia de ese día y evitar el
 * descuento de nómina. No se puede cerrar todavía porque la justificación es de
 * la [spec 13](../../specs/13-justificacion-ausencias.md) y no existe: no hay
 * nada que enlazar. La costura queda preparada —la incidencia guarda su `date`,
 * su `user_id` y su estado— igual que la spec 09 dejó los descansos entrando por
 * un predicado antes de que la 10 existiera.
 */

/** §4. Los tres primeros son los "críticos" de RN-12.1. */
export const incidentTypeSchema = z.enum([
	/** No registró entrada o salida. */
	"forgot_to_mark",
	/** Llegó tarde y quiere explicar por qué. */
	"late_arrival",
	/** Se retiró antes de la ventana. */
	"early_departure",
	/** El dispositivo no obtuvo ubicación válida. */
	"gps_issue",
	/** Estaba en sede pero la geocerca lo rechazó. */
	"geofence_issue",
]);

export const incidentStatusSchema = z.enum(["pending", "approved", "rejected"]);

/**
 * Etiquetas de la §4, en español y **en un solo sitio**: las pinta la lista del
 * empleado, la bandeja del jefe y el cuerpo de las notificaciones. Repartidas
 * por pantalla acaban divergiendo, que es como el mismo tipo se llama "Tardanza"
 * en un lado y "Llegada tarde" en otro.
 */
export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
	forgot_to_mark: "Olvidé marcar",
	late_arrival: "Tardanza",
	early_departure: "Salida temprana",
	gps_issue: "Problema de GPS",
	geofence_issue: "Rechazo de geocerca",
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
	pending: "Pendiente",
	approved: "Aprobada",
	rejected: "Rechazada",
};

/**
 * RN-12.1 — Los tipos "críticos" exigen motivo. Los técnicos pueden enviarse sin
 * texto porque el sistema ya tiene la evidencia: el intento de marcaje quedó
 * registrado con su motivo tipado (spec 09 RN-09.8).
 */
export const CRITICAL_INCIDENT_TYPES = [
	"forgot_to_mark",
	"late_arrival",
	"early_departure",
] as const satisfies readonly IncidentType[];

export function incidentRequiresReason(type: IncidentType): boolean {
	return (CRITICAL_INCIDENT_TYPES as readonly IncidentType[]).includes(type);
}

/**
 * RN-12.3 y RN-12.4 en una sola función, con el **mensaje** dentro: es la forma
 * de `checkoutModeIssue` y `restLimitsIssue` de la spec 06, y por el mismo
 * motivo —el formulario y el servidor tienen que rechazar lo mismo y decirlo
 * igual.
 *
 * `windowDays <= 0` desactiva el plazo (decisión 2, arriba). `today` se pasa
 * como argumento y no se lee del reloj: quien llama sabe en qué zona está el
 * "hoy" que corresponde (RN-07.2), y una función pura se puede probar.
 */
export function incidentDateIssue(input: {
	date: string;
	today: string;
	windowDays: number;
}): string | null {
	// RN-12.3 — Fechas pasadas o de hoy. Una incidencia describe algo que ya
	// ocurrió; a futuro no hay nada que reportar todavía.
	if (input.date > input.today) {
		return "Una incidencia se reporta sobre un día que ya pasó, o sobre hoy.";
	}

	if (input.windowDays <= 0) return null;

	const days =
		(Date.parse(`${input.today}T00:00:00.000Z`) -
			Date.parse(`${input.date}T00:00:00.000Z`)) /
		86_400_000;

	if (days > input.windowDays) {
		return `El plazo para reportar una incidencia es de ${input.windowDays} ${input.windowDays === 1 ? "día" : "días"}: esa fecha ya quedó fuera.`;
	}
	return null;
}

/**
 * `POST /incidents` (§7).
 *
 * `reason` admite vacío en el esquema y lo exige el `refine` sólo para los tipos
 * críticos (RN-12.1): la obligatoriedad depende de otro campo del mismo cuerpo,
 * así que no puede vivir en el `.min(1)` de la cadena.
 *
 * `attendanceMarkId` es la propuesta RN-12.2: enlazar la incidencia al marcaje
 * bloqueado que la originó. El legacy no lo hacía y por eso el revisor tenía que
 * buscar la evidencia a mano. Que el marcaje sea **de quien reporta** lo
 * comprueba el servidor, no este esquema.
 *
 * **No lleva `userId`**: una incidencia es siempre para uno mismo (RN-12.3), y
 * un campo de persona en el cuerpo sería un endpoint para reportar en nombre de
 * otro que nadie ha pedido — el mismo criterio que `POST /vacations/requests`.
 */
export const createIncidentInputSchema = z
	.object({
		incidentType: incidentTypeSchema,
		date: isoDateSchema,
		reason: z.string().trim().max(1000).default(""),
		attendanceMarkId: z
			.uuid("El identificador de marcaje no es válido.")
			.nullable()
			.default(null),
	})
	.refine(
		(input) =>
			!incidentRequiresReason(input.incidentType) || input.reason.length > 0,
		{
			message: "Ese tipo de incidencia necesita que expliques qué pasó.",
			path: ["reason"],
		},
	);

/**
 * `POST /incidents/:id/review` (§7).
 *
 * RN-12.7 — Rechazar exige notas; aprobar no. Es la misma asimetría que la
 * revisión de vacaciones (RN-11.10): un rechazo sin motivo obliga a la persona a
 * ir a preguntar por qué, y una aprobación no necesita explicarse.
 */
export const reviewIncidentInputSchema = z
	.object({
		approved: z.boolean(),
		notes: z.string().trim().max(1000).optional(),
	})
	.refine((input) => input.approved || !!input.notes, {
		message: "Un rechazo necesita notas que expliquen el motivo.",
		path: ["notes"],
	});

export const incidentSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	/** Resueltos para la bandeja, que busca por persona, correo y departamento (§6). */
	userFullName: z.string(),
	userEmail: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	incidentType: incidentTypeSchema,
	date: isoDateSchema,
	reason: z.string(),
	status: incidentStatusSchema,
	managerNotes: z.string().nullable(),
	/** RN-12.2: el marcaje bloqueado que la originó, si se enlazó uno. */
	attendanceMarkId: z.uuid().nullable(),
	reviewedBy: z.uuid().nullable(),
	reviewedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * `GET /incidents?status=&scope=&departmentId=&incidentType=&search=`.
 *
 * `scope` decide **de quién** son las incidencias, igual que en vacaciones: sin
 * `scope=managed` el endpoint siempre devuelve las propias, y no hay parámetro de
 * persona con el que pedir las de otro. La §7 escribía el filtro de texto como
 * `q=`; aquí se llama `search` para que sea el mismo nombre que en
 * `GET /users` — dos nombres para el mismo filtro es una de esas diferencias que
 * sólo se descubren depurando.
 */
export const listIncidentsQuerySchema = z.object({
	status: incidentStatusSchema.optional(),
	scope: z.enum(["own", "managed"]).default("own"),
	departmentId: z.uuid().optional(),
	incidentType: incidentTypeSchema.optional(),
	/** Busca por nombre, correo o departamento de quien reporta. */
	search: z.string().trim().max(120).optional(),
});

/**
 * `GET /incidents/pending-count?scope=` — el badge de la navegación (RN-05.8).
 *
 * La §7 lo pedía sólo para el `department_head`, pero la §6 pide además un
 * "contador de pendientes" al empleado sobre las suyas. Es el mismo conteo con
 * otro ámbito, así que es el mismo endpoint con el mismo `scope=` que la lista, y
 * no dos rutas que cuentan filas de la misma tabla.
 */
export const pendingIncidentsCountQuerySchema = z.object({
	scope: z.enum(["own", "managed"]).default("own"),
});

export const pendingIncidentsCountSchema = z.object({
	count: z.number().int().nonnegative(),
});

/**
 * `GET /incidents/blocked-marks?date=` — los **intentos rechazados propios** de
 * un día.
 *
 * No está en la §7 y se añade por la cabecera de la spec, que es donde está la
 * idea central: *"una incidencia del tipo «intenté marcar y no me dejó» se podrá
 * abrir con la fila delante en vez de con un relato"*. Para eso el formulario
 * tiene que poder enseñar esas filas, y hoy ningún endpoint las devuelve —el
 * historial de la spec 09 sólo cuenta los marcajes válidos.
 *
 * Vive aquí y no en el contrato de asistencia porque es una necesidad de esta
 * spec: quien la lee entiende por qué existe. Y como todo lo de `scope=own`, no
 * admite un identificador de persona.
 */
export const ownBlockedMarksQuerySchema = z.object({ date: isoDateSchema });

/**
 * `GET /incidents/:id/context` — el contexto que la §6 pide junto a cada
 * incidencia de la bandeja: los marcajes de ese día y el estado calculado del
 * día.
 *
 * Va en un endpoint aparte y no dentro de cada fila de la lista a propósito: son
 * dos consultas por incidencia (calendario y marcas), y cargarlas para toda la
 * bandeja cuando el revisor va a abrir una es trabajo que nadie mira. Se pide al
 * abrir la revisión.
 *
 * **No trae la justificación de ausencia** que la §6 menciona como tercer dato:
 * es de la spec 13 y todavía no existe. Un campo que hoy sólo puede valer nulo
 * invita a escribir la rama que lo maneja —el mismo criterio por el que
 * `NOT_AUTHENTICATED` no está en los motivos de rechazo del marcaje.
 */
export const incidentContextSchema = z.object({
	incidentId: z.uuid(),
	/** El día ya clasificado por la agregación diaria (spec 15), con sus marcas. */
	day: attendanceDaySchema,
	/**
	 * Los **intentos rechazados** de ese día (spec 09 RN-09.8), que `day.marks`
	 * no incluye porque el historial sólo cuenta los válidos. Es la materia prima
	 * de esta spec: una incidencia de "intenté marcar y no me dejó" se revisa con
	 * la fila delante en vez de con un relato.
	 */
	blockedMarks: z.array(attendanceMarkSchema),
});

export type IncidentType = z.infer<typeof incidentTypeSchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type AttendanceIncident = z.infer<typeof incidentSchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentInputSchema>;
export type ReviewIncidentInput = z.infer<typeof reviewIncidentInputSchema>;
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
export type PendingIncidentsCountQuery = z.infer<
	typeof pendingIncidentsCountQuerySchema
>;
export type PendingIncidentsCount = z.infer<typeof pendingIncidentsCountSchema>;
export type IncidentContext = z.infer<typeof incidentContextSchema>;
export type OwnBlockedMarksQuery = z.infer<typeof ownBlockedMarksQuerySchema>;
