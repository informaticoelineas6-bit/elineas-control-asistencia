import { format, parseISO } from "date-fns";
import { es } from "date-fns/locale";

/**
 * Fechas de la interfaz, con date-fns y una sola configuración regional.
 *
 * La empresa opera en Cuba (spec 06 §8): la semana empieza el **lunes** y los
 * nombres de meses y días salen en español. Tener esto en un módulo evita que cada
 * pantalla elija su propio formato — que es como acaban conviviendo "19/08/2026",
 * "19 ago" y "August 19" en la misma tabla.
 *
 * Las fechas del dominio viajan como `yyyy-MM-dd` (spec 07 §2): son días del
 * calendario de pared, no instantes. `parseISO` sobre esa cadena da la medianoche
 * **local**, que es exactamente lo que hay que comparar y pintar; convertirlas a
 * UTC es lo que hace que un feriado se muestre un día antes.
 */

export const ES_LOCALE = es;

/** Cuba: la semana de un calendario impreso empieza el lunes. */
export const WEEK_STARTS_ON = 1 as const;

export function toISODate(date: Date): string {
	return format(date, "yyyy-MM-dd");
}

export function fromISODate(value: string): Date {
	return parseISO(value);
}

const asDate = (value: Date | string) =>
	typeof value === "string" ? fromISODate(value) : value;

/** "Agosto 2026" — con mayúscula inicial, que en español no la lleva de serie. */
export function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "19 de agosto de 2026". */
export function formatLongDate(value: Date | string): string {
	return format(asDate(value), "d 'de' MMMM 'de' yyyy", { locale: es });
}

/** "miércoles, 19 de agosto". Para el día de hoy, donde el año sobra. */
export function formatWeekdayDate(value: Date | string): string {
	return capitalize(format(asDate(value), "EEEE, d 'de' MMMM", { locale: es }));
}

/** "19 ago 2026". Para tablas y listas, donde el ancho importa. */
export function formatShortDate(value: Date | string): string {
	return format(asDate(value), "d MMM yyyy", { locale: es });
}

/** "Agosto 2026", el encabezado de un mes del calendario. */
export function formatMonthCaption(value: Date | string): string {
	return capitalize(format(asDate(value), "LLLL yyyy", { locale: es }));
}
