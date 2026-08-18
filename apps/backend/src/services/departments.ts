import type {
	CreateDepartmentInput,
	Department,
	DepartmentMember,
	DepartmentSummary,
	UpdateDepartmentInput,
} from "@elineas/validations";
import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import {
	departments,
	profiles,
	userDepartmentResponsibilities,
} from "#/db/schema";
import { audit, type Database } from "#/services/audit.ts";
import { configKeysReferencing, getConfig } from "#/services/config.ts";
import { notify } from "#/services/notifications.ts";

/**
 * Departamentos (spec 01). El ancla organizativa del sistema.
 *
 * Todas las mutaciones abren transacción y escriben su entrada de bitácora
 * **dentro** de ella (RN-18.4): si el cambio se revierte, su rastro también.
 * Las que afectan al marcaje de la gente avisan además a los miembros (spec 01
 * §5.1, spec 14 §4).
 */

type DepartmentRow = typeof departments.$inferSelect;

export type Actor = {
	profileId: string;
	sourceIp?: string | null;
};

function toDepartment(row: DepartmentRow): Department {
	return {
		id: row.id,
		name: row.name,
		restGroupsEnabled: row.restGroupsEnabled,
		isPaused: row.isPaused,
		pauseReason: row.pauseReason,
		pausedAt: row.pausedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Conteo de miembros en la misma consulta que el departamento. `activeMemberCount`
 * se separa del total porque son dos preguntas distintas: cuánta gente cuelga de
 * aquí (lo que bloquea el borrado, RN-01.2) y cuánta está operativa.
 */
const summaryColumns = {
	...getTableColumns(departments),
	memberCount: sql<number>`count(${profiles.id})::int`,
	activeMemberCount: sql<number>`(count(${profiles.id}) filter (where ${profiles.isActive}))::int`,
};

type SummaryRow = DepartmentRow & {
	memberCount: number;
	activeMemberCount: number;
};

function toSummary(
	row: SummaryRow,
	globalManagerDepartmentId: string | null,
): DepartmentSummary {
	return {
		...toDepartment(row),
		memberCount: row.memberCount,
		activeMemberCount: row.activeMemberCount,
		isGlobalManagerDepartment: row.id === globalManagerDepartmentId,
	};
}

export async function listDepartments(options: {
	includePaused: boolean;
}): Promise<DepartmentSummary[]> {
	const query = db
		.select(summaryColumns)
		.from(departments)
		.leftJoin(profiles, eq(profiles.departmentId, departments.id))
		.groupBy(departments.id)
		.orderBy(asc(departments.name));

	const rows = options.includePaused
		? await query
		: await query.having(sql`bool_and(not ${departments.isPaused})`);

	const config = await getConfig();
	return rows.map((row) => toSummary(row, config.global_manager_department_id));
}

export async function getDepartmentSummary(
	id: string,
): Promise<DepartmentSummary | null> {
	const [row] = await db
		.select(summaryColumns)
		.from(departments)
		.leftJoin(profiles, eq(profiles.departmentId, departments.id))
		.where(eq(departments.id, id))
		.groupBy(departments.id);

	if (!row) return null;

	const config = await getConfig();
	return toSummary(row, config.global_manager_department_id);
}

/** 404 en un solo sitio, con el mismo mensaje en todas las operaciones. */
async function requireDepartment(id: string): Promise<DepartmentRow> {
	const row = await db.query.departments.findFirst({
		where: eq(departments.id, id),
	});
	if (!row) {
		throw new HTTPException(404, { message: "Ese departamento no existe." });
	}
	return row;
}

/**
 * Miembros del departamento. **Nunca incluye `monthlySalary`**: este endpoint lo
 * consume `department_head` y el dato salarial no sale de `global_manager+`
 * (spec 02 §6).
 */
export async function listMembers(
	departmentId: string,
): Promise<DepartmentMember[]> {
	return db
		.select({
			id: profiles.id,
			fullName: profiles.fullName,
			email: profiles.email,
			phone: profiles.phone,
			isActive: profiles.isActive,
		})
		.from(profiles)
		.where(eq(profiles.departmentId, departmentId))
		.orderBy(asc(profiles.fullName));
}

/**
 * RN-01.1. La unicidad la garantiza la base con un índice sobre `lower(name)`;
 * esta comprobación existe para dar un **mensaje legible** antes de chocar con
 * ella (criterio de aceptación: "falla con error legible").
 *
 * Se compara sin distinguir mayúsculas porque "Transporte" y "transporte" son el
 * mismo departamento para quien lo lee en un selector.
 */
async function assertNameAvailable(name: string, exceptId?: string) {
	const clash = await db
		.select({ id: departments.id })
		.from(departments)
		.where(sql`lower(${departments.name}) = lower(${name})`);

	if (clash.some((row) => row.id !== exceptId)) {
		throw new HTTPException(409, {
			message: `Ya existe un departamento llamado "${name}".`,
		});
	}
}

/** Choque con el índice único, si dos peticiones simultáneas ganan la carrera. */
function isUniqueViolation(error: unknown): boolean {
	const code = (error as { code?: string; cause?: { code?: string } })?.code;
	const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
	return code === "23505" || causeCode === "23505";
}

export async function createDepartment(
	input: CreateDepartmentInput,
	actor: Actor,
): Promise<Department> {
	await assertNameAvailable(input.name);

	try {
		return await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(departments)
				.values({ name: input.name })
				.returning();

			if (!created) {
				throw new HTTPException(500, {
					message: "No se pudo crear el departamento.",
				});
			}

			await audit(tx, {
				actorId: actor.profileId,
				action: "department.created",
				tableName: "departments",
				recordId: created.id,
				newData: toDepartment(created),
				sourceIp: actor.sourceIp,
			});

			return toDepartment(created);
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new HTTPException(409, {
				message: `Ya existe un departamento llamado "${input.name}".`,
			});
		}
		throw error;
	}
}

export async function updateDepartment(
	id: string,
	patch: UpdateDepartmentInput,
	actor: Actor,
): Promise<Department> {
	const before = await requireDepartment(id);

	const renaming = patch.name !== undefined && patch.name !== before.name;
	const togglingRestGroups =
		patch.restGroupsEnabled !== undefined &&
		patch.restGroupsEnabled !== before.restGroupsEnabled;

	if (renaming && patch.name) await assertNameAvailable(patch.name, id);

	if (!renaming && !togglingRestGroups) return toDepartment(before);

	return db.transaction(async (tx) => {
		const [updated] = await tx
			.update(departments)
			.set({
				...(renaming ? { name: patch.name } : {}),
				...(togglingRestGroups
					? { restGroupsEnabled: patch.restGroupsEnabled }
					: {}),
				updatedAt: new Date(),
			})
			.where(eq(departments.id, id))
			.returning();

		if (!updated) {
			throw new HTTPException(404, { message: "Ese departamento no existe." });
		}

		if (renaming) {
			await audit(tx, {
				actorId: actor.profileId,
				action: "department.renamed",
				tableName: "departments",
				recordId: id,
				oldData: { name: before.name },
				newData: { name: updated.name },
				sourceIp: actor.sourceIp,
			});
		}

		// RN-01.6: apagar los grupos de descanso **no** los borra; sólo deja de
		// usarlos para resolver los descansos (spec 10). Por eso aquí no hay
		// ningún borrado, sólo el rastro del cambio.
		if (togglingRestGroups) {
			await audit(tx, {
				actorId: actor.profileId,
				action: "department.rest_groups_changed",
				tableName: "departments",
				recordId: id,
				oldData: { restGroupsEnabled: before.restGroupsEnabled },
				newData: { restGroupsEnabled: updated.restGroupsEnabled },
				sourceIp: actor.sourceIp,
			});
		}

		return toDepartment(updated);
	});
}

/** Miembros activos: los que hay que avisar de una pausa o una reanudación. */
async function activeMemberIds(
	tx: Database,
	departmentId: string,
): Promise<string[]> {
	const rows = await tx
		.select({ id: profiles.id })
		.from(profiles)
		.where(
			sql`${profiles.departmentId} = ${departmentId} and ${profiles.isActive}`,
		);
	return rows.map((row) => row.id);
}

/**
 * RN-01.3 + flujo §5.1. El motivo es obligatorio (lo garantiza el esquema) y
 * `pausedAt` toma el instante de la pausa.
 *
 * Mientras esté pausado, **todo intento de marcaje de un miembro se rechaza con
 * el motivo** (RN-01.4). Ese rechazo vive en la spec 09, que aún no existe; la
 * comprobación reutilizable para cuando llegue es `assertDepartmentNotPaused`.
 */
export async function pauseDepartment(
	id: string,
	reason: string,
	actor: Actor,
): Promise<Department> {
	const before = await requireDepartment(id);
	if (before.isPaused) {
		throw new HTTPException(409, {
			message: "Ese departamento ya está en pausa.",
		});
	}

	return db.transaction(async (tx) => {
		const pausedAt = new Date();
		const [updated] = await tx
			.update(departments)
			.set({
				isPaused: true,
				pauseReason: reason,
				pausedAt,
				updatedAt: pausedAt,
			})
			.where(eq(departments.id, id))
			.returning();

		if (!updated) {
			throw new HTTPException(404, { message: "Ese departamento no existe." });
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "department.paused",
			tableName: "departments",
			recordId: id,
			oldData: { isPaused: false },
			newData: { isPaused: true, pauseReason: reason },
			metadata: { reason },
			sourceIp: actor.sourceIp,
		});

		await notify(tx, await activeMemberIds(tx, id), {
			type: "department.paused",
			title: `${updated.name} está en pausa`,
			body: `No podrás registrar asistencia mientras dure la pausa. Motivo: ${reason}`,
			actionUrl: "/attendance",
		});

		return toDepartment(updated);
	});
}

