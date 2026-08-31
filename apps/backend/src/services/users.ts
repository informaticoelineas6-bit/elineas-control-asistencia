import type {
	Compensation,
	DeactivateUserInput,
	OwnProfile,
	ProfileStatus,
	UpdateCompensationInput,
	UpdateOwnProfileInput,
	UpdateUserInput,
	UserProfile,
} from "@elineas/validations";
import { currencySchema, DEFAULT_CURRENCY } from "@elineas/validations";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import {
	appConfig,
	departments,
	employeeCompensation,
	profiles,
} from "#/db/schema";
import { audit } from "#/services/audit.ts";
import { notify } from "#/services/notifications.ts";

/**
 * Usuarios y perfiles (spec 02).
 *
 * Lo que vive aquí es el **perfil de negocio**; la identidad es del Identity
 * Server. Este servicio no crea cuentas ni toca credenciales (RN-00.28): el alta
 * es de dos pasos y esto cubre el segundo — asignar departamento y datos de
 * contacto — más el ciclo de vida operativo (desactivar, reactivar, borrar).
 *
 * **El sueldo se trata aparte**, en `employee_compensation` y con sus propias
 * funciones. Ninguna proyección de perfil lo incluye, y no puede incluirlo: no
 * está en la tabla (spec 02 §6a, hallazgo H-3).
 */

type ProfileRow = typeof profiles.$inferSelect;

export type Actor = {
	profileId: string;
	sourceIp?: string | null;
};

function statusOf(row: ProfileRow): ProfileStatus {
	if (!row.isActive) return "inactive";
	return row.departmentId === null ? "incomplete" : "active";
}

/** Proyección explícita: se enumeran las columnas, nunca `select *`. */
const profileColumns = {
	id: profiles.id,
	email: profiles.email,
	fullName: profiles.fullName,
	departmentId: profiles.departmentId,
	phone: profiles.phone,
	isActive: profiles.isActive,
	deactivatedAt: profiles.deactivatedAt,
	deactivationReason: profiles.deactivationReason,
	contractCancelledAt: profiles.contractCancelledAt,
	lastConnectionAt: profiles.lastConnectionAt,
	createdAt: profiles.createdAt,
} as const;

type ProfileProjection = {
	[K in keyof typeof profileColumns]: ProfileRow[K];
};

function toUserProfile(
	row: ProfileProjection,
	departmentName: string | null,
): UserProfile {
	return {
		id: row.id,
		email: row.email,
		fullName: row.fullName,
		departmentId: row.departmentId,
		departmentName,
		phone: row.phone,
		status: statusOf(row as ProfileRow),
		isActive: row.isActive,
		isComplete: row.departmentId !== null,
		deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
		deactivationReason: row.deactivationReason,
		contractCancelledAt: row.contractCancelledAt?.toISOString() ?? null,
		lastConnectionAt: row.lastConnectionAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

const withDepartment = () =>
	db
		.select({ ...profileColumns, departmentName: departments.name })
		.from(profiles)
		.leftJoin(departments, eq(departments.id, profiles.departmentId));

/**
 * Listado, acotado al ámbito de quien pregunta.
 *
 * El filtro de ámbito se aplica **en la consulta**, no descartando filas después:
 * un `department_head` no recibe de la base los perfiles que no le tocan. Los
 * perfiles incompletos (sin departamento) no caen en el ámbito de ningún jefe —
 * por definición no pertenecen a un departamento suyo — y sólo los ve un gestor
 * global en su propia vista (RN-02.3).
 */
export async function listUsers(
	scope: { managedDepartmentIds: string[] | "all" },
	filters: {
		departmentId?: string;
		includeInactive: boolean;
		search?: string;
	},
): Promise<UserProfile[]> {
	const conditions = [];

	if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return [];
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}

	if (filters.departmentId) {
		conditions.push(eq(profiles.departmentId, filters.departmentId));
	}
	if (!filters.includeInactive) {
		conditions.push(eq(profiles.isActive, true));
	}
	if (filters.search) {
		const pattern = `%${filters.search}%`;
		conditions.push(
			or(
				sql`${profiles.fullName} ilike ${pattern}`,
				sql`${profiles.email} ilike ${pattern}`,
			),
		);
	}

	const rows = await withDepartment()
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(profiles.fullName));

	return rows.map((row) => toUserProfile(row, row.departmentName));
}

/**
 * Perfiles incompletos (RN-02.3): el alta que quedó a medias entre la consola del
 * IS y esta aplicación. Sin esta vista, la gente se pierde en el alta de dos pasos.
 */
