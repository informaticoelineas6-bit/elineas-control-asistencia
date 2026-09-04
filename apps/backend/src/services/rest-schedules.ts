import {
	type AppRole,
	type CreateRestGroupInput,
	type DepartmentRestDays,
	isRestDate,
	type ResolvedRestSchedule,
	type RestGroup,
	type RestLimits,
	type RestSchedule,
	type RestScheduleView,
	restDaysIssue,
	roleAtLeast,
	roleCanMark,
	type UpdateRestGroupInput,
	type UpdateRestGroupMembersInput,
	type UpdateRestScheduleInput,
} from "@elineas/validations";
import { eachDayOfInterval, format, parseISO } from "date-fns";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import {
	attendanceMarks,
	departments,
	notifications,
	profiles,
	restGroupMembers,
	restGroups,
	userRestSchedule,
} from "#/db/schema";
import { type Actor, audit, type Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";
import { requireDepartment } from "#/services/departments.ts";
import { notify } from "#/services/notifications.ts";
import {
	effectiveAt,
	NO_REST_CONTEXT,
	type RestContext,
	type RestGroupSnapshot,
	resolveRestDaysAt,
	restDayPredicate,
} from "#/services/rest-rules.ts";
import { todayIn } from "#/services/schedule-rules.ts";
import { getSchedule } from "#/services/schedules.ts";

/**
 * Descansos (spec 10). Este servicio **carga contexto y escribe**; las reglas de
 * resolución están en `rest-rules.ts`, que es puro, y las del conjunto de días
 * (separación mínima y número por semana) en `@elineas/validations`, porque las
 * comparte con el selector de la interfaz.
 *
 * Lo que hay que tener presente al leerlo:
 *
 * - **La configuración no se sobrescribe, se apila** (RN-10.1). Un `PUT` no es un
 *   `UPDATE` de la fila anterior: es una fila nueva con su `effective_from`. Eso
 *   es lo que hace que el reporte de un mes cerrado siga dando el mismo número.
 * - **Nada se borra.** Sacar a alguien de un grupo es una fila con `group_id`
 *   nulo; retirar un grupo con historial es desactivarlo (mismo criterio que las
 *   sedes, RN-08.10). El único `DELETE` es el del grupo que nunca tuvo miembros.
 * - **Las validaciones de RN-10.5, RN-10.6 y RN-10.9 son de servidor.** La
 *   interfaz las repite en vivo con las mismas funciones, pero el que decide es
 *   éste (criterio de aceptación de la §8).
 */

// ── Límites vigentes ──────────────────────────────────────────────────────────

/**
 * Los límites que se aplican a una persona, ya resueltos (spec 06 §3.3).
 *
 * **La lista vacía de `rest_days_min_separation_departments` significa "todos"**
 * (decisión 2 de la §9, cerrada): el interruptor de la regla es el número —0 la
 * desactiva— y la lista sólo la acota. Con el criterio contrario, poner el número
 * y olvidar la lista dejaría una regla configurada que no hace nada.
 */
export async function restLimitsFor(
	departmentId: string | null,
): Promise<RestLimits> {
	const config = await getConfig();
	const scope = config.rest_days_min_separation_departments;
	const applies =
		scope.length === 0 ||
		(departmentId !== null && scope.includes(departmentId));

	return {
		minSeparationDays: applies ? config.rest_days_min_separation : 0,
		minPerWeek: config.rest_days_min_per_week,
		maxPerWeek: config.rest_days_max_per_week,
	};
}

/**
 * Hoy **en la zona del departamento** (RN-07.2), que es contra lo que RN-10.7
 * mide si una fecha de vigencia es pasada. En la del servidor —UTC en un
 * contenedor— a las 21:00 en La Habana ya sería mañana, y un jefe no podría fijar
 * un descanso "desde mañana" a última hora de la tarde.
 */
async function todayFor(departmentId: string | null): Promise<string> {
	const config = await getConfig();
	const schedule = departmentId ? await getSchedule(departmentId) : null;
	return todayIn(schedule?.timezone ?? config.global_timezone);
}

// ── Carga del contexto ────────────────────────────────────────────────────────

type DepartmentSnapshot = {
	id: string;
	name: string;
	restGroupsEnabled: boolean;
} | null;

/**
 * El contexto de varias personas **de un tirón**: tres consultas para toda la
 * plantilla de un departamento en vez de tres por persona.
 *
 * Se carga el historial completo, no sólo la fila vigente hoy, porque un rango de
 * fechas puede atravesar un cambio de configuración y RN-10.1 exige resolver
 * fecha a fecha (lo hace `resolveRestDaysAt`).
 */
export async function loadRestContexts(
	userIds: readonly string[],
	department: DepartmentSnapshot,
): Promise<Map<string, RestContext>> {
	const contexts = new Map<string, RestContext>();
	if (userIds.length === 0) return contexts;

	const ids = [...new Set(userIds)];
	const restGroupsEnabled = department?.restGroupsEnabled ?? false;

	const scheduleRows = restGroupsEnabled
		? []
		: await db
				.select({
					userId: userRestSchedule.userId,
					daysOfWeek: userRestSchedule.daysOfWeek,
					effectiveFrom: userRestSchedule.effectiveFrom,
				})
				.from(userRestSchedule)
				.where(inArray(userRestSchedule.userId, ids));

	const membershipRows = restGroupsEnabled
		? await db
				.select({
					userId: restGroupMembers.userId,
					groupId: restGroupMembers.groupId,
					effectiveFrom: restGroupMembers.effectiveFrom,
				})
				.from(restGroupMembers)
				.where(inArray(restGroupMembers.userId, ids))
		: [];

	const groupsById: Record<string, RestGroupSnapshot> = {};
	if (restGroupsEnabled && department) {
		// Todos los grupos del departamento, **activos y desactivados**: una
		// asignación vieja puede apuntar a uno retirado, y el histórico tiene que
		// seguir resolviéndose con los días que tenía.
		const rows = await db
			.select({
				id: restGroups.id,
				name: restGroups.name,
				daysOfWeek: restGroups.daysOfWeek,
			})
			.from(restGroups)
			.where(eq(restGroups.departmentId, department.id));

		for (const row of rows) groupsById[row.id] = row;
	}

	for (const userId of ids) {
		contexts.set(userId, {
			restGroupsEnabled,
			schedules: scheduleRows.filter((row) => row.userId === userId),
			memberships: membershipRows.filter((row) => row.userId === userId),
			groupsById,
		});
	}

	return contexts;
}

export async function loadRestContext(
	userId: string,
	department: DepartmentSnapshot,
): Promise<RestContext> {
	const contexts = await loadRestContexts([userId], department);
	return contexts.get(userId) ?? NO_REST_CONTEXT;
}

/** Perfil tal como lo necesita este servicio. */
export type RestProfile = { id: string; departmentId: string | null };

async function departmentSnapshotOf(
	departmentId: string | null,
): Promise<DepartmentSnapshot> {
	if (!departmentId) return null;
	const row = await db.query.departments.findFirst({
		where: eq(departments.id, departmentId),
	});
	return row
		? {
				id: row.id,
				name: row.name,
				restGroupsEnabled: row.restGroupsEnabled,
			}
		: null;
}

/**
 * El predicado `isRestDay(workDate)` de esta persona, que es lo que consumen el
 * marcaje (spec 09 RN-09.5) y la agregación diaria (spec 15).
 *
 * Es **la costura que la spec 09 dejó preparada**: recibía los descansos como
 * predicado precisamente para no tener que elegir la convención de `days_of_week`
 * antes de tiempo, y construir esta spec es, en su parte de marcaje, conectar este
 * argumento.
 */
export async function restDayResolverFor(
	profile: RestProfile,
): Promise<(workDate: string) => boolean> {
	const department = await departmentSnapshotOf(profile.departmentId);
	return restDayPredicate(await loadRestContext(profile.id, department));
}

/**
 * `resolveRestDays(userId, date)` de la spec 10 §6, con la carga incluida.
 *
 * Es la firma que la spec nombra; el resto del sistema usa `restDayResolverFor`
 * cuando necesita varias fechas, para no repetir las consultas por día.
 */
export async function resolveRestDays(
	userId: string,
	date: string,
): Promise<ResolvedRestSchedule> {
	const [profile] = await db
		.select({ id: profiles.id, departmentId: profiles.departmentId })
		.from(profiles)
		.where(eq(profiles.id, userId));

	if (!profile)
		throw new HTTPException(404, { message: "Ese perfil no existe." });

	const department = await departmentSnapshotOf(profile.departmentId);
	const context = await loadRestContext(profile.id, department);
	return toResolved(profile.id, date, context);
}

function toResolved(
	userId: string,
	date: string,
	context: RestContext,
): ResolvedRestSchedule {
	const resolution = resolveRestDaysAt(context, date);
	return {
		userId,
		date,
		daysOfWeek: resolution.daysOfWeek,
		source: resolution.source,
		effectiveFrom: resolution.effectiveFrom,
		group: resolution.group,
		restGroupsEnabled: context.restGroupsEnabled,
		isRestDay: isRestDate(resolution.daysOfWeek, date),
	};
}

// ── La configuración individual ───────────────────────────────────────────────

type ScheduleRow = typeof userRestSchedule.$inferSelect;

const toSchedule = (row: ScheduleRow): RestSchedule => ({
	id: row.id,
	userId: row.userId,
	daysOfWeek: row.daysOfWeek,
	effectiveFrom: row.effectiveFrom,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

async function listSchedules(userId: string): Promise<RestSchedule[]> {
	const rows = await db
		.select()
		.from(userRestSchedule)
		.where(eq(userRestSchedule.userId, userId))
		.orderBy(desc(userRestSchedule.effectiveFrom));
	return rows.map(toSchedule);
}

async function requireProfile(userId: string) {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.id, userId),
	});
	if (!row) throw new HTTPException(404, { message: "Ese perfil no existe." });
	return row;
}