/**
 * RN-01.5. Al reanudar se limpian los tres campos. **No se recuperan
 * retroactivamente los marcajes bloqueados** durante la pausa: si hacen falta,
 * se corrigen vía incidencias (spec 12).
 */
export async function resumeDepartment(
	id: string,
	actor: Actor,
): Promise<Department> {
	const before = await requireDepartment(id);
	if (!before.isPaused) {
		throw new HTTPException(409, {
			message: "Ese departamento no está en pausa.",
		});
	}

	return db.transaction(async (tx) => {
		const [updated] = await tx
			.update(departments)
			.set({
				isPaused: false,
				pauseReason: null,
				pausedAt: null,
				updatedAt: new Date(),
			})
			.where(eq(departments.id, id))
			.returning();

		if (!updated) {
			throw new HTTPException(404, { message: "Ese departamento no existe." });
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "department.resumed",
			tableName: "departments",
			recordId: id,
			oldData: {
				isPaused: true,
				pauseReason: before.pauseReason,
				pausedAt: before.pausedAt?.toISOString() ?? null,
			},
			newData: { isPaused: false },
			sourceIp: actor.sourceIp,
		});

		await notify(tx, await activeMemberIds(tx, id), {
			type: "department.resumed",
			title: `${updated.name} vuelve a estar activo`,
			body: "Ya puedes registrar asistencia con normalidad.",
			actionUrl: "/attendance",
		});

		return toDepartment(updated);
	});
}