export async function listIncompleteUsers(): Promise<UserProfile[]> {
	const rows = await withDepartment()
		.where(and(isNull(profiles.departmentId), eq(profiles.isActive, true)))
		.orderBy(asc(profiles.createdAt));

	return rows.map((row) => toUserProfile(row, row.departmentName));
}

export async function getUser(id: string): Promise<UserProfile | null> {
	const [row] = await withDepartment().where(eq(profiles.id, id));
	return row ? toUserProfile(row, row.departmentName) : null;
}

/** El perfil crudo, para las comprobaciones de ámbito de los handlers. */
export async function getProfileRow(id: string): Promise<ProfileRow> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.id, id),
	});
	if (!row) {
		throw new HTTPException(404, { message: "Ese perfil no existe." });
	}
	return row;
}

async function requireUser(id: string): Promise<UserProfile> {
	const user = await getUser(id);
	if (!user) {
		throw new HTTPException(404, { message: "Ese perfil no existe." });
	}
	return user;
}

/** Perfil propio (`GET /api/me`). Sin datos de baja y sin sueldo. */
export async function getOwnProfile(profileId: string): Promise<OwnProfile> {
	const user = await requireUser(profileId);
	return {
		id: user.id,
		email: user.email,
		fullName: user.fullName,
		departmentId: user.departmentId,
		departmentName: user.departmentName,
		phone: user.phone,
		isComplete: user.isComplete,
		contractCancelledAt: user.contractCancelledAt,
		lastConnectionAt: user.lastConnectionAt,
		createdAt: user.createdAt,
	};
}

/**
 * Lo único que cada persona cambia de sí misma (spec 02 §2). Nombre y correo no:
 * son de la identidad y se sincronizan desde el IS.
 */
export async function updateOwnProfile(
	profileId: string,
	patch: UpdateOwnProfileInput,
	actor: Actor,
): Promise<OwnProfile> {
	const before = await getProfileRow(profileId);
	// El esquema ya normalizó el vacío a nulo y validó el formato internacional.
	const phone = patch.phone;

	if (phone === before.phone) return getOwnProfile(profileId);

	await db.transaction(async (tx) => {
		await tx
			.update(profiles)
			.set({ phone, updatedAt: new Date() })
			.where(eq(profiles.id, profileId));

		await audit(tx, {
			actorId: actor.profileId,
			action: "profile.contact_updated",
			tableName: "profiles",
			recordId: profileId,
			oldData: { phone: before.phone },
			newData: { phone },
			sourceIp: actor.sourceIp,
		});
	});

	return getOwnProfile(profileId);
}

/**
 * Cambios que hace un gestor global sobre otro perfil: departamento, teléfono y
 * fecha de baja contractual.
 *
 * Asignar departamento es el **paso 2 del alta** (§5.1) y por eso se audita
 * (RN-02.11). Cuando ese cambio es el que completa el perfil, se avisa a la
 * persona: es el momento en que pasa de "cuenta pendiente" a poder marcar, y es lo
 * que cierra el alta de dos pasos.
 *
 * Cambiar el departamento **no reescribe el historial** (RN-02.9): los marcajes
 * pasados conservarán el departamento que estuviera vigente, porque cada marcaje lo
 * guardará consigo cuando exista la spec 09.
 */
