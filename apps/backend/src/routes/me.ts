import {
	authSpec,
	locationsSpec,
	schedulesSpec,
	usersSpec,
} from "@elineas/contracts";
import {
	devicePositionSchema,
	myScheduleQuerySchema,
	selectWorkLocationInputSchema,
	updateOwnProfileInputSchema,
} from "@elineas/validations";
import { Hono } from "hono";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth } from "#/middleware/auth";
import {
	checkMyLocation,
	getMyWorkLocation,
	selectMyWorkLocation,
} from "#/services/locations.ts";
import { departmentNameOf, toSessionProfile } from "#/services/profiles";
import { getMySchedule } from "#/services/schedules.ts";
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

/**
 * `GET /api/me/schedule` (spec 07 §5): el horario que le aplica hoy a quien
 * pregunta, con los días no laborables de su departamento.
 *
 * Sin parámetro de usuario: como en el resto de `/me`, no hay forma de pedir el de
 * otra persona. `?from=&to=` acota el calendario que se devuelve; sin él, el mes en
 * curso **en la zona del horario** (RN-07.2).
 */
me.get("/schedule", validate("query", myScheduleQuerySchema), async (c) => {
	const auth = getAuth(c);
	const mine = await getMySchedule(
		auth.profile,
		auth.effectiveRole,
		c.req.valid("query"),
	);
	return c.json(schedulesSpec.mine.response.parse(mine));
});

/**
 * `GET`/`PUT /api/me/work-location` (spec 08 §7): la sede contra la que se validan
 * los marcajes de quien pregunta (RN-08.5).
 *
 * Vive en el perfil y no sólo en el dispositivo (decisión 2 de la §9): así
 * sobrevive al cambio de teléfono y el servidor puede invalidarla al desactivar la
 * sede (RN-08.6). Sin parámetro de usuario, como todo `/me`: no hay forma de
 * cambiarle la sede a otro.
 */
me.get("/work-location", async (c) => {
	const auth = getAuth(c);
	const mine = await getMyWorkLocation(auth.profile, auth.effectiveRole);
	return c.json(locationsSpec.mine.response.parse(mine));
});

me.put(
	"/work-location",
	validate("json", selectWorkLocationInputSchema),
	async (c) => {
		const auth = getAuth(c);
		const mine = await selectMyWorkLocation(
			auth.profile.id,
			c.req.valid("json").workLocationId,
			auth.effectiveRole,
		);
		return c.json(locationsSpec.select.response.parse(mine));
	},
);

/**
 * `POST /api/me/location-check` (spec 08 §6): el veredicto del **servidor** para una
 * lectura del dispositivo.
 *
 * No escribe nada — no es un marcaje, es la consulta que resuelve el reclamo más
 * común: *"la app dice que estoy fuera y estoy dentro"*. Responde el servidor
 * porque es quien decide (RN-08.2), y el cuerpo sólo admite lat/lng y precisión: ni
 * distancia ni `insideGeofence` calculados fuera.
 */
me.post(
	"/location-check",
	validate("json", devicePositionSchema),
	async (c) => {
		const verdict = await checkMyLocation(
			getAuth(c).profile,
			c.req.valid("json"),
		);
		return c.json(locationsSpec.check.response.parse(verdict));
	},
);
