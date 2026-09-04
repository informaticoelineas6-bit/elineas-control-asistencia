import {
	type AppConfigValues,
	CONFIG_DEFAULTS,
	type ConfigKey,
	checkoutModeIssue,
	configSchema,
	configValueSchemas,
	PUBLIC_CONFIG_KEYS,
	type PublicConfigValues,
	restLimitsIssue,
	type UpdateConfigInput,
} from "@elineas/validations";
import { inArray } from "drizzle-orm";
import { db } from "#/db";
import { appConfig, departments } from "#/db/schema";
import { audit } from "#/services/audit.ts";

/**
 * Configuración global (spec 06).
 *
 * Cuatro reglas de la spec 06 se cumplen aquí y conviene no perderlas de vista:
 *
 * - **RN-06.2** — la base guarda sólo sobrescrituras; el default vive en código.
 * - **RN-06.5** — validación cruzada del modo de salida, sobre el resultado
 *   efectivo (`assertConsistent`).
 * - **RN-06.7** — una escritura invalida la caché de inmediato.
 * - Un valor corrupto en base **cae al default** y se registra, no rompe la app.
 *
 * La caché es de proceso, igual que la de roles: con una sola instancia del
 * backend basta. Con más de una, esto pasa a Redis o a escuchar `NOTIFY` — hasta
 * entonces cada proceso podría servir un valor viejo durante el TTL.
 */

const CACHE_TTL_MS = 30_000;

let cache: { values: AppConfigValues; loadedAt: number } | null = null;

export function invalidateConfigCache() {
	cache = null;
}

export async function getConfig(): Promise<AppConfigValues> {
	if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
		return cache.values;
	}

	const rows = await db.select().from(appConfig);

	// Se acumula sin tipar y se valida el conjunto al final: así cada clave cae a
	// su default por separado si su valor está corrupto, y el objeto que sale de
	// aquí está tipado sin una sola aserción.
	const merged: Record<string, unknown> = { ...CONFIG_DEFAULTS };

	for (const row of rows) {
		const schema = configValueSchemas[row.key as ConfigKey];
		// Una clave que ya no está en el catálogo se ignora: pudo quedar de una
		// versión anterior y no debe impedir arrancar.
		if (!schema) continue;

		const parsed = schema.safeParse(row.value);
		if (!parsed.success) {
			console.error(
				`Configuración inválida en la clave "${row.key}": se usa el valor por defecto.`,
				parsed.error.issues,
			);
			continue;
		}
		merged[row.key] = parsed.data;
	}

	const values = configSchema.parse(merged);
	cache = { values, loadedAt: Date.now() };
	return values;
}

/**
 * Subconjunto seguro (`GET /config/public`, spec 06 §5): lo que cualquier rol
 * necesita para que la interfaz aplique las mismas reglas que el servidor.
 *
 * Se proyecta desde la lista blanca de `@elineas/validations` en vez de excluir
 * claves aquí: añadir una al catálogo no debe exponerla por descuido.
 */
export async function getPublicConfig(): Promise<PublicConfigValues> {
	const values = await getConfig();
	return Object.fromEntries(
		PUBLIC_CONFIG_KEYS.map((key) => [key, values[key]]),
	) as PublicConfigValues;
}

/**
 * Validación cruzada al guardar (RN-06.5), sobre el resultado **efectivo** y no
 * sobre el parche: alguien puede fijar la hora de cierre hoy y cambiar el modo
 * mañana, y lo que tiene que quedar coherente es lo guardado, no cada petición
 * por separado.
 *
 * Los ids de departamento se comprueban aquí por el mismo motivo: uno que no
 * existe deja RN-03.6 —o el acotado de RN-10.5— apuntando al vacío, y es mejor
 * rechazarlo al escribir que fallar cada vez que se aplique.
 */
async function assertConsistent(patch: UpdateConfigInput): Promise<void> {
	const effective = { ...(await getConfig()), ...patch };

	const issue = checkoutModeIssue(effective) ?? restLimitsIssue(effective);
	if (issue) throw new ConfigValidationError(issue);

	const referenced = [
		...new Set(
			[
				patch.global_manager_department_id,
				...(patch.rest_days_min_separation_departments ?? []),
			].filter((id): id is string => typeof id === "string"),
		),
	];
	if (referenced.length === 0) return;

	const found = await db
		.select({ id: departments.id })
		.from(departments)
		.where(inArray(departments.id, referenced));

	if (found.length !== referenced.length) {
		throw new ConfigValidationError("Alguno de esos departamentos no existe.");
	}
}

export class ConfigValidationError extends Error {}

/**
 * Escribe las claves indicadas y devuelve la configuración completa resultante.
 * Cada cambio queda en la bitácora con valor anterior y nuevo (RN-06.3).
 */
export async function setConfig(
	patch: UpdateConfigInput,
	actor: { profileId: string; sourceIp?: string | null },
): Promise<AppConfigValues> {
	await assertConsistent(patch);

	const keys = Object.keys(patch) as ConfigKey[];
	const before = await getConfig();

	await db.transaction(async (tx) => {
		for (const key of keys) {
			const value = patch[key];
			await tx
				.insert(appConfig)
				.values({
					key,
					value: value ?? null,
					updatedBy: actor.profileId,
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: appConfig.key,
					set: {
						value: value ?? null,
						updatedBy: actor.profileId,
						updatedAt: new Date(),
					},
				});
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "config.updated",
			tableName: "app_config",
			recordId: keys.join(","),
			oldData: Object.fromEntries(keys.map((key) => [key, before[key]])),
			newData: patch,
			sourceIp: actor.sourceIp,
		});
	});

	invalidateConfigCache();
	return getConfig();
}

/** Claves que quedarían huérfanas si se borra `departmentId`. */
export async function configKeysReferencing(
	departmentId: string,
): Promise<ConfigKey[]> {
	const config = await getConfig();
	const keys: ConfigKey[] = [];
	if (config.global_manager_department_id === departmentId) {
		keys.push("global_manager_department_id");
	}
	if (config.rest_days_min_separation_departments.includes(departmentId)) {
		keys.push("rest_days_min_separation_departments");
	}
	return keys;
}
