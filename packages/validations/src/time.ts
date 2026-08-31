import { z } from "zod";

/**
 * Primitivas de fecha y hora compartidas.
 *
 * Estaban declaradas dentro de la spec 06 (`config.ts`) y la 07 las volvió a
 * necesitar para el horario de un departamento. Dos definiciones del mismo
 * formato acaban divergiendo en el mensaje de error, que es justo lo que lee la
 * persona que se equivoca al teclear.
 *
 * El cálculo con estas horas es **aritmética de minutos de reloj**, no de
 * instantes: "¿son más de las 08:15 en la zona del departamento?" es una
 * comparación de hora local, y resolverla con `Date` obliga a inventar un día.
 * La conversión instante → hora local sí necesita zona horaria y librería de
 * fechas (date-fns), y vive en el backend
 * (`apps/backend/src/services/schedule-rules.ts`) con la zona **explícita en
 * cada conversión** (RN-07.2).
 */

/** `HH:mm` en 24 horas. */
export const timeOfDaySchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "La hora debe tener el formato HH:mm");

/**
 * Fecha civil sin hora, `yyyy-MM-dd` — el tipo `date` de la base y la clave del
 * calendario laboral (spec 07 §2).
 *
 * Va sin hora ni zona a propósito: un día del calendario laboral es un día del
 * calendario de pared, no un instante. Guardarlo como `timestamptz` es lo que
 * hace que un feriado se corra de día al cambiar de zona.
 */
export const isoDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")
	.refine(
		(value) => {
			// El formato por sí solo no basta: el motor **rueda** los días que no
			// existen y `2026-02-31` se convierte en marzo sin avisar. La ida y vuelta
			// es lo que lo detecta.
			const parsed = new Date(`${value}T00:00:00.000Z`);
			return (
				!Number.isNaN(parsed.getTime()) &&
				parsed.toISOString().slice(0, 10) === value
			);
		},
		{ message: "Esa fecha no existe en el calendario" },
	);

/**
 * Zona horaria IANA. Se valida preguntándole al propio motor en vez de contra una
 * lista escrita a mano: la lista envejece y un identificador válido rechazado es
 * más difícil de diagnosticar que uno inválido aceptado.
 */
export const timezoneSchema = z.string().refine(
	(value) => {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	},
	{
		message: "No es una zona horaria IANA válida (por ejemplo: America/Havana)",
	},
);

export const MINUTES_PER_DAY = 24 * 60;

/** Minutos transcurridos desde la medianoche para una hora `HH:mm`. */
export function minutesOfDay(time: string): number {
	const [hours = "0", minutes = "0"] = time.split(":");
	return Number(hours) * 60 + Number(minutes);
}

/**
 * Inversa de `minutesOfDay`, tolerando valores que se pasan de un día: 1500 son
 * las 01:00 **del día siguiente**. Devuelve sólo la hora; cuántos días se pasa lo
 * dice `dayOffset`.
 */
export function formatMinutes(minutes: number): string {
	const inDay =
		((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
	const hours = Math.floor(inDay / 60);
	return `${String(hours).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`;
}

/** Días completos que se pasa un valor absoluto de minutos (0 = el mismo día). */
export function dayOffset(minutes: number): number {
	return Math.floor(minutes / MINUTES_PER_DAY);
}

/**
 * Hora con la coletilla del día al que pertenece, para los textos de la interfaz:
 * `06:00 del día siguiente`. Sin esto, un horario nocturno se lee como si la
 * salida fuese antes de la entrada.
 */
export function describeMinutes(minutes: number): string {
	const offset = dayOffset(minutes);
	const time = formatMinutes(minutes);
	if (offset === 0) return time;
	if (offset === 1) return `${time} del día siguiente`;
	return `${time} ${offset} días después`;
}