/**
 * `GET /me/rest-schedule` y `GET /users/:id/rest-schedule` (spec 10 §6).
 *
 * Devuelve los descansos **resueltos para la fecha pedida** más el historial de
 * configuraciones individuales, los límites vigentes y el suelo de
 * `effective_from`: el selector tiene que poder avisar con la misma regla que va a
 * aplicar el servidor (§7) y no puede calcular "hoy" con el reloj del navegador.
 */
export async function getRestScheduleView(
	userId: string,
	viewer: { role: AppRole; isSelf: boolean },
	date?: string,
): Promise<RestScheduleView> {
	const profile = await requireProfile(userId);
	const department = await departmentSnapshotOf(profile.departmentId);
	const today = await todayFor(profile.departmentId);
	const context = await loadRestContext(profile.id, department);

	return {
		resolved: toResolved(profile.id, date ?? today, context),
		schedules: await listSchedules(profile.id),
		limits: await restLimitsFor(profile.departmentId),
		// RN-10.2 + §4: con los grupos activados nadie edita lo individual, porque no
		// aplicaría. Sobre los propios manda `roleCanMark` —quien no marca no tiene
		// descansos que configurar (RN-03.4)— y sobre los de otro, el ámbito de jefe,
		// que el handler ya comprobó. Las dos condiciones salen de las funciones
		// compartidas en vez de volver a enumerar roles aquí: enumerarlos es lo que
		// hace que un rol nuevo entre por descuido.
		canEdit:
			!(department?.restGroupsEnabled ?? false) &&
			(viewer.isSelf
				? roleCanMark(viewer.role)
				: roleAtLeast(viewer.role, "department_head")),
		canBackdate: canBackdate(viewer.role),
		department: department
			? { id: department.id, name: department.name }
			: null,
		today,
	};
}

