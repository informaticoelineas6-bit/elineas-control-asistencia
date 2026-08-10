import { authSpec } from "@elineas/contracts";
import { Hono } from "hono";
import { getAuth, requireAuth } from "#/middleware/auth";
import { toSessionProfile } from "#/services/profiles";

export const me = new Hono();

me.use("*", requireAuth);

/**
 * `GET /api/me/permissions` (spec 03 §7): rol efectivo y departamentos
 * gestionados del usuario autenticado.
 *
 * El frontend la usa además como sonda de sesión. Devuelve el ámbito porque el
 * IS no lo conoce: él dice *qué rol* tiene alguien, el ámbito lo resolvemos
 * nosotros con nuestros datos (RN-00.43).
 */
me.get("/permissions", async (c) => {
	const auth = getAuth(c);

	return c.json(
		authSpec.permissions.response.parse({
			user: {
				identityUserId: auth.identityUserId,
				email: auth.profile.email,
				name: auth.profile.fullName,
			},
			profile: toSessionProfile(auth.profile),
			roles: auth.roles,
			effectiveRole: auth.effectiveRole,
			managedDepartmentIds: auth.managedDepartmentIds,
		}),
	);
});