/**
 * RN-01.2 + flujo §5.2. Falla con un mensaje explícito, **nunca borra en
 * cascada**.
 *
 * Bloquea con **cualquier** perfil asociado, activo o no: el historial de quien
 * ya no trabaja aquí sigue necesitando su ancla organizativa, y la clave ajena de
 * `profiles.department_id` lo impediría igualmente. Antes que borrar, se
 * reasigna.
 *
 * Cuando existan horarios (spec 07) y grupos de descanso (spec 10), sus
 * comprobaciones van aquí: el flujo §5.2 las pide explícitamente.
 */
export async function deleteDepartment(
	id: string,
	actor: Actor,
): Promise<void> {
	const before = await requireDepartment(id);

	const [{ count: memberCount } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(profiles)
		.where(eq(profiles.departmentId, id));

	if (memberCount > 0) {
		throw new HTTPException(409, {
			message:
				memberCount === 1
					? "No se puede eliminar: hay 1 persona asignada a este departamento. Reasígnala antes de borrarlo."
					: `No se puede eliminar: hay ${memberCount} personas asignadas a este departamento. Reasígnalas antes de borrarlo.`,
		});
	}

	const [{ count: responsibilityCount } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(userDepartmentResponsibilities)
		.where(eq(userDepartmentResponsibilities.departmentId, id));

	if (responsibilityCount > 0) {
		throw new HTTPException(409, {
			message:
				"No se puede eliminar: hay jefes con responsabilidad sobre este departamento. Quítasela antes de borrarlo.",
		});
	}

	// Spec 01 §3: un departamento al que apunta la configuración no puede
	// eliminarse mientras lo haga (RN-03.6, RN-10.5). Con las referencias
	// guardadas por id, borrarlo dejaría esas reglas apuntando al vacío.
	const configKeys = await configKeysReferencing(id);
	if (configKeys.length > 0) {
		const reason = configKeys.includes("global_manager_department_id")
			? "es el departamento de los gestores globales"
			: "la configuración global lo tiene referenciado";
		throw new HTTPException(409, {
			message: `No se puede eliminar: ${reason}. Cambia esa configuración antes de borrarlo.`,
		});
	}

	await db.transaction(async (tx) => {
		await tx.delete(departments).where(eq(departments.id, id));

		await audit(tx, {
			actorId: actor.profileId,
			action: "department.deleted",
			tableName: "departments",
			recordId: id,
			oldData: toDepartment(before),
			sourceIp: actor.sourceIp,
		});
	});
}

/**
 * RN-01.4, lista para la spec 09: un miembro de un departamento en pausa no
 * puede marcar, y el rechazo lleva el motivo.
 *
 * La pausa **no** afecta vacaciones, incidencias ni consultas de historial, así
 * que esta comprobación se invoca sólo en el marcaje, no en el middleware.
 */
export async function assertDepartmentNotPaused(
	departmentId: string,
): Promise<void> {
	const department = await requireDepartment(departmentId);
	if (department.isPaused) {
		throw new HTTPException(409, {
			message: `Tu departamento está en pausa: ${department.pauseReason ?? "sin motivo registrado"}`,
		});
	}
}