/** RN-10.7 — Fechar hacia atrás es de rol administrativo (spec 05 §2). */
function canBackdate(role: AppRole): boolean {
	return role === "global_manager" || role === "superadmin";
}

/**
 * RN-10.6 — No se puede marcar como descanso un día que ya se trabajó.
 *
 * Se comprueba sobre las marcas **aceptadas** del tramo que esta configuración va
 * a gobernar: desde su `effective_from` hasta que empiece la siguiente, si hay
 * una. Un intento rechazado no cuenta: no es trabajo, es un rechazo registrado
 * (RN-09.8).
 *
 * `extract(dow …)` de PostgreSQL usa la misma convención que guardamos —0 =
 * domingo— y por eso la comparación no necesita traducción. Los días vienen
 * validados por Zod como enteros de 0 a 6, así que interpolarlos en el `in` es
 * seguro; no se puede parametrizar la lista sin cambiar de forma la consulta.
 */
async function assertNoMarksOnRestDays(
	userId: string,
	daysOfWeek: readonly number[],
	from: string,
	until: string | null,
): Promise<void> {
	if (daysOfWeek.length === 0) return;

	const [clash] = await db
		.select({ workDate: attendanceMarks.workDate })
		.from(attendanceMarks)
		.where(
			and(
				eq(attendanceMarks.userId, userId),
				eq(attendanceMarks.blocked, false),
				gte(attendanceMarks.workDate, from),
				until ? lt(attendanceMarks.workDate, until) : undefined,
				sql`extract(dow from ${attendanceMarks.workDate})::int in (${sql.raw(daysOfWeek.join(","))})`,
			),
		)
		.orderBy(asc(attendanceMarks.workDate))
		.limit(1);

	if (clash) {
		throw new HTTPException(409, {
			message: `El ${clash.workDate} ya tiene asistencia registrada, así que no puede quedar como día de descanso. Si fue un error, corrígelo por incidencias.`,
		});
	}
}

/** La vigencia siguiente a una fecha, que es hasta dónde llega la que se guarda. */
async function nextScheduleFrom(
	userId: string,
	effectiveFrom: string,
): Promise<string | null> {
	const [row] = await db
		.select({ effectiveFrom: userRestSchedule.effectiveFrom })
		.from(userRestSchedule)
		.where(
			and(
				eq(userRestSchedule.userId, userId),
				sql`${userRestSchedule.effectiveFrom} > ${effectiveFrom}`,
			),
		)
		.orderBy(asc(userRestSchedule.effectiveFrom))
		.limit(1);

	return row?.effectiveFrom ?? null;
}

