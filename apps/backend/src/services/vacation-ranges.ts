import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { vacationRequests } from "#/db/schema";

/**
 * Los rangos de vacaciones **aprobadas**, leídos en crudo.
 *
 * Es una parte de la spec 11 que vive fuera de su servicio por una razón de
 * estructura, no de dominio: la agregación diaria (`daily-facts.ts`) los
 * necesita para clasificar un día, y el servicio de vacaciones necesita a su vez
 * la agregación —para refrescar los hechos de un periodo recién aprobado
 * (RN-16.11)—. Con la lectura dentro de `vacations.ts` los dos se importarían en
 * círculo.
 *
 * Aquí sólo hay lectura de una tabla. Toda la decisión de vacaciones —quién
 * puede pedir, cuánto consume, quién aprueba— sigue en `services/vacations.ts`.
 */

export type VacationRange = { startDate: string; endDate: string };

/**
 * Los rangos aprobados de **varias personas de un tirón**: una consulta para
 * toda la plantilla de un departamento en vez de una por persona, igual que
 * `loadRestContexts` en la spec 10.
 */
export async function loadApprovedVacationRanges(
	userIds: readonly string[],
): Promise<Map<string, VacationRange[]>> {
	const ranges = new Map<string, VacationRange[]>();
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return ranges;

	const rows = await db
		.select({
			userId: vacationRequests.userId,
			startDate: vacationRequests.startDate,
			endDate: vacationRequests.endDate,
		})
		.from(vacationRequests)
		.where(
			and(
				inArray(vacationRequests.userId, ids),
				eq(vacationRequests.status, "approved"),
			),
		);

	for (const row of rows) {
		const list = ranges.get(row.userId) ?? [];
		list.push({ startDate: row.startDate, endDate: row.endDate });
		ranges.set(row.userId, list);
	}
	return ranges;
}

/**
 * El predicado de RN-09.2 / RN-15.1 a partir de unos rangos ya cargados: sólo
 * las solicitudes **aprobadas** cubren fechas.
 */
export function vacationDayPredicate(
	ranges: readonly VacationRange[],
): (date: string) => boolean {
	return (date: string) =>
		ranges.some((range) => range.startDate <= date && date <= range.endDate);
}
