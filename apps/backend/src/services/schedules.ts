import {
	type AppRole,
	type DepartmentSchedule,
	describeMarkWindow,
	type MySchedule,
	roleCanMark,
	type ScheduleTimes,
	scheduleIssue,
	type UpdateDepartmentScheduleInput,
	type UpdateWorkCalendarInput,
	type WorkCalendarEntry,
} from "@elineas/validations";
import { endOfMonth, format, parseISO, startOfMonth } from "date-fns";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import { departmentSchedules, workCalendar } from "#/db/schema";
import { audit } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";
import {
	type Actor,
	activeMemberIds,
	requireDepartment,
} from "#/services/departments.ts";
import { notify } from "#/services/notifications.ts";
import { resolveWorkday, todayIn } from "#/services/schedule-rules.ts";

/**
 * Horarios y calendario laboral (spec 07).
 *
 * Este servicio hace lo de siempre —transacción, bitácora dentro de ella
 * (RN-18.4), notificaciones en el servidor (H-4)— y nada de reglas de tiempo: la
 * aritmética de la ventana vive en `@elineas/validations` porque la comparte con
 * el formulario, y la decisión de si un marcaje entra vive en
 * `schedule-rules.ts`, que es puro. Aquí sólo se lee y se escribe.
 */

type ScheduleRow = typeof departmentSchedules.$inferSelect;
type CalendarRow = typeof workCalendar.$inferSelect;

/**
 * `time` de PostgreSQL vuelve como `HH:MM:SS`; la API y los `<input type="time">`
 * hablan `HH:mm`. El recorte se hace **en un solo sitio** para que ningún
 * consumidor tenga que acordarse de los segundos.
 */
const toTimeOfDay = (value: string) => value.slice(0, 5);

