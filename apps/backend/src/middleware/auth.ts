import {
	type AppRole,
	getHighestRole,
	roleAtLeast,
} from "@elineas/validations";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { profiles } from "#/db/schema";
import {
	clearAuthCookies,
	readJwt,
	readSessionToken,
	setJwtCookie,
} from "#/lib/cookies";
import { refreshJwt, verifyJwt } from "#/lib/identity";
import { getRoles } from "#/lib/roles-cache";
import {
	findOrCreateProfile,
	getManagedDepartmentIds,
} from "#/services/profiles";

/**
 * Middleware de sesión (spec 03 §6).
 *
 * Resuelve **una sola vez por petición**: identidad (JWT verificado contra el
 * JWKS), perfil, roles (del IS, cacheados), rol efectivo y conjunto de
 * departamentos gestionados; y lo deja en el contexto.
 */

export type AuthContext = {
	identityUserId: string;
	sessionToken: string;
	profile: typeof profiles.$inferSelect;
	roles: AppRole[];
	effectiveRole: AppRole;
	managedDepartmentIds: string[];
};

declare module "hono" {
	interface ContextVariableMap {
		auth: AuthContext;
	}
}

const unauthorized = (message: string) => new HTTPException(401, { message });

/**
 * Identidad de la petición. El JWT caducado se renueva de forma transparente
 * con el session token (RN-00.37): el usuario no vuelve a ver el login cada 15
 * minutos.
 */
async function resolveIdentity(c: Context, sessionToken: string) {
	const jwt = readJwt(c);
	if (jwt) {
		const claims = await verifyJwt(jwt);
		if (claims) return claims;
	}

	const renewed = await refreshJwt(sessionToken);
	if (!renewed) return null;

	const claims = await verifyJwt(renewed);
	if (!claims) return null;

	setJwtCookie(c, renewed);
	return claims;
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
	const sessionToken = readSessionToken(c);
	if (!sessionToken) throw unauthorized("No hay sesión iniciada.");

	const claims = await resolveIdentity(c, sessionToken);
	if (!claims) {
		clearAuthCookies(c);
		throw unauthorized("La sesión expiró. Vuelve a iniciar sesión.");
	}

	const profile = await findOrCreateProfile({
		identityUserId: claims.identityUserId,
		email: claims.email ?? "",
		name: claims.name,
	});

	// RN-00.30: un perfil desactivado no entra, aunque el IS lo autentique.
	if (!profile.isActive) {
		clearAuthCookies(c);
		throw new HTTPException(403, {
			message: "Tu cuenta está desactivada en Control de Asistencia.",
		});
	}

	// RN-00.40: los permisos salen del IS con el session token, nunca del JWT.
	const roles = await getRoles(sessionToken);
	if (roles === null) {
		throw new HTTPException(503, {
			message:
				"No se pudieron comprobar tus permisos: el servidor de identidad no responde.",
		});
	}

	const effectiveRole = getHighestRole(roles);
	if (!effectiveRole) {
		// RN-03.5: no hay rol por defecto. Sin rol no hay acceso.
		throw new HTTPException(403, {
			message: "Tu cuenta no tiene un rol asignado en Control de Asistencia.",
		});
	}

	c.set("auth", {
		identityUserId: claims.identityUserId,
		sessionToken,
		profile,
		roles,
		effectiveRole,
		managedDepartmentIds: await getManagedDepartmentIds(profile),
	});

	await next();
};

export function getAuth(c: Context): AuthContext {
	const auth = c.get("auth");
	if (!auth) {
		throw new Error(
			"getAuth() se llamó en una ruta sin requireAuth. Es un error de programación.",
		);
	}
	return auth;
}

/**
 * Exige al menos el rol indicado (RN-03.3: el servidor es la autoridad, el
 * guard del cliente es sólo UX).
 */
export function requireRole(minimum: AppRole): MiddlewareHandler {
	return async (c, next) => {
		const { effectiveRole } = getAuth(c);
		if (!roleAtLeast(effectiveRole, minimum)) {
			throw new HTTPException(403, {
				message: "No tienes permiso para esta operación.",
			});
		}
		await next();
	};
}

/**
 * Comprobación de ámbito departamental (RN-03.2), en **una sola función tipada**
 * reutilizada en todos lados — nunca repetida por endpoint, que es como el
 * legacy acabó invirtiendo los argumentos (H-1).
 */
export function hasScope(auth: AuthContext, departmentId: string): boolean {
	if (roleAtLeast(auth.effectiveRole, "global_manager")) return true;
	if (auth.effectiveRole !== "department_head") return false;
	return auth.managedDepartmentIds.includes(departmentId);
}

export function requireScope(auth: AuthContext, departmentId: string): void {
	if (!hasScope(auth, departmentId)) {
		throw new HTTPException(403, {
			message: "Ese departamento está fuera de tu ámbito.",
		});
	}
}

/** ¿Puede `auth` gestionar el perfil `targetProfileDepartmentId`? */
export function canManage(
	auth: AuthContext,
	targetProfileDepartmentId: string | null,
): boolean {
	if (roleAtLeast(auth.effectiveRole, "global_manager")) return true;
	if (targetProfileDepartmentId === null) return false;
	return hasScope(auth, targetProfileDepartmentId);
}
