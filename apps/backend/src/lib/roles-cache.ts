import type { AppRole } from "@elineas/validations";
import { config } from "#/lib/config";
import { fetchRoles } from "#/lib/identity";

/**
 * Caché de roles por sesión (RN-00.41).
 *
 * Consultar el IS en cada petición añadiría un viaje de red a todo. Se cachea
 * por session token con TTL corto; ese TTL es exactamente lo que tarda en
 * aplicarse aquí un cambio de rol hecho en la consola del IS.
 *
 * En memoria del proceso a propósito: si mañana hay más de una instancia del
 * backend, esto pasa a Redis. Mientras haya una, un Map basta y la sesión
 * caduca con el proceso.
 */

type Entry = { roles: AppRole[]; fetchedAt: number };

const cache = new Map<string, Entry>();

/**
 * Roles del usuario dueño de `sessionToken`.
 *
 * Si el IS no responde se sirven los roles cacheados dentro de la ventana de
 * gracia (RN-00.42): en un sistema de fichaje en planta, bloquear a todo el
 * mundo porque el IS está caído es peor que servir un rol de hace unos minutos.
 * Pasada la ventana, se deniega.
 */
export async function getRoles(
	sessionToken: string,
): Promise<AppRole[] | null> {
	const now = Date.now();
	const cached = cache.get(sessionToken);

	if (cached && now - cached.fetchedAt < config.rolesCacheTtlMs) {
		return cached.roles;
	}

	const fresh = await fetchRoles(sessionToken);
	if (fresh !== null) {
		cache.set(sessionToken, { roles: fresh, fetchedAt: now });
		return fresh;
	}

	if (cached && now - cached.fetchedAt < config.rolesStaleGraceMs) {
		return cached.roles;
	}

	return null;
}

/** Se invalida al cerrar sesión (RN-00.41). */
export function invalidateRoles(sessionToken: string) {
	cache.delete(sessionToken);
}
