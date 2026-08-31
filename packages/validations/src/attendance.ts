import { z } from "zod";
import { latitudeSchema, longitudeSchema } from "./geo.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Vocabulario del marcaje que ya necesita la spec 07.
 *
 * La spec 09 es la dueña de este dominio y aún no está construida; aquí sólo
 * viven las piezas que la **parte horaria** de la validación (spec 07 §4) produce
 * de verdad hoy. Igual que con el catálogo de bitácora y el de notificaciones, el
 * vocabulario es cerrado y crece spec a spec: enumerar de golpe los catorce
 * motivos de la spec 09 §6 dejaría en el enum ocho valores que ninguna línea de
 * código puede devolver, y la UI no tendría forma de saber cuáles son reales.
 */

/** Entrada o salida. El sentido de la marca lo declara el cliente, no la hora. */
export const markTypeSchema = z.enum(["IN", "OUT"]);

/**
 * Motivos de rechazo **tipados**, no cadenas libres: la interfaz reacciona
 * distinto a cada uno (spec 09 §6). El texto para la persona sale de
 * `MARK_REJECTION_MESSAGES`, que está aquí para que servidor y cliente digan lo
 * mismo.
 *
 * `NOT_AUTHENTICATED` de la §6 **no está** a propósito: sin sesión no se llega al
 * handler, el middleware responde 401 y el frontend ya sabe tratarlo (spec 04 §5).
 * Un motivo tipado que ninguna línea de código puede devolver sólo sirve para que
 * alguien escriba una rama muerta que lo maneje.
 */
export const markRejectionReasonSchema = z.enum([
	/** RN-09.1: el perfil está desactivado en este sistema (RN-00.30). */
	"INACTIVE_ACCOUNT",
	/** RN-09.2: vacaciones aprobadas y vigentes cubren la fecha (spec 11 RN-11.9). */
	"ON_VACATION",
	/** RN-03.4 / RN-07.12: el gestor global no marca. */
	"ROLE_CANNOT_MARK",
	/** RN-01.4 / RN-07.9: departamento en pausa. */
	"DEPARTMENT_PAUSED",
	/** RN-09.4: el departamento no tiene horario configurado. */
	"NO_SCHEDULE",
	/** RN-07.6: la fecha está marcada como no laborable en el calendario. */
	"NOT_WORKDAY",
	/** RN-10.4: día de descanso de esa persona. */
	"REST_DAY",
	/** RN-07.3 / RN-07.4: la hora local cae fuera de la ventana del tipo de marca. */
	"OUTSIDE_TIME_WINDOW",
	/**
	 * RN-08.5 / RN-08.6 / RN-09.6: no hay sede seleccionada, la seleccionada ya no
	 * está activa, o la que manda el cliente no es la del perfil.
	 */
	"INVALID_LOCATION",
	/** RN-08.1: la lectura cae fuera de la geocerca de esa sede. */
	"OUTSIDE_GEOFENCE",
	/** RN-08.3: la precisión del GPS es peor que el umbral y la sede bloquea. */
	"POOR_GPS_ACCURACY",
	/**
	 * RN-09.10: repetición del mismo marcaje en menos de 30 s (doble toque,
	 * reintento de red). **No es un fallo**: se devuelve la marca que ya existía.
	 */
	"DUPLICATE_MARK",
	/** RN-09.9: dos entradas seguidas sin salida, o una salida sin entrada. */
	"INVALID_SEQUENCE",
]);

/**
 * Texto por defecto de cada motivo. El servidor manda además un mensaje concreto
 * con las horas o el motivo de la pausa —"Puedes entrar entre 07:45 y 08:15; son
 * las 09:12"—, porque un rechazo que no dice qué hacer obliga a preguntar a
 * alguien. Éstos son el respaldo cuando no hay detalle que añadir.
 */
export const MARK_REJECTION_MESSAGES: Record<MarkRejectionReason, string> = {
	INACTIVE_ACCOUNT: "Tu cuenta está desactivada en Control de Asistencia.",
	ON_VACATION: "Estás de vacaciones aprobadas en esa fecha.",
	ROLE_CANNOT_MARK: "Tu rol no registra asistencia.",
	DEPARTMENT_PAUSED: "Tu departamento está en pausa.",
	NO_SCHEDULE: "Tu departamento todavía no tiene horario configurado.",
	NOT_WORKDAY: "Ese día no es laborable para tu departamento.",
	REST_DAY: "Ese día es tu descanso.",
	OUTSIDE_TIME_WINDOW: "No estás en la ventana horaria para marcar.",
	INVALID_LOCATION: "La sede contra la que intentas marcar no es válida.",
	OUTSIDE_GEOFENCE: "Estás fuera del área de tu sede.",
	POOR_GPS_ACCURACY:
		"La ubicación de tu dispositivo no es lo bastante precisa.",
	DUPLICATE_MARK: "Ese marcaje ya estaba registrado.",
	INVALID_SEQUENCE: "Ese marcaje no encaja con el anterior.",
};