function toSchedule(row: ScheduleRow): DepartmentSchedule {
	return {
		id: row.id,
		departmentId: row.departmentId,
		checkinStartTime: toTimeOfDay(row.checkinStartTime),
		checkinEndTime: toTimeOfDay(row.checkinEndTime),
		checkoutStartTime: toTimeOfDay(row.checkoutStartTime),
		checkoutEndTime: toTimeOfDay(row.checkoutEndTime),
		timezone: row.timezone,
		allowEarlyCheckin: row.allowEarlyCheckin,
		allowLateCheckout: row.allowLateCheckout,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function toEntry(row: CalendarRow): WorkCalendarEntry {
	return {
		id: row.id,
		departmentId: row.departmentId,
		date: row.date,
		isWorkday: row.isWorkday,
		lateToleranceMinutes: row.lateToleranceMinutes,
		note: row.note,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

// ── Horario ───────────────────────────────────────────────────────────────────

export async function getSchedule(
	departmentId: string,
): Promise<DepartmentSchedule | null> {
	const row = await db.query.departmentSchedules.findFirst({
		where: eq(departmentSchedules.departmentId, departmentId),
	});
	return row ? toSchedule(row) : null;
}

/** ¿Tiene horario? Lo pregunta el borrado de departamentos (spec 01 §5.2). */
export async function hasSchedule(departmentId: string): Promise<boolean> {
	return (await getSchedule(departmentId)) !== null;
}

const sameTimes = (a: ScheduleTimes, b: ScheduleTimes) =>
	a.checkinStartTime === b.checkinStartTime &&
	a.checkinEndTime === b.checkinEndTime &&
	a.checkoutStartTime === b.checkoutStartTime &&
	a.checkoutEndTime === b.checkoutEndTime &&
	a.allowEarlyCheckin === b.allowEarlyCheckin &&
	a.allowLateCheckout === b.allowLateCheckout;

/**
 * `PUT` del horario: crea o reemplaza el único que puede tener el departamento
 * (RN-07.1).
 *
 * Dos cosas que no son obvias:
 *
 * - **Omitir la zona horaria conserva la que había**, y en un horario nuevo toma
 *   `global_timezone` (RN-06.6). Tratar la omisión como "vuelve a la global"
 *   movería de zona a un departamento por no repetir un campo que nadie tocó.
 * - **Guardar lo mismo no notifica.** RN-07.10 avisa a todos los miembros de un
 *   cambio de horario; sin esta comprobación, abrir el formulario y darle a
 *   guardar mandaría un aviso a toda la plantilla del departamento sin que nada
 *   cambiara.
 */
export async function upsertSchedule(
	departmentId: string,
	input: UpdateDepartmentScheduleInput,
	actor: Actor,
): Promise<DepartmentSchedule> {
	const department = await requireDepartment(departmentId);
	const before = await getSchedule(departmentId);

	const issue = scheduleIssue(input);
	if (issue) throw new HTTPException(400, { message: issue });

	const config = await getConfig();
	const timezone = input.timezone ?? before?.timezone ?? config.global_timezone;

	const values = {
		departmentId,
		checkinStartTime: input.checkinStartTime,
		checkinEndTime: input.checkinEndTime,
		checkoutStartTime: input.checkoutStartTime,
		checkoutEndTime: input.checkoutEndTime,
		timezone,
		allowEarlyCheckin: input.allowEarlyCheckin,
		allowLateCheckout: input.allowLateCheckout,
	};

	if (before && sameTimes(before, values) && before.timezone === timezone) {
		return before;
	}

	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(departmentSchedules)
			.values(values)
			.onConflictDoUpdate({
				target: departmentSchedules.departmentId,
				set: { ...values, updatedAt: new Date() },
			})
			.returning();

		if (!row) {
			throw new HTTPException(500, {
				message: "No se pudo guardar el horario.",
			});
		}

		const saved = toSchedule(row);

		await audit(tx, {
			actorId: actor.profileId,
			action: before ? "schedule.updated" : "schedule.created",
			tableName: "department_schedules",
			recordId: row.id,
			oldData: before,
			newData: saved,
			metadata: { departmentId },
			sourceIp: actor.sourceIp,
		});

		// RN-07.10 — Al cambiar el horario se avisa a todos los miembros. El aviso
		// se genera aquí, en la transacción del cambio, y no en el cliente: es el
		// hallazgo H-4 de la spec 14.
		await notify(tx, await activeMemberIds(tx, departmentId), {
			type: "schedule.changed",
			title: `Nuevo horario en ${department.name}`,
			body: `${describeMarkWindow(saved, "IN")} ${describeMarkWindow(saved, "OUT")}`,
			actionUrl: "/profile",
			// Un aviso vivo por departamento: corregir una hora mal puesta no debe
			// dejar tres notificaciones iguales en la campana de cada persona.
			dedupeKey: `schedule:${departmentId}`,
		});

		return saved;
	});
}

/**
 * Quitar el horario de un departamento.
 *
 * No está en la §5 de la spec y se añade por necesidad: el borrado de un
 * departamento se bloquea si tiene horario (spec 01 §5.2), así que sin esta
 * operación ese bloqueo sería un callejón sin salida. También es la forma de
 * dejar de exigir marcaje a un departamento que pasa a no tenerlo.
 */
export async function deleteSchedule(
	departmentId: string,
	actor: Actor,
): Promise<void> {
	await requireDepartment(departmentId);
	const before = await getSchedule(departmentId);
	if (!before) {
		throw new HTTPException(404, {
			message: "Ese departamento no tiene horario configurado.",
		});
	}

	await db.transaction(async (tx) => {
		await tx
			.delete(departmentSchedules)
			.where(eq(departmentSchedules.departmentId, departmentId));

		await audit(tx, {
			actorId: actor.profileId,
			action: "schedule.updated",
			tableName: "department_schedules",
			recordId: before.id,
			oldData: before,
			newData: null,
			metadata: { departmentId, removed: true },
			sourceIp: actor.sourceIp,
		});

		await notify(tx, await activeMemberIds(tx, departmentId), {
			type: "schedule.changed",
			title: "Tu departamento se quedó sin horario",
			body: "Hasta que se configure uno nuevo no podrás registrar asistencia. Consulta con tu jefe.",
			actionUrl: "/profile",
			dedupeKey: `schedule:${departmentId}`,
		});
	});
}

// ── Calendario laboral ────────────────────────────────────────────────────────

export async function getCalendar(
	departmentId: string,
	range: { from: string; to: string },
): Promise<WorkCalendarEntry[]> {
	const rows = await db
		.select()
		.from(workCalendar)
		.where(
			and(
				eq(workCalendar.departmentId, departmentId),
				gte(workCalendar.date, range.from),
				lte(workCalendar.date, range.to),
			),
		)
		.orderBy(asc(workCalendar.date));

	return rows.map(toEntry);
}

async function getCalendarEntry(
	departmentId: string,
	date: string,
): Promise<WorkCalendarEntry | null> {
	const row = await db.query.workCalendar.findFirst({
		where: and(
			eq(workCalendar.departmentId, departmentId),
			eq(workCalendar.date, date),
		),
	});
	return row ? toEntry(row) : null;
}

/**
 * `PUT` del calendario: upsert por lote (spec 07 §5).
 *
 * Todo el lote va en **una transacción con una sola entrada de bitácora**: marcar
 * los domingos de un año son 52 fechas, y 52 entradas de bitácora idénticas
 * enterrarían el resto del rastro.
 *
 * Borrar una fila no es lo mismo que marcarla no laborable: sin fila la fecha
 * vuelve a ser laborable por defecto con la tolerancia global (RN-07.7, RN-07.8),
 * y `clearDates` es la forma de llegar a ese estado.
 */
export async function upsertCalendar(
	departmentId: string,
	input: UpdateWorkCalendarInput,
	actor: Actor,
): Promise<WorkCalendarEntry[]> {
	await requireDepartment(departmentId);

	const touched = [
		...input.entries.map((entry) => entry.date),
		...input.clearDates,
	];

	const before = await db
		.select()
		.from(workCalendar)
		.where(
			and(
				eq(workCalendar.departmentId, departmentId),
				inArray(workCalendar.date, touched),
			),
		);

	await db.transaction(async (tx) => {
		if (input.entries.length > 0) {
			await tx
				.insert(workCalendar)
				.values(
					input.entries.map((entry) => ({
						departmentId,
						date: entry.date,
						isWorkday: entry.isWorkday,
						lateToleranceMinutes: entry.lateToleranceMinutes,
						note: entry.note,
					})),
				)
				.onConflictDoUpdate({
					target: [workCalendar.departmentId, workCalendar.date],
					set: {
						isWorkday: sql`excluded.is_workday`,
						lateToleranceMinutes: sql`excluded.late_tolerance_minutes`,
						note: sql`excluded.note`,
						updatedAt: new Date(),
					},
				});
		}

		if (input.clearDates.length > 0) {
			await tx
				.delete(workCalendar)
				.where(
					and(
						eq(workCalendar.departmentId, departmentId),
						inArray(workCalendar.date, input.clearDates),
					),
				);
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "work_calendar.updated",
			tableName: "work_calendar",
			recordId: departmentId,
			oldData: before.map(toEntry),
			newData: input.entries,
			metadata: {
				departmentId,
				dates: touched.length,
				cleared: input.clearDates,
			},
			sourceIp: actor.sourceIp,
		});
	});

	const after = await db
		.select()
		.from(workCalendar)
		.where(
			and(
				eq(workCalendar.departmentId, departmentId),
				inArray(workCalendar.date, touched),
			),
		)
		.orderBy(asc(workCalendar.date));

	return after.map(toEntry);
}

/** Filas del calendario que quedarían huérfanas, para el aviso del borrado. */
export async function countCalendarEntries(
	departmentId: string,
): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(workCalendar)
		.where(eq(workCalendar.departmentId, departmentId));
	return row?.count ?? 0;
}