/**
 * `PUT /me/rest-schedule` y `PUT /users/:id/rest-schedule`.
 *
 * Escribe **una fila nueva** con su vigencia, o actualiza la de esa misma fecha si
 * ya existía (alguien corrigiendo lo que acaba de guardar). Nunca toca las
 * anteriores: eso es RN-10.1.
 */
export async function setRestSchedule(
	userId: string,
	input: UpdateRestScheduleInput,
	actor: Actor & { role: AppRole },
): Promise<RestScheduleView> {
	const profile = await requireProfile(userId);
	const department = await departmentSnapshotOf(profile.departmentId);

	// §4 — Un rol que no marca no tiene descansos propios que configurar (RN-03.4).
	// Sí configura los de otros, y por eso la comprobación es sólo sobre uno mismo.
	if (actor.profileId === userId && !roleCanMark(actor.role)) {
		throw new HTTPException(403, {
			message:
				"Tu rol no registra asistencia, así que no tiene días de descanso que configurar.",
		});
	}

	// RN-10.2 — Con los grupos activados la configuración individual no aplica, así
	// que guardarla sería aceptar un cambio que no cambia nada. No se borra la que
	// haya (RN-01.6): apagar el interruptor la devuelve intacta.
	if (department?.restGroupsEnabled) {
		throw new HTTPException(409, {
			message:
				"Este departamento gestiona los descansos por grupos, así que la configuración individual no se aplicaría. Los descansos se cambian asignando a otro grupo.",
		});
	}

	const today = await todayFor(profile.departmentId);
	const effectiveFrom = input.effectiveFrom ?? today;

	// RN-10.7 — Hacia el pasado sólo un rol administrativo, y queda en bitácora.
	if (effectiveFrom < today && !canBackdate(actor.role)) {
		throw new HTTPException(400, {
			message: `Los descansos no se pueden cambiar hacia atrás: la fecha desde la que rigen tiene que ser ${today} o posterior.`,
		});
	}

	const limits = await restLimitsFor(profile.departmentId);
	const issue = restDaysIssue(input.daysOfWeek, limits);
	if (issue) throw new HTTPException(400, { message: issue });

	await assertNoMarksOnRestDays(
		userId,
		input.daysOfWeek,
		effectiveFrom,
		await nextScheduleFrom(userId, effectiveFrom),
	);

	const before = await db.query.userRestSchedule.findFirst({
		where: and(
			eq(userRestSchedule.userId, userId),
			eq(userRestSchedule.effectiveFrom, effectiveFrom),
		),
	});

	await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(userRestSchedule)
			.values({ userId, daysOfWeek: input.daysOfWeek, effectiveFrom })
			.onConflictDoUpdate({
				target: [userRestSchedule.userId, userRestSchedule.effectiveFrom],
				set: { daysOfWeek: input.daysOfWeek, updatedAt: new Date() },
			})
			.returning();

		await audit(tx, {
			actorId: actor.profileId,
			action: "rest_schedule.updated",
			tableName: "user_rest_schedule",
			recordId: row?.id ?? null,
			oldData: before ? toSchedule(before) : null,
			newData: { userId, daysOfWeek: input.daysOfWeek, effectiveFrom },
			// RN-10.7: que la fecha sea pasada tiene que verse en la bitácora, no
			// deducirse comparando `created_at` con `effective_from`.
			metadata: {
				effectiveFrom,
				backdated: effectiveFrom < today,
				onBehalfOf: actor.profileId === userId ? null : userId,
			},
			sourceIp: actor.sourceIp,
		});

		await clearRestReminder(tx, [userId]);
	});

	return getRestScheduleView(userId, {
		role: actor.role,
		isSelf: actor.profileId === userId,
	});
}

// ── Grupos ────────────────────────────────────────────────────────────────────

type GroupRow = typeof restGroups.$inferSelect;

async function requireGroup(groupId: string): Promise<GroupRow> {
	const row = await db.query.restGroups.findFirst({
		where: eq(restGroups.id, groupId),
	});
	if (!row) {
		throw new HTTPException(404, {
			message: "Ese grupo de descanso no existe.",
		});
	}
	return row;
}

/** El departamento de un grupo, que es el ámbito que hay que comprobar. */
export async function departmentOfGroup(groupId: string): Promise<string> {
	return (await requireGroup(groupId)).departmentId;
}

/**
 * Miembros vigentes hoy de los grupos de un departamento, resueltos por RN-10.1.
 *
 * Se cargan **todas** las filas de esas personas, incluidas las de `group_id`
 * nulo: la fila que dice "salió del grupo" tiene que poder ganar a la que decía
 * que entró, y filtrar por grupo en SQL la dejaría fuera.
 */
