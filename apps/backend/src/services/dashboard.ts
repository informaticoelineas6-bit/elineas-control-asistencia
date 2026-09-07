import {
	type AppRole,
	type AttendanceDay,
	type DailyRosterEntry,
	type DashboardAlert,
	type DashboardSummary,
	type DashboardTrend,
	type DayCounts,
	EMPTY_DAY_COUNTS,
	roleAtLeast,
	roleCanMark,
	type ScopeSummary,
} from "@elineas/validations";
import { eachDayOfInterval, format, parseISO } from "date-fns";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { departments } from "#/db/schema";
import { countPendingAbsences } from "#/services/absences.ts";
import { getDaysFor, type MarkingProfile } from "#/services/attendance.ts";
import {
	dayKey,
	loadDailyFacts,
	peopleInScope,
	type ScopedProfile,
} from "#/services/daily-facts.ts";
import type { DailyFact } from "#/services/daily-status.ts";
import { countPausedDepartments } from "#/services/departments.ts";
import { countPendingIncidents } from "#/services/incidents.ts";
import { todayForDepartment } from "#/services/schedules.ts";
import {
	countPendingVacationRequests,
	getBalance,
} from "#/services/vacations.ts";

/**
 * Las tres vistas de la spec 15 §5: el dashboard de inicio, el panel de
 * departamento y el panel global.
 *
 * **Los dos paneles son uno.** La §5.3 lo dice —"hacen lo mismo con distinto
 * alcance… deben ser una vista parametrizada por ámbito, no dos páginas"— y aquí
 * ni siquiera hay un parámetro de ámbito: `peopleInScope` devuelve lo que
 * gestiona quien pregunta, que para un `global_manager` es la empresa entera. La
 * diferencia entre el panel de departamento y el global es **quién mira**, no
 * qué endpoint llama.
 *
 * Y nada de esto clasifica días por su cuenta: todo pasa por `loadDailyFacts`
 * (§4). Es la regla que la §1 subraya —una sola definición del estado diario,
 * compartida por dashboard, paneles, historial y reportería— y el error concreto
 * que el legacy cometió, con la lógica repartida entre un hook, una función SQL
 * y una edge function.
 */

export type Scope = { managedDepartmentIds: string[] | "all" };

/**
 * `true` si esa jornada sigue abierta **ahora**: hay entrada sin salida y el día
 * es hoy.
 *
 * Es la respuesta honesta a la decisión 4 de la §8 —"¿quién está dentro de la
 * sede ahora mismo?"—: una entrada sin salida de un día ya cerrado no es alguien
 * dentro, es una jornada incompleta (RN-15.3). Ver la nota de la decisión en la
 * spec: saber quién está *físicamente* en la sede exige geolocalización en
 * segundo plano, que sigue siendo una decisión abierta de la spec 20.
 */
const isOpenNow = (fact: DailyFact, today: string) =>
	fact.incomplete && fact.date === today;

function tally(
	facts: Iterable<DailyFact>,
	today: string,
): { counts: DayCounts; total: number; open: number } {
	const counts: DayCounts = { ...EMPTY_DAY_COUNTS };
	let total = 0;
	let open = 0;

	for (const fact of facts) {
		counts[fact.status] += 1;
		total += 1;
		if (isOpenNow(fact, today)) open += 1;
	}

	return { counts, total, open };
}

/**
 * El "hoy" del ámbito.
 *
 * ⚠️ **Un ámbito puede abarcar departamentos en zonas distintas** (RN-07.2), y
 * entonces "hoy" no es una sola fecha. Se resuelve en la zona del **primer
 * departamento del ámbito por orden alfabético**, o en la global si no hay
 * ninguno, y se usa esa fecha para todos. Es una simplificación consciente: la
 * alternativa —un panel donde cada fila es de un día distinto— es peor de leer
 * que un panel donde alguien de una zona lejana aparece con el día de ayer, y
 * hoy la empresa opera en un solo país (spec 06 §8). Cuando deje de ser así,
 * el sitio donde arreglarlo es éste.
 */
async function todayForScope(
	people: readonly ScopedProfile[],
): Promise<string> {
	return todayForDepartment(people.at(0)?.departmentId ?? null);
}

