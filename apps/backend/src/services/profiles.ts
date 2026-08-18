import type { AppRole, SessionProfile } from "@elineas/validations";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	departments,
	profiles,
	userDepartmentResponsibilities,
} from "#/db/schema";
import type { IdentityUser } from "#/lib/identity";
import { audit, type Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";
import { notify } from "#/services/notifications.ts";

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

	return db.transaction(async (tx) => {
		const [created] = await tx
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

		// RN-02.12: el alta la pueden hacer dos personas distintas —quien administra
		// el IS y quien gestiona la asistencia—, así que la aparición de un perfil
		// incompleto se **avisa**, no sólo se lista. Va en la misma transacción que
		// la creación: o hay perfil y aviso, o no hay ninguno de los dos.
		await notify(tx, await globalManagerRecipients(tx), {
			type: "profile.incomplete",
			title: "Hay una cuenta pendiente de configurar",
			body: `${created.fullName} (${created.email}) entró por primera vez y todavía no tiene departamento asignado, así que no puede registrar asistencia.`,
			actionUrl: "/users",
			// Un aviso por persona: si nadie lo atiende, no se acumulan copias.
			dedupeKey: `profile-incomplete:${created.id}`,
		});

		return created;
	});
}

/**
 * A quién avisar de algo que compete a los gestores globales.
 *
 * El IS no tiene API de administración: no se le puede preguntar quién tiene el rol
 * `global_manager` (sólo responde por el usuario de la sesión en curso), y guardar
 * los roles aquí está prohibido (RN-00.29). La única lista de gestores que este
 * sistema puede conocer son los miembros activos del departamento configurado en
 * `global_manager_department_id`, donde RN-03.6 los concentra.
 *
 * Si esa clave no está configurada no hay a quién avisar: se devuelve vacío y el
 * aviso simplemente no se crea. La pantalla de usuarios lo advierte para que no
 * parezca que el aviso se perdió.
 */
export async function globalManagerRecipients(tx: Database): Promise<string[]> {
	const { global_manager_department_id: departmentId } = await getConfig();
	if (!departmentId) return [];

	const rows = await tx
		.select({ id: profiles.id })
		.from(profiles)
		.where(
			and(eq(profiles.departmentId, departmentId), eq(profiles.isActive, true)),
		);

	return rows.map((row) => row.id);
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

/** Nombre del departamento de un perfil, o nulo si no tiene ninguno. */
export async function departmentNameOf(
	departmentId: string | null,
): Promise<string | null> {
	if (!departmentId) return null;

	const row = await db.query.departments.findFirst({
		where: eq(departments.id, departmentId),
		columns: { name: true },
	});
	return row?.name ?? null;
}

/**
 * Proyección del perfil que sale por la API: sin sueldo ni datos de baja.
 *
 * El nombre del departamento se pasa resuelto en vez de leerlo aquí para que esta
 * función siga siendo pura: la usan el login y la sonda de sesión, y ninguna de las
 * dos quiere una consulta escondida dentro de un mapeo.
 */
export function toSessionProfile(
	profile: ProfileRow,
	departmentName: string | null,
): SessionProfile {
	return {
		id: profile.id,
		fullName: profile.fullName,
		email: profile.email,
		departmentId: profile.departmentId,
		departmentName,
		phone: profile.phone,
		isActive: profile.isActive,
		isComplete: profile.departmentId !== null,
	};
}

/**
 * RN-02.7 — `last_connection_at` se escribe **como mucho una vez cada 5 minutos**
 * por perfil.
 *
 * Se llama en cada petición autenticada, que es lo que hace útil el dato: sin eso
 * sólo reflejaría el último login y no cuándo estuvo alguien de verdad. El
 * throttle evita una escritura por render, que es lo que golpeaba la base en el
 * legacy.
 *
 * El registro de cuándo se escribió por última vez es de proceso, como la caché de
 * roles: si el backend se reinicia, la primera petición vuelve a escribir. Es un
 * dato informativo, no un contador exacto.
 */
const LAST_CONNECTION_THROTTLE_MS = 5 * 60 * 1000;

const lastConnectionWrites = new Map<string, number>();

export async function touchLastConnection(profileId: string) {
	const now = Date.now();
	const previous = lastConnectionWrites.get(profileId);
	if (previous !== undefined && now - previous < LAST_CONNECTION_THROTTLE_MS) {
		return;
	}

	lastConnectionWrites.set(profileId, now);
	await db
		.update(profiles)
		.set({ lastConnectionAt: new Date(now) })
		.where(eq(profiles.id, profileId));
}

/**
 * RN-03.6 — Departamento forzado para `global_manager`.
 *
 * En el legacy esto era el trigger `enforce_gm_department`, que movía el perfil al
 * departamento cuyo **nombre** fuera "Administración". Aquí la regla se conserva
 * pero el destino es **configurable por id** (`global_manager_department_id`,
 * spec 06): un literal en el código atado a un nombre que cualquiera puede
 * renombrar era justo la trampa que la spec 01 §3 señala.
 *
 * Se aplica al resolver la sesión, que es el único momento en el que este sistema
 * conoce los roles de alguien — los roles viven en el Identity Server y aquí no se
 * almacenan (RN-00.29). Si la clave no está configurada, la regla está desactivada
 * y el perfil se queda como esté.
 *
 * El cambio se audita con actor `null`: lo hizo el sistema aplicando una regla, no
 * una persona.
 */
export async function enforceGlobalManagerDepartment(
	profile: ProfileRow,
	roles: readonly AppRole[],
): Promise<ProfileRow> {
	if (!roles.includes("global_manager")) return profile;

	const { global_manager_department_id: target } = await getConfig();
	if (!target || profile.departmentId === target) return profile;

	// Si la configuración apunta a un departamento que ya no existe, la regla se
	// salta en vez de reventar. Escribirlo daría un 500 a **todos** los gestores
	// globales en cada petición, dejándolos fuera del sistema por un dato mal
	// puesto. El borrado de ese departamento está bloqueado (spec 01), así que
	// llegar aquí significa que alguien lo tocó por debajo de la aplicación.
	const exists = await db.query.departments.findFirst({
		where: eq(departments.id, target),
		columns: { id: true },
	});
	if (!exists) {
		console.error(
			`RN-03.6: global_manager_department_id apunta a un departamento inexistente (${target}). La regla no se aplica.`,
		);
		return profile;
	}

	return db.transaction(async (tx) => {
		const [updated] = await tx
			.update(profiles)
			.set({ departmentId: target, updatedAt: new Date() })
			.where(eq(profiles.id, profile.id))
			.returning();

		await audit(tx, {
			actorId: null,
			action: "profile.department_changed",
			tableName: "profiles",
			recordId: profile.id,
			oldData: { departmentId: profile.departmentId },
			newData: { departmentId: target },
			metadata: { rule: "RN-03.6" },
		});

		return updated ?? profile;
	});
}