async function effectiveMembers(
	departmentId: string,
	date: string,
): Promise<
	Map<string, { userId: string; fullName: string; effectiveFrom: string }[]>
> {
	const involved = db
		.select({ userId: restGroupMembers.userId })
		.from(restGroupMembers)
		.innerJoin(restGroups, eq(restGroups.id, restGroupMembers.groupId))
		.where(eq(restGroups.departmentId, departmentId));

	const rows = await db
		.select({
			userId: restGroupMembers.userId,
			fullName: profiles.fullName,
			groupId: restGroupMembers.groupId,
			effectiveFrom: restGroupMembers.effectiveFrom,
		})
		.from(restGroupMembers)
		.innerJoin(profiles, eq(profiles.id, restGroupMembers.userId))
		.where(inArray(restGroupMembers.userId, involved));

	const byUser = new Map<string, typeof rows>();
	for (const row of rows) {
		byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
	}

	const byGroup = new Map<
		string,
		{ userId: string; fullName: string; effectiveFrom: string }[]
	>();
	for (const [userId, userRows] of byUser) {
		const winner = effectiveAt(userRows, date);
		if (!winner?.groupId) continue;
		byGroup.set(winner.groupId, [
			...(byGroup.get(winner.groupId) ?? []),
			{
				userId,
				fullName: winner.fullName,
				effectiveFrom: winner.effectiveFrom,
			},
		]);
	}

	return byGroup;
}

/** `GET /departments/:id/rest-groups`. */
export async function listRestGroups(
	departmentId: string,
): Promise<RestGroup[]> {
	await requireDepartment(departmentId);

	const rows = await db
		.select()
		.from(restGroups)
		.where(eq(restGroups.departmentId, departmentId))
		.orderBy(asc(restGroups.name));

	const members = await effectiveMembers(
		departmentId,
		await todayFor(departmentId),
	);

	return rows.map((row) => ({
		id: row.id,
		departmentId: row.departmentId,
		name: row.name,
		daysOfWeek: row.daysOfWeek,
		isActive: row.isActive,
		members: (members.get(row.id) ?? []).sort((a, b) =>
			a.fullName.localeCompare(b.fullName, "es"),
		),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	}));
}

/**
 * RN-01.1 aplicado a los grupos: dos "Grupo A" en el mismo departamento son
 * indistinguibles en el selector con el que se asigna gente. La unicidad la
 * garantiza el índice; esta comprobación existe para el mensaje legible.
 */
async function assertGroupNameAvailable(
	departmentId: string,
	name: string,
	exceptId?: string,
): Promise<void> {
	const clash = await db
		.select({ id: restGroups.id })
		.from(restGroups)
		.where(
			and(
				eq(restGroups.departmentId, departmentId),
				sql`lower(${restGroups.name}) = lower(${name})`,
			),
		);

	if (clash.some((row) => row.id !== exceptId)) {
		throw new HTTPException(409, {
			message: `Ya existe un grupo de descanso llamado "${name}" en este departamento.`,
		});
	}
}

export async function createRestGroup(
	departmentId: string,
	input: CreateRestGroupInput,
	actor: Actor,
): Promise<RestGroup> {
	await requireDepartment(departmentId);
	await assertGroupNameAvailable(departmentId, input.name);

	const issue = restDaysIssue(
		input.daysOfWeek,
		await restLimitsFor(departmentId),
	);
	if (issue) throw new HTTPException(400, { message: issue });

	const created = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(restGroups)
			.values({
				departmentId,
				name: input.name,
				daysOfWeek: input.daysOfWeek,
			})
			.returning();

		if (!row) {
			throw new HTTPException(500, { message: "No se pudo crear el grupo." });
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "rest_group.created",
			tableName: "rest_groups",
			recordId: row.id,
			newData: { name: row.name, daysOfWeek: row.daysOfWeek },
			metadata: { departmentId },
			sourceIp: actor.sourceIp,
		});

		return row;
	});

	return {
		id: created.id,
		departmentId: created.departmentId,
		name: created.name,
		daysOfWeek: created.daysOfWeek,
		isActive: created.isActive,
		members: [],
		createdAt: created.createdAt.toISOString(),
		updatedAt: created.updatedAt.toISOString(),
	};
}

/**
 * `PATCH /rest-groups/:id`.
 *
 * ⚠️ **Cambiar los días de un grupo no tiene vigencia y sí alcanza al pasado.**
 * `rest_groups` no lleva `effective_from` —la §2 de la spec no se lo da, y RN-10.1
 * habla sólo de `user_rest_schedule` y `rest_group_members`—, así que los días
 * nuevos pasan a valer también para las fechas ya reportadas de sus miembros. Es
 * correcto para corregir un grupo mal creado y **equivocado para rotar turnos**:
 * para eso se crea otro grupo y se reasigna, que es la operación que el historial
 * de asignaciones sí fecha bien. La interfaz lo advierte antes de guardar; queda
 * anotado en la §9 de la spec como consecuencia conocida del modelo.
 */