export async function updateUser(
	id: string,
	patch: UpdateUserInput,
	actor: Actor,
): Promise<UserProfile> {
	const before = await getProfileRow(id);

	const changingDepartment =
		patch.departmentId !== undefined &&
		patch.departmentId !== before.departmentId;
	const changingPhone =
		patch.phone !== undefined && patch.phone !== before.phone;
	const changingContract =
		patch.contractCancelledAt !== undefined &&
		(patch.contractCancelledAt ?? null) !==
			(before.contractCancelledAt?.toISOString() ?? null);

	if (!changingDepartment && !changingPhone && !changingContract) {
		return requireUser(id);
	}

	if (changingDepartment && patch.departmentId) {
		const exists = await db.query.departments.findFirst({
			where: eq(departments.id, patch.departmentId),
			columns: { id: true },
		});
		if (!exists) {
			throw new HTTPException(400, { message: "Ese departamento no existe." });
		}
	}

	await db.transaction(async (tx) => {
		await tx
			.update(profiles)
			.set({
				...(changingDepartment ? { departmentId: patch.departmentId } : {}),
				...(changingPhone ? { phone: patch.phone } : {}),
				...(changingContract
					? {
							contractCancelledAt: patch.contractCancelledAt
								? new Date(patch.contractCancelledAt)
								: null,
						}
					: {}),
				updatedAt: new Date(),
			})
			.where(eq(profiles.id, id));

		if (changingDepartment) {
			await audit(tx, {
				actorId: actor.profileId,
				action: "profile.department_changed",
				tableName: "profiles",
				recordId: id,
				oldData: { departmentId: before.departmentId },
				newData: { departmentId: patch.departmentId },
				sourceIp: actor.sourceIp,
			});
		}
		if (changingPhone || changingContract) {
			await audit(tx, {
				actorId: actor.profileId,
				action: "profile.updated",
				tableName: "profiles",
				recordId: id,
				oldData: {
					phone: before.phone,
					contractCancelledAt:
						before.contractCancelledAt?.toISOString() ?? null,
				},
				newData: {
					...(changingPhone ? { phone: patch.phone } : {}),
					...(changingContract
						? { contractCancelledAt: patch.contractCancelledAt ?? null }
						: {}),
				},
				sourceIp: actor.sourceIp,
			});
		}

		// El alta queda cerrada: la persona ya puede marcar y merece saberlo.
		if (
			changingDepartment &&
			before.departmentId === null &&
			patch.departmentId
		) {
			const [department] = await tx
				.select({ name: departments.name })
				.from(departments)
				.where(eq(departments.id, patch.departmentId));

			await notify(tx, [id], {
				type: "profile.department_changed",
				title: "Tu cuenta ya está configurada",
				body: `Te asignaron al departamento ${department?.name ?? "asignado"}. Ya puedes registrar tu asistencia.`,
				actionUrl: "/attendance",
			});
		}
	});

	return requireUser(id);
}

/**
 * RN-02.4 / RN-02.5 — Desactivar **no es borrar**: el perfil conserva su historial
 * y deja de poder entrar aquí. El motivo es obligatorio y se guarda con la fecha y
 * el autor.
 *
 * **No se revoca la sesión en el Identity Server**, a propósito. RN-02.4 dice que
 * es una baja *de este sistema* y que la cuenta sigue sirviendo para otros sistemas
 * de Elineas; revocar allí lo echaría de todos. Su sesión aquí muere igual: el
 * middleware rechaza a un perfil inactivo en su siguiente petición y le limpia las
 * cookies (RN-00.30). Esto contradice el paso 2 del flujo §5.2 de la spec, que se
 * resolvió a favor de RN-02.4.
 */
export async function deactivateUser(
	id: string,
	input: DeactivateUserInput,
	actor: Actor,
): Promise<UserProfile> {
	const before = await getProfileRow(id);

	if (before.id === actor.profileId) {
		throw new HTTPException(409, {
			message: "No puedes desactivar tu propio perfil.",
		});
	}
	if (!before.isActive) {
		throw new HTTPException(409, {
			message: "Ese perfil ya está desactivado.",
		});
	}

	await db.transaction(async (tx) => {
		const deactivatedAt = new Date();
		await tx
			.update(profiles)
			.set({
				isActive: false,
				deactivatedAt,
				deactivatedBy: actor.profileId,
				deactivationReason: input.reason,
				updatedAt: deactivatedAt,
			})
			.where(eq(profiles.id, id));

		await audit(tx, {
			actorId: actor.profileId,
			action: "profile.deactivated",
			tableName: "profiles",
			recordId: id,
			oldData: { isActive: true },
			newData: { isActive: false, deactivationReason: input.reason },
			metadata: { reason: input.reason },
			sourceIp: actor.sourceIp,
		});
	});

	return requireUser(id);
}

/** RN-02.5: reactivar limpia motivo, fecha y autor. No toca nada en el IS. */
export async function reactivateUser(
	id: string,
	actor: Actor,
): Promise<UserProfile> {
	const before = await getProfileRow(id);
	if (before.isActive) {
		throw new HTTPException(409, { message: "Ese perfil ya está activo." });
	}

	await db.transaction(async (tx) => {
		await tx
			.update(profiles)
			.set({
				isActive: true,
				deactivatedAt: null,
				deactivatedBy: null,
				deactivationReason: null,
				updatedAt: new Date(),
			})
			.where(eq(profiles.id, id));

		await audit(tx, {
			actorId: actor.profileId,
			action: "profile.reactivated",
			tableName: "profiles",
			recordId: id,
			oldData: {
				isActive: false,
				deactivationReason: before.deactivationReason,
				deactivatedAt: before.deactivatedAt?.toISOString() ?? null,
			},
			newData: { isActive: true },
			sourceIp: actor.sourceIp,
		});
	});

	return requireUser(id);
}

