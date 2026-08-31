import { z } from "zod";

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
 */
export const markRejectionReasonSchema = z.enum([
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
]);

/**
 * Texto por defecto de cada motivo. El servidor manda además un mensaje concreto
 * con las horas o el motivo de la pausa —"Puedes entrar entre 07:45 y 08:15; son
 * las 09:12"—, porque un rechazo que no dice qué hacer obliga a preguntar a
 * alguien. Éstos son el respaldo cuando no hay detalle que añadir.
 */
export const MARK_REJECTION_MESSAGES: Record<MarkRejectionReason, string> = {
	ROLE_CANNOT_MARK: "Tu rol no registra asistencia.",
	DEPARTMENT_PAUSED: "Tu departamento está en pausa.",
	NO_SCHEDULE: "Tu departamento todavía no tiene horario configurado.",
	NOT_WORKDAY: "Ese día no es laborable para tu departamento.",
	REST_DAY: "Ese día es tu descanso.",
	OUTSIDE_TIME_WINDOW: "No estás en la ventana horaria para marcar.",
};

export type MarkType = z.infer<typeof markTypeSchema>;
export type MarkRejectionReason = z.infer<typeof markRejectionReasonSchema>;
