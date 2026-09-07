import { eachDayOfInterval, format, parseISO } from "date-fns";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	attendanceAbsenceReviews,
	attendanceMarks,
	departments,
	profiles,
} from "#/db/schema";
import { getConfig } from "#/services/config.ts";
import { computeDailyStatus, type DailyMark } from "#/services/daily-status.ts";
import { restDayPredicate } from "#/services/rest-rules.ts";
import { loadRestContexts } from "#/services/rest-schedules.ts";
import { todayIn } from "#/services/schedule-rules.ts";
import { getCalendar, getSchedule } from "#/services/schedules.ts";
import {
	loadApprovedVacationRanges,
	vacationDayPredicate,
} from "#/services/vacation-ranges.ts";

/**
 * **El servicio de la §4 de la spec 15**: carga el contexto de varias personas y
 * un rango de fechas *en lote* y aplica la función pura de `daily-status.ts`.
 *
 * La spec pide exactamente dos piezas —una función pura sin acceso a base y un
 * servicio que cargue su contexto por lotes— y avisa de la trampa que el legacy
 * ya pisó: **N+1**. Allí el cálculo se hacía por empleado en el cliente y hubo
 * que moverlo al servidor para eliminarlo (punto 55). Aquí las consultas son
 * **dos por rango más tres por departamento**, no una por persona: un panel de
 * 200 empleados de un departamento hace las mismas cinco consultas que uno de 5.
 * Hay una prueba que las cuenta.
 *
 * Vivía dentro de `services/absences.ts`, que fue quien lo necesitó primero
 * (spec 13 §5, la bandeja de ausencias pendientes). Se saca aquí porque ahora lo
 * comparten tres consumidores —esa bandeja, el historial propio de la spec 09 y
 * los paneles de esta spec— y porque es el sitio que la §4 nombra. Es el mismo
 * movimiento que hizo la spec 10 con `resolveRestDays`.
 *
 * **Lee el contexto directamente de las tablas, sin pasar por los servicios de
 * dominio.** Es deliberado: si pidiera las revisiones de ausencia a
 * `services/absences.ts`, ese servicio —que necesita clasificar días para
 * aplicar RN-13.1— acabaría importándose a sí mismo a través de aquí. La
 * agregación está debajo de los dominios que la consumen, no al lado.
 */

/**
 * Lo mínimo que la agregación necesita de una persona: quién es y en qué
 * departamento estaba. Todo lo demás —nombre, correo— es presentación, y pedirlo
 * obligaría a cargarlo en el historial propio, que ya sabe de quién es.
 */
export type DailyFactsProfile = { id: string; departmentId: string | null };

/** Lo anterior más lo que las listas por ámbito necesitan para pintarse. */
export type ScopedProfile = DailyFactsProfile & {
	fullName: string;
	email: string;
	departmentName: string | null;
};

export const dayKey = (userId: string, date: string) => `${userId}|${date}`;

/**
 * La revisión de cada (persona, día) del rango, para la superposición `AJ`/`ANJ`
 * y para saber qué días ya tienen decisión.
 *
 * Privada: lo que sale de aquí es el día ya clasificado, no sus insumos. Quien
 * quiera las decisiones en sí las pide a `services/absences.ts`, que es su
 * dueño.
 */
async function loadAbsenceReviews(
	userIds: readonly string[],
	range: { from: string; to: string },
): Promise<Map<string, { isJustified: boolean; notes: string | null }>> {
	const reviews = new Map<
		string,
		{ isJustified: boolean; notes: string | null }
	>();
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return reviews;

	const rows = await db
		.select({
			userId: attendanceAbsenceReviews.userId,
			date: attendanceAbsenceReviews.date,
			isJustified: attendanceAbsenceReviews.isJustified,
			notes: attendanceAbsenceReviews.notes,
		})
		.from(attendanceAbsenceReviews)
		.where(
			and(
				inArray(attendanceAbsenceReviews.userId, ids),
				gte(attendanceAbsenceReviews.date, range.from),
				lte(attendanceAbsenceReviews.date, range.to),
			),
		);

	for (const row of rows) {
		reviews.set(dayKey(row.userId, row.date), {
			isJustified: row.isJustified,
			notes: row.notes,
		});
	}
	return reviews;
}

/**
 * Clasifica cada jornada de cada persona del rango, agrupando las consultas.
 *
 * Es la misma composición que hace `getDaysFor` para una persona —calendario,
 * descansos, vacaciones, marcas— pero cargada por lotes. Las marcas se piden
 * aquí con una consulta propia y mínima en vez de reutilizar la de
 * `attendance.ts`: ésa resuelve además el nombre de la sede de cada marca, que
 * para clasificar un día no hace falta y multiplica el trabajo por el número de
 * marcas del mes.
 */