/**
 * RN-02.8 — Borrado real del perfil, exclusivo de `superadmin`. **No borra la
 * cuenta del IS**: eso se hace allí.
 *
 * Exige que el perfil esté desactivado primero, y no por prudencia: si la cuenta
 * del IS sigue teniendo rol en este sistema, el perfil **volvería a crearse vacío**
 * en su siguiente ingreso (RN-02.1), perdiendo el departamento y los datos de
 * contacto sin que nadie se enterara. Desactivar es lo que impide ese regreso.
 *
 * Las dependencias se resuelven en orden: las que tienen cascada se van con él
 * (notificaciones, responsabilidades, compensación) y las que son punteros sueltos
 * se anulan a mano — `deactivated_by` no es clave ajena precisamente para que la
 * decisión de quién desactivó a otro sobreviva al borrado de este.
 */
export async function deleteUser(id: string, actor: Actor): Promise<void> {
	const before = await getProfileRow(id);

	if (before.id === actor.profileId) {
		throw new HTTPException(409, {
			message: "No puedes borrar tu propio perfil.",
		});
	}
	if (before.isActive) {
		throw new HTTPException(409, {
			message:
				"Desactiva el perfil antes de borrarlo: si su cuenta sigue teniendo rol en el Identity Server, volvería a crearse vacío en su siguiente ingreso.",
		});
	}

	await db.transaction(async (tx) => {
		await tx
			.update(profiles)
			.set({ deactivatedBy: null })
			.where(eq(profiles.deactivatedBy, id));

		await tx
			.update(appConfig)
			.set({ updatedBy: null })
			.where(eq(appConfig.updatedBy, id));

		await tx.delete(profiles).where(eq(profiles.id, id));

		await audit(tx, {
			actorId: actor.profileId,
			action: "profile.deleted",
			tableName: "profiles",
			recordId: id,
			oldData: {
				identityUserId: before.identityUserId,
				email: before.email,
				fullName: before.fullName,
				departmentId: before.departmentId,
			},
			sourceIp: actor.sourceIp,
		});
	});
}

/**
 * Compensación (spec 02 §6a). Vive en su propia tabla y sólo se lee y escribe por
 * aquí: es la única parte del código que menciona `employee_compensation`.
 *
 * Un perfil sin fila devuelve importe nulo en vez de 404: "no tiene sueldo
 * registrado" es una respuesta, no un error.
 */
export async function getCompensation(
	profileId: string,
): Promise<Compensation> {
	await getProfileRow(profileId);

	const [row] = await db
		.select()
		.from(employeeCompensation)
		.where(eq(employeeCompensation.profileId, profileId));

	return {
		profileId,
		monthlySalary: row?.monthlySalary ?? null,
		// Un perfil sin fila hereda la moneda por defecto: no tener sueldo registrado
		// no es lo mismo que no saber en qué moneda se pagaría.
		currency: currencySchema.catch(DEFAULT_CURRENCY).parse(row?.currency),
		updatedAt: row?.updatedAt?.toISOString() ?? null,
	};
}

/** El importe **sí** se registra en la bitácora: es justo el punto de auditarlo (RN-18.2). */
export async function setCompensation(
	profileId: string,
	input: UpdateCompensationInput,
	actor: Actor,
): Promise<Compensation> {
	await getProfileRow(profileId);
	const before = await getCompensation(profileId);

	await db.transaction(async (tx) => {
		const updatedAt = new Date();
		await tx
			.insert(employeeCompensation)
			.values({
				profileId,
				monthlySalary: input.monthlySalary,
				currency: input.currency,
				updatedBy: actor.profileId,
				updatedAt,
			})
			.onConflictDoUpdate({
				target: employeeCompensation.profileId,
				set: {
					monthlySalary: input.monthlySalary,
					currency: input.currency,
					updatedBy: actor.profileId,
					updatedAt,
				},
			});

		await audit(tx, {
			actorId: actor.profileId,
			action: "compensation.updated",
			tableName: "employee_compensation",
			recordId: profileId,
			oldData: {
				monthlySalary: before.monthlySalary,
				currency: before.currency,
			},
			newData: {
				monthlySalary: input.monthlySalary,
				currency: input.currency,
			},
			sourceIp: actor.sourceIp,
		});
	});

	return getCompensation(profileId);
}
