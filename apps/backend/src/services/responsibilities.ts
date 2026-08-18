import type {
	DepartmentResponsibilities,
	DepartmentScope,
} from "@elineas/validations";
import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import {
	departments,
	profiles,
	userDepartmentResponsibilities,
} from "#/db/schema";
import { audit } from "#/services/audit.ts";
import type { Actor } from "#/services/users.ts";

/**
 * Departamentos **adicionales** que gestiona un perfil (spec 03 §3).
 *
 * Es lo único de autorización que esta aplicación escribe. Los roles los otorga
 * el Identity Server y aquí no hay endpoint que los toque (RN-03.8); el ámbito,
 * en cambio, el IS no lo conoce (RN-00.43), así que vive en nuestra base y se
 * gestiona por aquí.
 *
 * El departamento **propio** del perfil no se guarda en la tabla aunque forme
 * parte del ámbito (RN-03.2): duplicarlo ahí crearía dos verdades, y en cuanto
 * alguien cambiara de departamento la fila vieja lo dejaría gestionando un sitio
 * en el que ya no está. La unión se calcula al resolver la sesión
 * (`getManagedDepartmentIds`), que es donde debe estar.
 */

async function requireProfile(profileId: string) {
	const profile = await db.query.profiles.findFirst({
		where: eq(profiles.id, profileId),
		columns: { id: true, departmentId: true },
	});
	if (!profile) {
		throw new HTTPException(404, { message: "Ese perfil no existe." });
	}
	return profile;
}

async function departmentById(
	id: string | null,
): Promise<DepartmentScope | null> {
	if (!id) return null;
	const row = await db.query.departments.findFirst({
		where: eq(departments.id, id),
		columns: { id: true, name: true },
	});
	return row ?? null;
}

async function additionalDepartments(
	profileId: string,
): Promise<DepartmentScope[]> {
	return db
		.select({ id: departments.id, name: departments.name })
		.from(userDepartmentResponsibilities)
		.innerJoin(
			departments,
			eq(departments.id, userDepartmentResponsibilities.departmentId),
		)
		.where(eq(userDepartmentResponsibilities.userId, profileId))
		.orderBy(asc(departments.name));
}

function toResponsibilities(
	profileId: string,
	ownDepartment: DepartmentScope | null,
	additional: DepartmentScope[],
): DepartmentResponsibilities {
	const ids = new Set(additional.map((department) => department.id));
	if (ownDepartment) ids.add(ownDepartment.id);

	return {
		profileId,
		ownDepartment,
		additionalDepartments: additional,
		managedDepartmentIds: [...ids],
	};
}

export async function getResponsibilities(
	profileId: string,
): Promise<DepartmentResponsibilities> {
	const profile = await requireProfile(profileId);
	return toResponsibilities(
		profile.id,
		await departmentById(profile.departmentId),
		await additionalDepartments(profile.id),
	);
}

/**
 * Reemplaza el conjunto completo de departamentos adicionales.
 *
 * De reemplazo y no de añadido a propósito: así quitar uno no necesita un verbo
 * aparte y cada cambio de ámbito deja **una** entrada en la bitácora con el antes
 * y el después (RN-03.8), que es lo que se querrá leer cuando alguien pregunte
 * por qué un jefe veía un departamento que no era suyo.
 */
export async function setResponsibilities(
	profileId: string,
	departmentIds: string[],
	actor: Actor,
): Promise<DepartmentResponsibilities> {
	const profile = await requireProfile(profileId);

	// El propio departamento se descarta en silencio: ya está en el ámbito por
	// RN-03.2 y guardarlo aquí lo ataría a un departamento que puede cambiar.
	const requested = [...new Set(departmentIds)].filter(
		(id) => id !== profile.departmentId,
	);

	if (requested.length > 0) {
		const existing = await db
			.select({ id: departments.id })
			.from(departments)
			.where(inArray(departments.id, requested));

		if (existing.length !== requested.length) {
			throw new HTTPException(400, {
				message: "Alguno de esos departamentos no existe.",
			});
		}
	}

	const before = await additionalDepartments(profile.id);
	const beforeIds = before.map((department) => department.id);

	const added = requested.filter((id) => !beforeIds.includes(id));
	const removed = beforeIds.filter((id) => !requested.includes(id));

	if (added.length === 0 && removed.length === 0) {
		return toResponsibilities(
			profile.id,
			await departmentById(profile.departmentId),
			before,
		);
	}

	await db.transaction(async (tx) => {
		if (removed.length > 0) {
			await tx
				.delete(userDepartmentResponsibilities)
				.where(
					and(
						eq(userDepartmentResponsibilities.userId, profile.id),
						inArray(userDepartmentResponsibilities.departmentId, removed),
					),
				);
		}

		if (added.length > 0) {
			await tx.insert(userDepartmentResponsibilities).values(
				added.map((departmentId) => ({
					userId: profile.id,
					departmentId,
				})),
			);
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "profile.responsibilities_changed",
			tableName: "user_department_responsibilities",
			recordId: profile.id,
			oldData: { departmentIds: beforeIds },
			newData: { departmentIds: requested },
			metadata: { added, removed },
			sourceIp: actor.sourceIp,
		});
	});

	return toResponsibilities(
		profile.id,
		await departmentById(profile.departmentId),
		await additionalDepartments(profile.id),
	);
}