export async function updateRestGroup(
	groupId: string,
	patch: UpdateRestGroupInput,
	actor: Actor,
): Promise<RestGroup> {
	const before = await requireGroup(groupId);

	if (patch.name && patch.name !== before.name) {
		await assertGroupNameAvailable(before.departmentId, patch.name, groupId);
	}

	if (patch.daysOfWeek) {
		const issue = restDaysIssue(
			patch.daysOfWeek,
			await restLimitsFor(before.departmentId),
		);
		if (issue) throw new HTTPException(400, { message: issue });
	}

	// Desactivar un grupo con gente dentro dejaría a esa gente resolviendo contra un
	// grupo retirado, que es exactamente el estado que no debe existir. Primero se
	// reasigna (mismo criterio que RN-10.8 para el borrado).
	if (patch.isActive === false && before.isActive) {
		const today = await todayFor(before.departmentId);
		const members = (await effectiveMembers(before.departmentId, today)).get(
			groupId,
		);
		if (members && members.length > 0) {
			throw new HTTPException(409, {
				message: `No se puede desactivar: ${members.length === 1 ? "hay 1 persona" : `hay ${members.length} personas`} en este grupo. Reasígnalas antes.`,
			});
		}
	}

	const updated = await db.transaction(async (tx) => {
		const [row] = await tx
			.update(restGroups)
			.set({
				...(patch.name !== undefined ? { name: patch.name } : {}),
				...(patch.daysOfWeek !== undefined
					? { daysOfWeek: patch.daysOfWeek }
					: {}),
				...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
				updatedAt: new Date(),
			})
			.where(eq(restGroups.id, groupId))
			.returning();

		if (!row) {
			throw new HTTPException(404, {
				message: "Ese grupo de descanso no existe.",
			});
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "rest_group.updated",
			tableName: "rest_groups",
			recordId: groupId,
			oldData: {
				name: before.name,
				daysOfWeek: before.daysOfWeek,
				isActive: before.isActive,
			},
			newData: {
				name: row.name,
				daysOfWeek: row.daysOfWeek,
				isActive: row.isActive,
			},
			metadata: { departmentId: before.departmentId },
			sourceIp: actor.sourceIp,
		});

		return row;
	});

	// Los miembros se resuelven **fuera** de la transacción: leerlos dentro daría el
	// estado a medio confirmar, y esta consulta no forma parte del cambio.
	const members = await effectiveMembers(
		updated.departmentId,
		await todayFor(updated.departmentId),
	);

	return {
		id: updated.id,
		departmentId: updated.departmentId,
		name: updated.name,
		daysOfWeek: updated.daysOfWeek,
		isActive: updated.isActive,
		members: members.get(updated.id) ?? [],
		createdAt: updated.createdAt.toISOString(),
		updatedAt: updated.updatedAt.toISOString(),
	};
}

/**
 * `DELETE /rest-groups/:id` — RN-10.8, en su versión estricta.
 *
 * Se borra sólo el grupo que **nunca** tuvo a nadie: el que se creó por error. En
 * cuanto una sola fila de asignación lo referencia, el grupo forma parte del
 * historial de descansos de alguien y borrarlo cambiaría reportes ya cerrados —
 * mismo razonamiento que con las sedes (RN-08.10). La salida para retirar un grupo
 * en uso es desactivarlo, después de reasignar a su gente.
 */