// ── §5.2 y §5.3, que son la misma ─────────────────────────────────────────────

/**
 * `GET /attendance/daily?date=&departmentId=`: el día del ámbito, persona a
 * persona.
 *
 * Dos consultas por rango más tres por departamento, venga de 5 personas o de
 * 200 — el criterio de aceptación de la §7 que exige que un panel de 200
 * empleados no dispare 200 consultas.
 */
export async function listDailyRoster(
	scope: Scope,
	query: { date?: string; departmentId?: string },
): Promise<DailyRosterEntry[]> {
	const people = await peopleInScope(scope, query.departmentId);
	if (people.length === 0) return [];

	const today = await todayForScope(people);
	const date = query.date ?? today;
	const facts = await loadDailyFacts(people, { from: date, to: date });

	return people.flatMap((person) => {
		const fact = facts.get(dayKey(person.id, date));
		if (!fact) return [];

		return [
			{
				userId: person.id,
				userFullName: person.fullName,
				userEmail: person.email,
				departmentId: person.departmentId,
				departmentName: person.departmentName,
				date: fact.date,
				status: fact.status,
				firstIn: fact.firstIn?.toISOString() ?? null,
				lastOut: fact.lastOut?.toISOString() ?? null,
				workedMinutes: fact.workedMinutes,
				incomplete: fact.incomplete,
				pending: fact.pending,
				isLate: fact.isLate,
				lateMinutes: fact.lateMinutes,
				absence: fact.absence,
				open: isOpenNow(fact, today),
			},
		];
	});
}

/**
 * `GET /attendance/daily-range?userId=&from=&to=`: el detalle de una persona del
 * ámbito, con sus marcas.
 *
 * Reutiliza `getDaysFor`, que es lo que ya alimenta el historial propio: el jefe
 * ve **exactamente** lo mismo que ve el empleado en su pantalla, y eso es lo que
 * evita las conversaciones que empiezan discutiendo qué dice cada sistema.
 */
export async function getDaysOfUser(
	profile: MarkingProfile,
	range: { from: string; to: string },
): Promise<AttendanceDay[]> {
	return getDaysFor(profile, range);
}

// ── §5.1 Dashboard ────────────────────────────────────────────────────────────

async function summarizeScope(
	date: string,
	people: readonly ScopedProfile[],
): Promise<ScopeSummary> {
	const facts = await loadDailyFacts(people, { from: date, to: date });

	const byPerson = people.flatMap((person) => {
		const fact = facts.get(dayKey(person.id, date));
		return fact ? [{ person, fact }] : [];
	});

	const overall = tally(
		byPerson.map((row) => row.fact),
		date,
	);

	// El desglose por departamento sale del **mismo** conteo, no de una segunda
	// pasada por la base: si los totales de arriba y los de la tabla vinieran de
	// dos consultas distintas, un día podrían no cuadrar y nadie sabría cuál
	// creer.
	const grouped = new Map<string, { facts: DailyFact[]; name: string }>();
	for (const { person, fact } of byPerson) {
		if (!person.departmentId) continue;
		const entry = grouped.get(person.departmentId) ?? {
			facts: [],
			name: person.departmentName ?? "—",
		};
		entry.facts.push(fact);
		grouped.set(person.departmentId, entry);
	}

	// Una consulta para saber cuáles están en pausa (RN-01.4): su gente aparece
	// ausente sin que sea culpa de nadie, y el panel tiene que decirlo antes de
	// que alguien lo lea como un problema de asistencia.
	const paused = new Set(
		grouped.size === 0
			? []
			: (
					await db
						.select({ id: departments.id })
						.from(departments)
						.where(
							and(
								inArray(departments.id, [...grouped.keys()]),
								eq(departments.isPaused, true),
							),
						)
				).map((row) => row.id),
	);

	return {
		total: overall.total,
		counts: overall.counts,
		open: overall.open,
		byDepartment: [...grouped.entries()]
			.map(([departmentId, entry]) => {
				const summary = tally(entry.facts, date);
				return {
					departmentId,
					departmentName: entry.name,
					isPaused: paused.has(departmentId),
					total: summary.total,
					counts: summary.counts,
				};
			})
			.sort((a, b) => a.departmentName.localeCompare(b.departmentName, "es")),
	};
}