// ── El marcaje ────────────────────────────────────────────────────────────────

/**
 * RN-09.14 — De dónde sale la marca.
 *
 * Se añade ya, con todo escribiéndose `manual`, porque un `OUT` que puso el sistema
 * **no es el mismo hecho** que uno que puso una persona: sin el campo, cuando exista
 * el cierre automático (RN-09.13) o la importación histórica (spec 19), nadie podrá
 * distinguirlos hacia atrás en los datos que ya estén escritos.
 */
export const markSourceSchema = z.enum([
	"manual",
	"auto_schedule",
	"auto_geofence",
	"import",
]);

export const attendanceMarkSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	markType: markTypeSchema,
	/** Instante del marcaje **según el servidor**, no según el cliente (RN-09.11). */
	markedAt: z.iso.datetime(),
	/**
	 * Día laboral al que pertenece, resuelto en la zona del departamento (spec 07
	 * RN-07.5): en una jornada nocturna la salida de la madrugada cuenta para el día
	 * anterior. Se **guarda** en vez de recalcularse porque el horario cambia y los
	 * cambios no son retroactivos (RN-06.4): dentro de un año, este dato sigue
	 * diciendo a qué jornada perteneció.
	 *
	 * Nulo sólo en un intento rechazado antes de poder resolverlo (sin horario).
	 */
	workDate: isoDateSchema.nullable(),
	latitude: latitudeSchema,
	longitude: longitudeSchema,
	accuracy: z.number(),
	/** Recalculados en el servidor (RN-08.2). Nulos si no había sede que juzgar. */
	distanceToCenter: z.number().nullable(),
	insideGeofence: z.boolean().nullable(),
	workLocationId: z.uuid().nullable(),
	/** Resuelto para la interfaz: las marcas del día se listan "con hora y sede". */
	workLocationName: z.string().nullable(),
	/** Foto del departamento al marcar, para la reportería (spec 09 §2). */
	departmentId: z.uuid().nullable(),
	/** RN-09.8: `true` en un intento rechazado que quedó registrado. */
	blocked: z.boolean(),
	blockReason: markRejectionReasonSchema.nullable(),
	/** RN-09.7. Se guardan los dos: la tolerancia de entonces no se puede rehacer. */
	isLate: z.boolean(),
	lateMinutes: z.number().int().nonnegative(),
	source: markSourceSchema,
	createdAt: z.iso.datetime(),
});

/**
 * `POST /attendance/marks` (spec 09 §6).
 *
 * **No lleva hora**: el instante lo pone el servidor (RN-09.11). Un cliente con el
 * reloj adelantado dos horas no puede marcar fuera de ventana porque su reloj no
 * entra en la ecuación.
 *
 * `workLocationId` admite nulo a propósito: si la persona no tiene sede elegida, el
 * marcaje debe devolver `INVALID_LOCATION` con su mensaje y **quedar registrado**
 * como intento (decisión 2 de la §8), no morir en un 400 genérico de validación.
 */
export const createAttendanceMarkInputSchema = z.object({
	markType: markTypeSchema,
	latitude: latitudeSchema,
	longitude: longitudeSchema,
	accuracy: z
		.number()
		.min(0, "La precisión no puede ser negativa")
		.max(100_000, "Esa precisión no es una lectura real"),
	workLocationId: z.uuid("El identificador de sede no es válido.").nullable(),
});

/**
 * Resultado de intentar marcar.
 *
 * **Un rechazo responde 200, no un 4xx.** No es un fallo de la petición: es un hecho
 * del negocio que además queda registrado (`blocked = true`). Devolverlo como error
 * obligaría a la interfaz a leer el motivo tipado del cuerpo de una excepción, y a
 * `apiJson` a dejar de servir. El 4xx se reserva para lo que sí es un fallo: sin
 * sesión (401) o un cuerpo que no valida (400).
 */
export const attendanceMarkResultSchema = z.object({
	/** `true` si ahora existe un marcaje válido para ese momento. */
	accepted: z.boolean(),
	/** `true` si era una repetición y se devuelve la marca que ya existía (RN-09.10). */
	duplicate: z.boolean(),
	reason: markRejectionReasonSchema.nullable(),
	/** Mensaje accionable: qué pasó y qué hacer (spec 09 §5). */
	message: z.string(),
	/**
	 * La marca resultante: la creada, la que ya existía si fue repetición, o la fila
	 * del intento rechazado. Nula sólo si no se pudo escribir nada.
	 */
	mark: attendanceMarkSchema.nullable(),
});