// ── El horario propio ─────────────────────────────────────────────────────────

/**
 * `GET /me/schedule` (spec 07 §5): el horario que le aplica hoy a quien pregunta.
 *
 * Resuelve **hoy en la zona del horario**, no en la del servidor ni en la del
 * navegador (RN-07.2): a las 23:30 en La Habana, un servidor en UTC ya está en el
 * día siguiente y le diría al operario que mañana es feriado.
 *
 * Devuelve además las filas del calendario del rango pedido —por defecto el mes en
 * curso— porque un `employee` no tiene ámbito sobre
 * `GET /departments/:id/calendar` y sin esto no habría forma de que viera sus
 * propios días no laborables. Sólo salen las de su departamento.
 */
export async function getMySchedule(
	profile: { departmentId: string | null },
	role: AppRole,
	range: { from?: string; to?: string } = {},
): Promise<MySchedule> {
	const config = await getConfig();
	const canMark = roleCanMark(role);

	if (!profile.departmentId) {
		const today = todayIn(config.global_timezone);
		return {
			department: null,
			schedule: null,
			timezone: config.global_timezone,
			today: resolveWorkday(today, null, config.late_tolerance_minutes),
			from: range.from ?? today,
			to: range.to ?? today,
			entries: [],
			canMark,
			globalToleranceMinutes: config.late_tolerance_minutes,
		};
	}

	const department = await requireDepartment(profile.departmentId);
	const schedule = await getSchedule(department.id);
	const timezone = schedule?.timezone ?? config.global_timezone;
	const today = todayIn(timezone);

	const from =
		range.from ?? format(startOfMonth(parseISO(today)), "yyyy-MM-dd");
	const to = range.to ?? format(endOfMonth(parseISO(today)), "yyyy-MM-dd");

	const entries = await getCalendar(department.id, { from, to });
	// La fila de hoy puede caer fuera del rango pedido (alguien mirando el mes que
	// viene), así que se pide aparte en vez de buscarla en `entries`.
	const todayEntry =
		entries.find((entry) => entry.date === today) ??
		(await getCalendarEntry(department.id, today));

	return {
		department: { id: department.id, name: department.name },
		schedule,
		timezone,
		today: resolveWorkday(today, todayEntry, config.late_tolerance_minutes),
		from,
		to,
		entries,
		canMark,
		globalToleranceMinutes: config.late_tolerance_minutes,
	};
}