/**
 * `GET /dashboard/summary` (§5.1). **Un solo endpoint para los tres roles**, con
 * el contenido decidido por el rol y no por un parámetro: la spec describe tres
 * filas de una tabla, no tres pantallas.
 *
 * - `me` es nulo para quien no marca (RN-03.4): enseñarle a un gestor global una
 *   tarjeta vacía de "tu estado de hoy" parecería un fallo de configuración.
 * - `scope` es nulo para quien no gestiona nada.
 */
export async function getDashboardSummary(input: {
	profile: MarkingProfile;
	role: AppRole;
	scope: Scope;
}): Promise<DashboardSummary> {
	// ⚠️ **El ámbito lo decide el rol, no la lista.** `managedDepartmentIds`
	// incluye el departamento **propio** de cualquiera (`getManagedDepartmentIds`),
	// así que mirar si está vacía diría que un `employee` gestiona su
	// departamento y le devolvería el resumen de sus compañeros. Es la misma
	// distinción que hace `hasScope` en el middleware: la lista dice *dónde*
	// alcanza el ámbito, el rol dice *si hay* ámbito (RN-03.2).
	const manages = roleAtLeast(input.role, "department_head");

	const people = manages ? await peopleInScope(input.scope) : [];
	const date = manages
		? await todayForScope(people)
		: await todayForDepartment(input.profile.departmentId);

	const me = roleCanMark(input.role)
		? {
				day:
					(await getDaysFor(input.profile, { from: date, to: date })).map(
						({ marks: _marks, ...day }) => day,
					)[0] ?? null,
				vacationBalance: await getBalance(input.profile),
			}
		: null;

	return {
		date,
		me,
		scope: manages ? await summarizeScope(date, people) : null,
	};
}

/**
 * `GET /dashboard/trend?days=7` (§5.1): la serie de los últimos días del ámbito.
 *
 * El rango incluye **hoy**, que es el día que se está mirando en el resto del
 * panel; sin él, la tendencia contaría una historia que termina ayer.
 */
export async function getDashboardTrend(
	scope: Scope,
	days: number,
): Promise<DashboardTrend> {
	const people = await peopleInScope(scope);
	if (people.length === 0) return { days: [] };

	const to = await todayForScope(people);
	const from = new Date(
		Date.parse(`${to}T00:00:00.000Z`) - (days - 1) * 86_400_000,
	)
		.toISOString()
		.slice(0, 10);

	const facts = await loadDailyFacts(people, { from, to });

	return {
		days: eachDayOfInterval({ start: parseISO(from), end: parseISO(to) })
			.map((day) => format(day, "yyyy-MM-dd"))
			.map((date) => {
				const summary = tally(
					people.flatMap((person) => {
						const fact = facts.get(dayKey(person.id, date));
						return fact ? [fact] : [];
					}),
					to,
				);
				return { date, total: summary.total, counts: summary.counts };
			}),
	};
}

/**
 * `GET /dashboard/alerts` (§5.1): lo que espera por una decisión del ámbito.
 *
 * **Sólo se devuelven las que tienen algo pendiente.** Una alerta con cero no es
 * una alerta: es ruido que enseña a ignorar la zona de alertas, que es
 * exactamente lo contrario de para qué existe.
 */
export async function getDashboardAlerts(
	scope: Scope,
): Promise<{ alerts: DashboardAlert[] }> {
	const [absences, incidents, vacations, paused] = await Promise.all([
		countPendingAbsences(scope, {}),
		countPendingIncidents(scope),
		countPendingVacationRequests(scope),
		countPausedDepartments(scope),
	]);

	const alerts: DashboardAlert[] = [
		{ kind: "absences_unreviewed" as const, count: absences },
		{ kind: "incidents_pending" as const, count: incidents },
		{ kind: "vacations_pending" as const, count: vacations },
		{ kind: "departments_paused" as const, count: paused },
	].filter((alert) => alert.count > 0);

	return { alerts };
}