/**
 * `GET /attendance/status` (spec 09 §6): qué se puede hacer **ahora**, sin intentar
 * marcar y fallar.
 *
 * No incluye el veredicto de la geocerca porque eso necesita una lectura del
 * dispositivo, y un `GET` con coordenadas en la URL acaba en los registros del
 * servidor. La parte de ubicación la resuelve `POST /me/location-check` (spec 08),
 * que ya existe: la pantalla de marcaje compone las dos.
 */
export const attendanceStatusSchema = z.object({
	/** Día laboral en curso según el horario. Nulo si no hay horario. */
	workDate: isoDateSchema.nullable(),
	/** Qué toca marcar ahora según la secuencia (RN-09.9). Nulo si no toca nada. */
	nextMarkType: markTypeSchema.nullable(),
	canCheckIn: z.boolean(),
	canCheckOut: z.boolean(),
	/** Motivo por el que ninguna de las dos se puede hacer, si es el caso. */
	reason: markRejectionReasonSchema.nullable(),
	message: z.string(),
	/** Hora de la entrada abierta, si hay una jornada sin cerrar. */
	openSince: z.iso.datetime().nullable(),
	/** Las marcas del día laboral en curso, en orden. */
	marks: z.array(attendanceMarkSchema),
	/** `false` para quien no marca por rol (RN-03.4). */
	canMark: z.boolean(),
});

// ── Historial propio ──────────────────────────────────────────────────────────

/**
 * Estado de un día para una persona.
 *
 * El vocabulario y su **precedencia** son de la spec 15 §2 (RN-15.1), que es su
 * dueña: `NO_LABORABLE` → `VACACIONES` → `DESCANSO` → `PRESENTE`/`TARDE` →
 * `AUSENTE`. Aquí están los cinco que se pueden resolver hoy; `VACACIONES` llega
 * con la spec 11 y `AJ`/`ANJ` con la 13, y son **superposiciones**, no estados
 * nuevos en la lista.
 */
export const attendanceDayStatusSchema = z.enum([
	"PRESENTE",
	"TARDE",
	"AUSENTE",
	"DESCANSO",
	"NO_LABORABLE",
]);

export const attendanceDaySchema = z.object({
	date: isoDateSchema,
	status: attendanceDayStatusSchema,
	/** Primer `IN` del día laboral (spec 15 §3). */
	firstIn: z.iso.datetime().nullable(),
	/** Último `OUT`. */
	lastOut: z.iso.datetime().nullable(),
	/**
	 * RN-15.3 — Jornada sin salida: `null`, y el día queda `incomplete`. **No se
	 * inventa una salida**, y tiene que verse.
	 */
	workedMinutes: z.number().int().nullable(),
	incomplete: z.boolean(),
	/**
	 * `true` si la jornada todavía puede completarse (hoy o futuro): `AUSENTE` es
	 * provisional y la interfaz no debe pintar en rojo a alguien a media mañana. El
	 * vocabulario de estados de la spec 15 no tiene "pendiente", así que va aparte.
	 */
	pending: z.boolean(),
	isLate: z.boolean(),
	lateMinutes: z.number().int().nonnegative(),
	marks: z.array(attendanceMarkSchema),
});

/** `?from=&to=`, ambos inclusive, como en el calendario laboral (spec 07). */
export const attendanceRangeQuerySchema = z
	.object({ from: isoDateSchema, to: isoDateSchema })
	.refine(({ from, to }) => from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	})
	.refine(
		({ from, to }) =>
			(Date.parse(`${to}T00:00:00.000Z`) -
				Date.parse(`${from}T00:00:00.000Z`)) /
				86_400_000 <=
			366,
		{ message: "El rango no puede pasar de un año." },
	);

export type MarkType = z.infer<typeof markTypeSchema>;
export type MarkRejectionReason = z.infer<typeof markRejectionReasonSchema>;
export type MarkSource = z.infer<typeof markSourceSchema>;
export type AttendanceMark = z.infer<typeof attendanceMarkSchema>;
export type CreateAttendanceMarkInput = z.infer<
	typeof createAttendanceMarkInputSchema
>;
export type AttendanceMarkResult = z.infer<typeof attendanceMarkResultSchema>;
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;
export type AttendanceDayStatus = z.infer<typeof attendanceDayStatusSchema>;
export type AttendanceDay = z.infer<typeof attendanceDaySchema>;
export type AttendanceRangeQuery = z.infer<typeof attendanceRangeQuerySchema>;
