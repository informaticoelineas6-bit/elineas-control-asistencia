/**
 * Configuración del backend. Todo lo del Identity Server se lee de aquí y de
 * ningún otro sitio: el `systemSlug` en particular no se escribe a mano en
 * varios lugares (RN-00.31).
 */

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`Falta la variable de entorno ${name}. Ver apps/backend/.env.local.example`,
		);
	}
	return value;
}

export const config = {
	/** URL base del Identity Server, p. ej. https://auth.elineas.com */
	authApiUrl: required("AUTH_API_URL"),
	/** Slug con el que este sistema está registrado en el IS (RN-00.31). */
	systemSlug: process.env.SYSTEM_SLUG ?? "control-asistencia",
	frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3004",
	port: Number(process.env.PORT ?? 3001),
	/**
	 * TTL de la caché de roles (RN-00.41). Es lo que tarda en aplicarse aquí un
	 * cambio de rol hecho en la consola del IS. **Decisión abierta** en la spec;
	 * arrancamos con los 5 minutos que propone.
	 */
	rolesCacheTtlMs: Number(process.env.ROLES_CACHE_TTL_MS ?? 5 * 60 * 1000),
	/**
	 * Cuánto se siguen sirviendo roles ya cacheados si el IS no responde
	 * (RN-00.42). La spec deja la decisión abierta y se inclina por seguir
	 * sirviendo con un límite: en planta la gente tiene que poder fichar.
	 */
	rolesStaleGraceMs: Number(process.env.ROLES_STALE_GRACE_MS ?? 60 * 60 * 1000),
	isProduction: process.env.NODE_ENV === "production",
} as const;
