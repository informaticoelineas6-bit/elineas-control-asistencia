import { authSpec, usersSpec } from "@elineas/contracts";
import { updateOwnProfileInputSchema } from "@elineas/validations";
import { Hono } from "hono";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth } from "#/middleware/auth";
import { departmentNameOf, toSessionProfile } from "#/services/profiles";
import { getOwnProfile, updateOwnProfile } from "#/services/users.ts";

export const me = new Hono();

me.use("*", requireAuth);

/**
 * `GET /api/me` (spec 02 §7): el perfil propio.
 *
 * No incluye el sueldo. La matriz de la spec 02 §2 no se lo concede a `employee`
 * ni a `department_head`, y no se hace una excepción por ser el suyo: el dato vive
 * en otra tabla y sale sólo por los endpoints de compensación.
 */
me.get("/", async (c) => {
	const profile = await getOwnProfile(getAuth(c).profile.id);
	return c.json(usersSpec.me.response.parse(profile));
});

/** `PATCH /api/me`: sólo datos de contacto. Nombre y correo son del IS. */
me.patch("/", validate("json", updateOwnProfileInputSchema), async (c) => {
	const auth = getAuth(c);
	const updated = await updateOwnProfile(auth.profile.id, c.req.valid("json"), {
		profileId: auth.profile.id,
		sourceIp: clientIp(c),
	});
	return c.json(usersSpec.updateMe.response.parse(updated));
});

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
			profile: toSessionProfile(
				auth.profile,
				await departmentNameOf(auth.profile.departmentId),
			),
			roles: auth.roles,
			effectiveRole: auth.effectiveRole,
			managedDepartmentIds: auth.managedDepartmentIds,
		}),
	);
});
