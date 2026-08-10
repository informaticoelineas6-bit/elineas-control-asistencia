import type { SessionProfile } from "@elineas/validations";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { profiles, userDepartmentResponsibilities } from "#/db/schema";
import type { IdentityUser } from "#/lib/identity";

type ProfileRow = typeof profiles.$inferSelect;

/**
 * Perfil de la identidad autenticada, creándolo si es su primer ingreso.
 *
 * RN-00.46 / RN-02.1: quien está autenticado en el IS pero no tiene perfil aquí
 * obtiene uno **incompleto** (sin departamento) y el sistema lo lleva a "cuenta
 * pendiente de configurar". No se le deja marcar hasta que un administrador se
 * lo asigne. La alternativa —prohibir el acceso hasta que exista perfil— sigue
 * siendo decisión abierta de la spec; si se cambia, se cambia aquí.
 */
export async function findOrCreateProfile(
	user: IdentityUser,
): Promise<ProfileRow> {
	const existing = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, user.identityUserId),
	});

	if (existing) {
		// El correo es copia desnormalizada del IS: se mantiene sincronizada
		// (spec 02 §3). El vínculo sigue siendo el `sub`, no el correo.
		if (existing.email !== user.email) {
			const [updated] = await db
				.update(profiles)
				.set({ email: user.email, updatedAt: new Date() })
				.where(eq(profiles.id, existing.id))
				.returning();
			return updated ?? existing;
		}
		return existing;
	}

	const [created] = await db
		.insert(profiles)
		.values({
			identityUserId: user.identityUserId,
			email: user.email,
			fullName: user.name ?? user.email,
			departmentId: null,
		})
		.returning();

	if (!created) {
		throw new Error("No se pudo crear el perfil del usuario autenticado.");
	}
	return created;
}

/**
 * Ámbito de un `department_head` (RN-03.2): su propio departamento **más** los
 * adicionales de `user_department_responsibilities`.
 *
 * Se calcula en un solo sitio a propósito: en el legacy la comprobación de
 * ámbito estaba repetida por endpoint y con los argumentos invertidos en varias
 * migraciones (hallazgo H-1).
 */
export async function getManagedDepartmentIds(
	profile: ProfileRow,
): Promise<string[]> {
	const extra = await db
		.select({ departmentId: userDepartmentResponsibilities.departmentId })
		.from(userDepartmentResponsibilities)
		.where(eq(userDepartmentResponsibilities.userId, profile.id));

	const ids = new Set(extra.map((row) => row.departmentId));
	if (profile.departmentId) ids.add(profile.departmentId);
	return [...ids];
}

/** Proyección del perfil que sale por la API: sin sueldo ni datos de baja. */
export function toSessionProfile(profile: ProfileRow): SessionProfile {
	return {
		id: profile.id,
		fullName: profile.fullName,
		email: profile.email,
		departmentId: profile.departmentId,
		phone: profile.phone,
		isActive: profile.isActive,
		isComplete: profile.departmentId !== null,
	};
}

export async function touchLastConnection(profileId: string) {
	await db
		.update(profiles)
		.set({ lastConnectionAt: new Date() })
		.where(eq(profiles.id, profileId));
}