export async function loadDailyFacts(
	people: readonly DailyFactsProfile[],
	range: { from: string; to: string },
): Promise<Map<string, ReturnType<typeof computeDailyStatus>>> {
	const facts = new Map<string, ReturnType<typeof computeDailyStatus>>();
	if (people.length === 0) return facts;

	const ids = people.map((person) => person.id);
	const config = await getConfig();

	const dates = eachDayOfInterval({
		start: parseISO(range.from),
		end: parseISO(range.to),
	}).map((day) => format(day, "yyyy-MM-dd"));

	const marks = await db
		.select({
			userId: attendanceMarks.userId,
			workDate: attendanceMarks.workDate,
			markType: attendanceMarks.markType,
			markedAt: attendanceMarks.markedAt,
			isLate: attendanceMarks.isLate,
			lateMinutes: attendanceMarks.lateMinutes,
		})
		.from(attendanceMarks)
		.where(
			and(
				inArray(attendanceMarks.userId, ids),
				eq(attendanceMarks.blocked, false),
				gte(attendanceMarks.workDate, range.from),
				lte(attendanceMarks.workDate, range.to),
			),
		);

	const marksByDay = new Map<string, DailyMark[]>();
	for (const mark of marks) {
		if (!mark.workDate) continue;
		const at = dayKey(mark.userId, mark.workDate);
		const list = marksByDay.get(at) ?? [];
		list.push({
			markType: mark.markType === "OUT" ? "OUT" : "IN",
			markedAt: new Date(mark.markedAt),
			isLate: mark.isLate,
			lateMinutes: mark.lateMinutes,
		});
		marksByDay.set(at, list);
	}

	const reviews = await loadAbsenceReviews(ids, range);
	const vacations = await loadApprovedVacationRanges(ids);

	// Por departamento: el calendario, la zona y los contextos de descanso. Es lo
	// único que no se puede pedir de una vez para toda la plantilla, porque cada
	// departamento tiene su horario y su calendario.
	const byDepartment = new Map<string | null, DailyFactsProfile[]>();
	for (const person of people) {
		const list = byDepartment.get(person.departmentId) ?? [];
		list.push(person);
		byDepartment.set(person.departmentId, list);
	}

	for (const [departmentId, members] of byDepartment) {
		const department = departmentId
			? ((await db.query.departments.findFirst({
					where: eq(departments.id, departmentId),
				})) ?? null)
			: null;
		const schedule = departmentId ? await getSchedule(departmentId) : null;
		const timezone = schedule?.timezone ?? config.global_timezone;
		const today = todayIn(timezone);

		const calendar = departmentId ? await getCalendar(departmentId, range) : [];
		const calendarByDate = new Map(
			calendar.map((entry) => [entry.date, entry]),
		);

		const restContexts = await loadRestContexts(
			members.map((member) => member.id),
			department
				? {
						id: department.id,
						name: department.name,
						restGroupsEnabled: department.restGroupsEnabled,
					}
				: null,
		);

		for (const member of members) {
			const isRestDay = restDayPredicate(
				restContexts.get(member.id) ?? {
					restGroupsEnabled: false,
					schedules: [],
					memberships: [],
					groupsById: {},
				},
			);
			const onVacation = vacationDayPredicate(vacations.get(member.id) ?? []);

			for (const date of dates) {
				const at = dayKey(member.id, date);
				facts.set(
					at,
					computeDailyStatus({
						date,
						marks: marksByDay.get(at) ?? [],
						isWorkday: calendarByDate.get(date)?.isWorkday ?? true,
						onVacation: onVacation(date),
						isRestDay: isRestDay(date),
						isOpen: date >= today,
						absenceReview: reviews.get(at) ?? null,
					}),
				);
			}
		}
	}

	return facts;
}

/**
 * Las personas del ámbito de quien pregunta (RN-03.2), activas y con
 * departamento.
 *
 * Sin departamento no hay concepto de día laborable (RN-02.3), así que un perfil
 * incompleto no puede tener ausencias que clasificar; y las bajas quedan fuera
 * porque son historial, no operación — el mismo criterio de `listUsers`.
 */
export async function peopleInScope(
	scope: { managedDepartmentIds: string[] | "all" },
	departmentId?: string,
): Promise<ScopedProfile[]> {
	const conditions = [
		eq(profiles.isActive, true),
		sql`${profiles.departmentId} is not null`,
	];

	if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return [];
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}
	if (departmentId) conditions.push(eq(profiles.departmentId, departmentId));

	return db
		.select({
			id: profiles.id,
			fullName: profiles.fullName,
			email: profiles.email,
			departmentId: profiles.departmentId,
			departmentName: departments.name,
		})
		.from(profiles)
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.where(and(...conditions))
		.orderBy(asc(profiles.fullName));
}
