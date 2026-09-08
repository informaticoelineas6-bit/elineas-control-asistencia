import type { AttendanceDayStatus } from "@elineas/validations";
import type { CalendarTone } from "#/components/ui/calendar.tsx";

/**
 * Cómo se presenta un día de asistencia: su etiqueta, su color y sus formatos.
 *
 * **Estaba dentro de `history.tsx` y salió aquí al llegar la vista de la semana**
 * (spec 05 §3), que es el mismo dato en otra forma. Dos tablas de etiquetas para
 * los mismos seis estados acabarían diciendo cosas distintas del mismo día —y en
 * dos pantallas que la misma persona abre— así que se comparten.
 *
 * Aquí no hay ningún cálculo de estado: el estado llega **ya resuelto** desde el
 * servidor (spec 15 §4). Esto sólo lo traduce a español y a un color.
 */

export const STATUS_LABEL: Record<AttendanceDayStatus, string> = {
	PRESENTE: "Presente",
	TARDE: "Tarde",
	AUSENTE: "Ausente",
	DESCANSO: "Descanso",
	NO_LABORABLE: "No laborable",
	// Spec 11 RN-11.12: superposición sobre lo que le hubiera tocado al día.
	VACACIONES: "Vacaciones",
};

export const STATUS_TONE: Record<AttendanceDayStatus, CalendarTone> = {
	PRESENTE: "positive",
	TARDE: "warning",
	AUSENTE: "danger",
	DESCANSO: "info",
	NO_LABORABLE: "neutral",
	// Mismo tono que DESCANSO a propósito: sólo hay cinco tonos en el calendario
	// (`CalendarTone`) y las dos son "día libre planeado, no un problema". La
	// etiqueta es la que distingue una cosa de la otra.
	VACACIONES: "info",
};

export const STATUS_BADGE: Record<
	AttendanceDayStatus,
	"default" | "secondary" | "warning" | "destructive" | "outline"
> = {
	PRESENTE: "secondary",
	TARDE: "warning",
	AUSENTE: "destructive",
	DESCANSO: "outline",
	NO_LABORABLE: "outline",
	VACACIONES: "secondary",
};

/**
 * Spec 13. Los códigos del reporte se enseñan **desarrollados**: `AJ` y `ANJ`
 * son el vocabulario de la reportería (spec 16), no el de quien lee su propio
 * historial en el móvil.
 */
export const ABSENCE_LABEL: Record<"AJ" | "ANJ", string> = {
	AJ: "Justificada",
	ANJ: "No justificada",
};

export const time = (value: string | null) =>
	value
		? new Date(value).toLocaleTimeString("es-CU", {
				hour: "2-digit",
				minute: "2-digit",
			})
		: "—";

/** "8 h 15 min", que es como se lee una jornada. */
export function formatWorked(minutes: number | null): string {
	if (minutes === null) return "—";
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest} min`;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
