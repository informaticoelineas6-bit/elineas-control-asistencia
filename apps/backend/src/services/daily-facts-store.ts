import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "#/db";
import { attendanceDailyFacts } from "#/db/schema";
import {
	type DailyFactsProfile,
	dayKey,
	loadDailyFacts,
	peopleInScope,
} from "#/services/daily-facts.ts";
import { currentRuleVersion } from "#/services/rule-versions.ts";

/**
 * Materialización de los hechos diarios (spec 16 §4).
 *
 * **RN-16.10 — el snapshot es caché, no verdad.** Aquí no hay ninguna operación
 * que *edite* un hecho: sólo se recalculan desde los datos crudos y se
 * sobrescriben enteros, con `loadDailyFacts`, que es la misma función que
 * alimenta los paneles y el historial. Que no exista un camino para modificar
 * un hecho a mano es lo que hace cierta la regla, más que cualquier prueba — y
 * hay una prueba igualmente: recalcular un mes cerrado no cambia ningún valor.
 *
 * **RN-16.9 — dos vías de refresco.** Una programada, que recalcula el día
 * anterior (`refreshYesterday`, la engancha `index.ts` y no `app.ts`, para que
 * las pruebas no arranquen temporizadores), y otra por rango invocable a mano,
 * que es la que se usa cuando se corrige una justificación o se importa
 * histórico.
 *
 * **RN-16.11 — invalidación.** La regla nombra cuatro hechos que dejan días
 * obsoletos. Dos se enganchan en su sitio y con su rango exacto: justificar una
 * ausencia (`services/absences.ts`) y aprobar vacaciones
 * (`services/vacations.ts`). Los otros dos no:
 *
 * - **Cambiar los días de un grupo de descanso alcanza al pasado de sus
 *   miembros** (spec 10 §9, decisión 5), y ese pasado no tiene principio: no hay
 *   un rango que refrescar. La herramienta para eso es precisamente el recálculo
 *   manual por rango, que existe por esto.
 * - **La importación de histórico** es de la spec 21 y todavía no existe; cuando
 *   exista, refrescar su propio rango es una línea.
 */

/** Lo que se guarda de un día. */
type FactRow = typeof attendanceDailyFacts.$inferInsert;

/**
 * Recalcula y reescribe los hechos de estas personas en este rango.
 *
 * Un solo `insert … on conflict do update` para todo el lote: escribir fila a
 * fila sería el N+1 del que avisa la spec 15 §4, movido de la lectura a la
 * escritura.
 */
export async function refreshDailyFacts(
	people: readonly (DailyFactsProfile & { departmentId: string | null })[],
	range: { from: string; to: string },
): Promise<{ facts: number; ruleVersion: number; ruleVersionId: string }> {
	const version = await currentRuleVersion();
	if (people.length === 0) {
		return {
			facts: 0,
			ruleVersion: version.version,
			ruleVersionId: version.id,
		};
	}

	const computed = await loadDailyFacts(people, range);

	const rows: FactRow[] = [];
	for (const person of people) {
		for (const [key, fact] of computed) {
			if (!key.startsWith(`${person.id}|`)) continue;
			rows.push({
				userId: person.id,
				date: fact.date,
				departmentId: person.departmentId,
				status: fact.status,
				absenceCode: fact.absence?.code ?? null,
				inTimestamp: fact.firstIn,
				outTimestamp: fact.lastOut,
				lateMinutes: fact.lateMinutes,
				workedMinutes: fact.workedMinutes,
				ruleVersionId: version.id,
			});
		}
	}

	if (rows.length === 0) {
		return {
			facts: 0,
			ruleVersion: version.version,
			ruleVersionId: version.id,
		};
	}

	// En trozos: un `insert` con decenas de miles de filas supera el límite de
	// parámetros del protocolo de PostgreSQL.
	const CHUNK = 500;
	for (let index = 0; index < rows.length; index += CHUNK) {
		await db
			.insert(attendanceDailyFacts)
			.values(rows.slice(index, index + CHUNK))
			// El hecho se sobrescribe **entero** con lo recalculado (RN-16.10): no hay
			// ninguna columna que se conserve de la versión anterior.
			.onConflictDoUpdate({
				target: [attendanceDailyFacts.userId, attendanceDailyFacts.date],
				set: {
					departmentId: sql`excluded.department_id`,
					status: sql`excluded.status`,
					absenceCode: sql`excluded.absence_code`,
					inTimestamp: sql`excluded.in_timestamp`,
					outTimestamp: sql`excluded.out_timestamp`,
					lateMinutes: sql`excluded.late_minutes`,
					workedMinutes: sql`excluded.worked_minutes`,
					ruleVersionId: sql`excluded.rule_version_id`,
					computedAt: new Date(),
				},
			});
	}

	return {
		facts: rows.length,
		ruleVersion: version.version,
		ruleVersionId: version.id,
	};
}

/** RN-16.9 — Refresco por rango de todo un ámbito. */
export async function refreshFactsForScope(
	scope: { managedDepartmentIds: string[] | "all" },
	range: { from: string; to: string },
	departmentId?: string,
) {
	const people = await peopleInScope(scope, departmentId);
	return refreshDailyFacts(people, range);
}

/** RN-16.11 — Un día concreto de una persona, tras una decisión que lo cambia. */
export async function refreshFactsForUser(
	profile: DailyFactsProfile,
	range: { from: string; to: string },
) {
	return refreshDailyFacts([profile], range);
}

/**
 * RN-16.9 — El proceso programado: recalcula **el día anterior** de toda la
 * plantilla. Lo arranca `index.ts`, no `app.ts`.
 */
export async function refreshYesterday() {
	const yesterday = new Date(Date.now() - 86_400_000)
		.toISOString()
		.slice(0, 10);
	return refreshFactsForScope(
		{ managedDepartmentIds: "all" },
		{
			from: yesterday,
			to: yesterday,
		},
	);
}

/** Los hechos ya materializados de un rango, para el reporte. */
export async function readFacts(
	userIds: readonly string[],
	range: { from: string; to: string },
) {
	const ids = [...new Set(userIds)];
	if (ids.length === 0)
		return new Map<string, typeof attendanceDailyFacts.$inferSelect>();

	const rows = await db
		.select()
		.from(attendanceDailyFacts)
		.where(
			and(
				inArray(attendanceDailyFacts.userId, ids),
				gte(attendanceDailyFacts.date, range.from),
				lte(attendanceDailyFacts.date, range.to),
			),
		);

	return new Map(rows.map((row) => [dayKey(row.userId, row.date), row]));
}

/** Sólo para pruebas: cuántos hechos hay de una persona. */
export async function countFactsOf(userId: string): Promise<number> {
	return (
		await db
			.select({ date: attendanceDailyFacts.date })
			.from(attendanceDailyFacts)
			.where(eq(attendanceDailyFacts.userId, userId))
	).length;
}
