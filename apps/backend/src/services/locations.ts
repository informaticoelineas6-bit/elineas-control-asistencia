import {
	type AppRole,
	type CreateWorkLocationInput,
	type DevicePosition,
	type LocationVerdict,
	roleCanMark,
	type UpdateWorkLocationInput,
	type WorkLocation,
} from "@elineas/validations";
import { asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import { profiles, workLocations } from "#/db/schema";
import { type Actor, audit } from "#/services/audit.ts";
import { validateMarkLocation } from "#/services/location-rules.ts";
import { notify } from "#/services/notifications.ts";

/**
 * Sedes y geocerca (spec 08).
 *
 * El servicio hace lo de siempre —transacción, bitácora dentro de ella (RN-18.4),
 * notificaciones en el servidor— y ninguna cuenta de distancias: la geometría vive
 * en `@elineas/validations` porque la comparte la interfaz, y la decisión de si un
 * marcaje entra por ubicación vive en `location-rules.ts`, que es puro.
 *
 * Aquí no hay borrado (RN-08.10): una sede se desactiva. El historial de marcajes
 * necesita seguir sabiendo contra qué se validó cada uno.
 */

type LocationRow = typeof workLocations.$inferSelect;

function toWorkLocation(row: LocationRow): WorkLocation {
	return {
		id: row.id,
		name: row.name,
		centerLat: row.centerLat,
		centerLng: row.centerLng,
		radiusMeters: row.radiusMeters,
		accuracyThreshold: row.accuracyThreshold,
		blockOnPoorAccuracy: row.blockOnPoorAccuracy,
		isActive: row.isActive,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function listWorkLocations(options: {
	includeInactive: boolean;
}): Promise<WorkLocation[]> {
	const rows = options.includeInactive
		? await db.select().from(workLocations).orderBy(asc(workLocations.name))
		: await db
				.select()
				.from(workLocations)
				.where(eq(workLocations.isActive, true))
				.orderBy(asc(workLocations.name));

	return rows.map(toWorkLocation);
}

/** 404 en un solo sitio, con el mismo mensaje en todas las operaciones. */
async function requireLocationRow(id: string): Promise<LocationRow> {
	const row = await db.query.workLocations.findFirst({
		where: eq(workLocations.id, id),
	});
	if (!row) throw new HTTPException(404, { message: "Esa sede no existe." });
	return row;
}

export async function getWorkLocation(id: string): Promise<WorkLocation> {
	return toWorkLocation(await requireLocationRow(id));
}

/**
 * Nombres únicos sin distinguir mayúsculas, igual que los departamentos: dos
 * "Sede Central" en el selector que alguien usa antes de marcar son un error
 * esperando a ocurrir. La base lo garantiza con un índice; esto existe para dar el
 * mensaje legible antes de chocar con él.
 */
async function assertNameAvailable(name: string, exceptId?: string) {
	const clash = await db
		.select({ id: workLocations.id })
		.from(workLocations)
		.where(sql`lower(${workLocations.name}) = lower(${name})`);

	if (clash.some((row) => row.id !== exceptId)) {
		throw new HTTPException(409, {
			message: `Ya existe una sede llamada "${name}".`,
		});
	}
}

/** Choque con el índice único, si dos peticiones simultáneas ganan la carrera. */
function isUniqueViolation(error: unknown): boolean {
	const code = (error as { code?: string })?.code;
	const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
	return code === "23505" || causeCode === "23505";
}

export async function createWorkLocation(
	input: CreateWorkLocationInput,
	actor: Actor,
): Promise<WorkLocation> {
	await assertNameAvailable(input.name);

	try {
		return await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(workLocations)
				.values(input)
				.returning();
			if (!created) {
				throw new HTTPException(500, { message: "No se pudo crear la sede." });
			}

			const location = toWorkLocation(created);
			await audit(tx, {
				actorId: actor.profileId,
				action: "work_location.created",
				tableName: "work_locations",
				recordId: created.id,
				newData: location,
				sourceIp: actor.sourceIp,
			});

			return location;
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new HTTPException(409, {
				message: `Ya existe una sede llamada "${input.name}".`,
			});
		}
		throw error;
	}
}

/**
 * Cambiar el centro, el radio o el umbral de una sede **cambia quién puede marcar
 * mañana**, así que el valor anterior y el nuevo quedan enteros en la bitácora: es
 * lo único que permite reconstruir por qué a alguien se le rechazó un marcaje el
 * mes pasado (RN-06.4, no retroactividad).
 */
export async function updateWorkLocation(
	id: string,
	patch: UpdateWorkLocationInput,
	actor: Actor,
): Promise<WorkLocation> {
	const before = toWorkLocation(await requireLocationRow(id));
	if (patch.name && patch.name !== before.name) {
		await assertNameAvailable(patch.name, id);
	}

	const changed = Object.entries(patch).some(
		([key, value]) =>
			value !== undefined && value !== before[key as keyof WorkLocation],
	);
	if (!changed) return before;

	try {
		return await db.transaction(async (tx) => {
			const [updated] = await tx
				.update(workLocations)
				.set({ ...patch, updatedAt: new Date() })
				.where(eq(workLocations.id, id))
				.returning();

			if (!updated)
				throw new HTTPException(404, { message: "Esa sede no existe." });

			const location = toWorkLocation(updated);
			await audit(tx, {
				actorId: actor.profileId,
				action: "work_location.updated",
				tableName: "work_locations",
				recordId: id,
				oldData: before,
				newData: location,
				sourceIp: actor.sourceIp,
			});

			return location;
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new HTTPException(409, {
				message: `Ya existe una sede llamada "${patch.name}".`,
			});
		}
		throw error;
	}
}

/**
 * RN-08.6 + RN-08.10 — Desactivar es lo más parecido a borrar que admite una sede,
 * y arrastra una consecuencia: **la selección de quien la tenía elegida deja de ser
 * válida**.
 *
 * Esa limpieza se hace aquí, en la misma transacción, y no esperando a que cada
 * cliente lo descubra: si dependiera del dispositivo, alguien llegaría a la puerta
 * con una selección muerta y un rechazo que no explica nada. Y por lo mismo se
 * notifica (hallazgo H-4: los efectos los genera el servidor).
 */
export async function deactivateWorkLocation(
	id: string,
	actor: Actor,
): Promise<WorkLocation> {
	const before = await requireLocationRow(id);
	if (!before.isActive) {
		throw new HTTPException(409, { message: "Esa sede ya está desactivada." });
	}

	return db.transaction(async (tx) => {
		const [updated] = await tx
			.update(workLocations)
			.set({ isActive: false, updatedAt: new Date() })
			.where(eq(workLocations.id, id))
			.returning();

		if (!updated)
			throw new HTTPException(404, { message: "Esa sede no existe." });

		const affected = await tx
			.update(profiles)
			.set({ selectedWorkLocationId: null, updatedAt: new Date() })
			.where(eq(profiles.selectedWorkLocationId, id))
			.returning({ id: profiles.id, isActive: profiles.isActive });

		await audit(tx, {
			actorId: actor.profileId,
			action: "work_location.deactivated",
			tableName: "work_locations",
			recordId: id,
			oldData: { isActive: true },
			newData: { isActive: false },
			metadata: { clearedSelections: affected.length },
			sourceIp: actor.sourceIp,
		});

		await notify(
			tx,
			affected.filter((row) => row.isActive).map((row) => row.id),
			{
				type: "work_location.deactivated",
				title: `${updated.name} ya no está disponible`,
				body: "Elige otra sede en tu perfil antes de registrar asistencia.",
				actionUrl: "/profile",
				dedupeKey: `work-location:${id}`,
			},
		);

		return toWorkLocation(updated);
	});
}

export async function reactivateWorkLocation(
	id: string,
	actor: Actor,
): Promise<WorkLocation> {
	const before = await requireLocationRow(id);
	if (before.isActive) {
		throw new HTTPException(409, { message: "Esa sede ya está activa." });
	}

	return db.transaction(async (tx) => {
		const [updated] = await tx
			.update(workLocations)
			.set({ isActive: true, updatedAt: new Date() })
			.where(eq(workLocations.id, id))
			.returning();

		if (!updated)
			throw new HTTPException(404, { message: "Esa sede no existe." });

		await audit(tx, {
			actorId: actor.profileId,
			action: "work_location.reactivated",
			tableName: "work_locations",
			recordId: id,
			oldData: { isActive: false },
			newData: { isActive: true },
			sourceIp: actor.sourceIp,
		});

		// Quien la tuviera elegida ya perdió la selección al desactivarla: reactivar
		// no la devuelve, porque en ese hueco pudo elegir otra a conciencia.
		return toWorkLocation(updated);
	});
}

// ── La sede de cada persona ───────────────────────────────────────────────────

export type MyWorkLocation = {
	location: WorkLocation | null;
	/**
	 * `true` si a esta persona le hace falta tener sede elegida para operar
	 * (RN-08.7). Se resuelve con `roleCanMark`, el mismo criterio que el menú y que
	 * la validación horaria: sólo el gestor global queda fuera.
	 */
	required: boolean;
};

export async function getMyWorkLocation(
	profile: { selectedWorkLocationId: string | null },
	role: AppRole,
): Promise<MyWorkLocation> {
	const location = profile.selectedWorkLocationId
		? toWorkLocation(await requireLocationRow(profile.selectedWorkLocationId))
		: null;

	return { location, required: roleCanMark(role) };
}

/**
 * RN-08.8 — Elegir sede. Es del **usuario sobre sí mismo**: no hay endpoint para
 * cambiarle la sede a otro, igual que con las notificaciones (RN-14.1).
 *
 * No se audita: es una acción rutinaria del día a día y cada marcaje guardará
 * contra qué sede se validó (spec 09), que es donde el dato importa. Auditar cada
 * cambio de selector llenaría la bitácora de ruido y enterraría lo que sí hay que
 * poder reconstruir.
 */
export async function selectMyWorkLocation(
	profileId: string,
	workLocationId: string | null,
	role: AppRole,
): Promise<MyWorkLocation> {
	if (workLocationId !== null) {
		const row = await requireLocationRow(workLocationId);
		if (!row.isActive) {
			throw new HTTPException(409, {
				message: `${row.name} está desactivada como sede: elige otra.`,
			});
		}
	}

	await db
		.update(profiles)
		.set({ selectedWorkLocationId: workLocationId, updatedAt: new Date() })
		.where(eq(profiles.id, profileId));

	return getMyWorkLocation({ selectedWorkLocationId: workLocationId }, role);
}

/**
 * Veredicto del **servidor** para una lectura del dispositivo (spec 08 §6).
 *
 * Existe para la pantalla de diagnóstico, y por eso responde el servidor y no el
 * cliente: el reclamo que hay que resolver es *"la app dice que estoy fuera y estoy
 * dentro"*, y para eso hace falta ver exactamente lo que el servidor calcula con
 * las coordenadas que recibe (RN-08.2). No escribe nada: no es un marcaje, es una
 * consulta.
 */
export async function checkMyLocation(
	profile: { selectedWorkLocationId: string | null },
	position: DevicePosition,
): Promise<LocationVerdict> {
	const selected = profile.selectedWorkLocationId
		? toWorkLocation(await requireLocationRow(profile.selectedWorkLocationId))
		: null;

	const activeLocations = await listWorkLocations({ includeInactive: false });

	return validateMarkLocation({ selected, activeLocations, position });
}