export async function deleteRestGroup(
	groupId: string,
	actor: Actor,
): Promise<void> {
	const before = await requireGroup(groupId);

	const [{ count } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(restGroupMembers)
		.where(eq(restGroupMembers.groupId, groupId));

	if (count > 0) {
		throw new HTTPException(409, {
			message:
				"No se puede eliminar: este grupo forma parte del historial de descansos de alguien y borrarlo cambiaría reportes ya cerrados. Reasigna a sus miembros y desactívalo.",
		});
	}

	await db.transaction(async (tx) => {
		await tx.delete(restGroups).where(eq(restGroups.id, groupId));

		await audit(tx, {
			actorId: actor.profileId,
			action: "rest_group.deleted",
			tableName: "rest_groups",
			recordId: groupId,
			oldData: {
				name: before.name,
				daysOfWeek: before.daysOfWeek,
				isActive: before.isActive,
			},
			metadata: { departmentId: before.departmentId },
			sourceIp: actor.sourceIp,
		});
	});
}

/**
 * `PUT /rest-groups/:id/members` — reemplazo con fecha.
 *
 * El cuerpo dice quiénes son los miembros **a partir de `effectiveFrom`**. Quien
 * entra recibe una fila con el grupo; quien sale, una con `group_id` nulo. Ninguna
 * fila anterior se toca: es lo que hace que el reporte del mes pasado siga
 * diciendo que esa persona descansaba los martes, porque entonces era verdad.
 */
export async function setRestGroupMembers(
	groupId: string,
	input: UpdateRestGroupMembersInput,
	actor: Actor & { role: AppRole },
): Promise<RestGroup[]> {
	const group = await requireGroup(groupId);

	if (!group.isActive) {
		throw new HTTPException(409, {
			message:
				"Ese grupo está desactivado: no se le puede asignar gente. Reactívalo primero.",
		});
	}

	const today = await todayFor(group.departmentId);
	const effectiveFrom = input.effectiveFrom ?? today;

	if (effectiveFrom < today && !canBackdate(actor.role)) {
		throw new HTTPException(400, {
			message: `La asignación no se puede fechar hacia atrás: usa ${today} o una fecha posterior.`,
		});
	}

	const userIds = [...new Set(input.userIds)];

	// Un grupo es de un departamento (§1): asignarle a alguien de otro le daría unos
	// descansos que su propio departamento no gestiona por grupos.
	if (userIds.length > 0) {
		const eligible = await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(
				and(
					inArray(profiles.id, userIds),
					eq(profiles.departmentId, group.departmentId),
					eq(profiles.isActive, true),
				),
			);

		if (eligible.length !== userIds.length) {
			throw new HTTPException(400, {
				message:
					"Sólo se puede asignar a personas activas de ese departamento. Revisa la selección.",
			});
		}
	}

	const current = (
		await effectiveMembers(group.departmentId, effectiveFrom)
	).get(groupId);
	const currentIds = new Set((current ?? []).map((member) => member.userId));

	const added = userIds.filter((id) => !currentIds.has(id));
	const removed = [...currentIds].filter((id) => !userIds.includes(id));

	if (added.length === 0 && removed.length === 0) {
		return listRestGroups(group.departmentId);
	}

	// RN-10.6 aplicado a la asignación: los días del grupo pasan a ser descansos de
	// quien entra, y un día ya trabajado no puede convertirse en descanso.
	for (const userId of added) {
		await assertNoMarksOnRestDays(
			userId,
			group.daysOfWeek,
			effectiveFrom,
			await nextMembershipFrom(userId, effectiveFrom),
		);
	}

	await db.transaction(async (tx) => {
		const rows = [
			...added.map((userId) => ({ groupId, userId, effectiveFrom })),
			...removed.map((userId) => ({ groupId: null, userId, effectiveFrom })),
		];

		await tx
			.insert(restGroupMembers)
			.values(rows)
			.onConflictDoUpdate({
				target: [restGroupMembers.userId, restGroupMembers.effectiveFrom],
				set: { groupId: sql`excluded.group_id` },
			});

		// Una entrada por cambio y no una por persona: reasignar un turno son veinte
		// filas, y veinte entradas idénticas enterrarían el resto del rastro.
		await audit(tx, {
			actorId: actor.profileId,
			action: "rest_group.members_changed",
			tableName: "rest_group_members",
			recordId: groupId,
			oldData: { members: [...currentIds] },
			newData: { members: userIds },
			metadata: {
				departmentId: group.departmentId,
				effectiveFrom,
				backdated: effectiveFrom < today,
				added,
				removed,
			},
			sourceIp: actor.sourceIp,
		});

		if (added.length > 0) await clearRestReminder(tx, added);
	});

	return listRestGroups(group.departmentId);
}

/** La asignación siguiente de esa persona, que acota hasta dónde llega ésta. */
async function nextMembershipFrom(
	userId: string,
	effectiveFrom: string,
): Promise<string | null> {
	const [row] = await db
		.select({ effectiveFrom: restGroupMembers.effectiveFrom })
		.from(restGroupMembers)
		.where(
			and(
				eq(restGroupMembers.userId, userId),
				sql`${restGroupMembers.effectiveFrom} > ${effectiveFrom}`,
			),
		)
		.orderBy(asc(restGroupMembers.effectiveFrom))
		.limit(1);

	return row?.effectiveFrom ?? null;
}

// ── El calendario del equipo ──────────────────────────────────────────────────

/**
 * `GET /departments/:id/rest-days?from=&to=` (spec 10 §7): quién descansa cada
 * día.
 *
 * No está en la §6 y se añade porque la §7 pide *"vista de calendario del equipo
 * mostrando quién descansa cada día"*, y resolverla en el cliente obligaría a
 * pedir los descansos persona a persona y a repetir ahí la precedencia de RN-10.2.
 * Devuelve además quién no tiene ningún descanso vigente: es el hueco que RN-10.10
 * recuerda por notificación, y el jefe lo tiene que poder ver de un vistazo.
 */
export async function getDepartmentRestDays(
	departmentId: string,
	range: { from: string; to: string },
): Promise<DepartmentRestDays> {
	const department = await requireDepartment(departmentId);

	const members = await db
		.select({ id: profiles.id, fullName: profiles.fullName })
		.from(profiles)
		.where(
			and(eq(profiles.departmentId, departmentId), eq(profiles.isActive, true)),
		)
		.orderBy(asc(profiles.fullName));

	const contexts = await loadRestContexts(
		members.map((member) => member.id),
		{
			id: department.id,
			name: department.name,
			restGroupsEnabled: department.restGroupsEnabled,
		},
	);

	const dates = eachDayOfInterval({
		start: parseISO(range.from),
		end: parseISO(range.to),
	}).map((date) => format(date, "yyyy-MM-dd"));

	const days = dates.map((date) => ({
		date,
		people: members.flatMap((member) => {
			const context = contexts.get(member.id) ?? NO_REST_CONTEXT;
			const resolution = resolveRestDaysAt(context, date);
			if (!isRestDate(resolution.daysOfWeek, date)) return [];
			return [
				{
					userId: member.id,
					fullName: member.fullName,
					source: resolution.source,
					groupName: resolution.group?.name ?? null,
				},
			];
		}),
	}));

	const today = await todayFor(departmentId);
	const withoutRestDays = members
		.filter(
			(member) =>
				resolveRestDaysAt(contexts.get(member.id) ?? NO_REST_CONTEXT, today)
					.daysOfWeek.length === 0,
		)
		.map((member) => ({ userId: member.id, fullName: member.fullName }));

	return {
		departmentId,
		restGroupsEnabled: department.restGroupsEnabled,
		from: range.from,
		to: range.to,
		days,
		withoutRestDays,
	};
}

// ── El recordatorio (RN-10.10) ────────────────────────────────────────────────

const REMINDER_TYPE = "rest_schedule.missing" as const;
const reminderKey = (userId: string) => `rest_schedule:${userId}`;

/** El recordatorio deja de tener sentido en cuanto la persona tiene descansos. */
async function clearRestReminder(
	tx: Database,
	userIds: readonly string[],
): Promise<void> {
	if (userIds.length === 0) return;
	await tx
		.delete(notifications)
		.where(
			and(
				inArray(notifications.userId, [...userIds]),
				eq(notifications.type, REMINDER_TYPE),
			),
		);
}

/**
 * RN-10.10 — Recordatorio de descansos sin configurar.
 *
 * ⚠️ **Hallazgo H-4**: en el legacy esta regla vivía en el contexto de
 * notificaciones del frontend, así que sólo se disparaba si la persona abría la
 * aplicación y no dejaba rastro si no lo hacía. Aquí la evalúa el servidor al
 * iniciar sesión, que es una de las dos formas que la spec admite.
 *
 * Se **actualiza, no se duplica** (spec 14 §5): un `dedupeKey` por persona deja
 * una sola notificación viva. Y el texto dice **quién** puede arreglarlo, que
 * cambia según el modelo del departamento: en modo individual lo arregla la
 * persona; con grupos activados sólo su jefe puede asignarla, y decirle "elige tus
 * días" sería mandarla a una pantalla donde no puede hacer nada (RN-05.10).
 *
 * Nunca lanza: es un aviso, y un fallo aquí no puede impedir un inicio de sesión.
 */
export async function remindMissingRestSchedule(
	profile: RestProfile,
	role: AppRole,
): Promise<void> {
	try {
		// Sólo empleados y jefes, que son quienes descansan: el gestor global no
		// marca (RN-03.4) y sin departamento el aviso pendiente es otro (RN-02.12).
		if (role !== "employee" && role !== "department_head") return;
		if (!profile.departmentId) return;

		const department = await departmentSnapshotOf(profile.departmentId);
		const context = await loadRestContext(profile.id, department);
		const today = await todayFor(profile.departmentId);
		const resolution = resolveRestDaysAt(context, today);

		if (resolution.daysOfWeek.length > 0) {
			await clearRestReminder(db, [profile.id]);
			return;
		}

		const byGroups = department?.restGroupsEnabled ?? false;

		await notify(db, [profile.id], {
			type: REMINDER_TYPE,
			title: "No tienes días de descanso configurados",
			body: byGroups
				? "Tu departamento organiza los descansos por grupos y todavía no estás en ninguno, así que se te exige asistencia todos los días laborables. Pídele a tu jefe que te asigne un grupo."
				: "Mientras no elijas tus días, se te exige asistencia todos los días laborables del calendario. Elígelos en Mi perfil.",
			actionUrl: byGroups ? null : "/profile",
			dedupeKey: reminderKey(profile.id),
		});
	} catch (error) {
		console.error(
			"No se pudo evaluar el recordatorio de descansos (RN-10.10):",
			error,
		);
	}
}
