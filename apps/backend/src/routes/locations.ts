import { locationsSpec } from "@elineas/contracts";
import {
	createWorkLocationInputSchema,
	listWorkLocationsQuerySchema,
	roleAtLeast,
	updateWorkLocationInputSchema,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth, requireRole } from "#/middleware/auth";
import {
	createWorkLocation,
	deactivateWorkLocation,
	listWorkLocations,
	reactivateWorkLocation,
	updateWorkLocation,
} from "#/services/locations.ts";

/**
 * Sedes y geocerca (spec 08 §7). Montado en `/api/work-locations`.
 *
 * **Leer las sedes activas lo puede hacer cualquiera** con sesión: es el catálogo
 * con el que se elige sede antes de marcar, y no revela nada que la propia geocerca
 * no revele en cuanto alguien se acerca. Escribir es de `global_manager`: mover un
 * centro treinta metros decide quién puede trabajar mañana.
 */
export const locations = new Hono();

locations.use("*", requireAuth);

const idParam = z.object({
	id: z.uuid("El identificador de sede no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/**
 * `?includeInactive=true` **sube el rol exigido**: una sede desactivada no le sirve
 * a nadie que no la esté administrando, y la lista completa es información de
 * gestión. Así no hace falta un path aparte para la variante (§7 proponía `/all`).
 */
locations.get(
	"/",
	validate("query", listWorkLocationsQuerySchema),
	async (c) => {
		const { includeInactive } = c.req.valid("query");
		if (
			includeInactive &&
			!roleAtLeast(getAuth(c).effectiveRole, "global_manager")
		) {
			throw new HTTPException(403, {
				message: "Sólo un gestor global ve las sedes desactivadas.",
			});
		}

		const rows = await listWorkLocations({ includeInactive });
		return c.json(locationsSpec.list.response.parse(rows));
	},
);

locations.post(
	"/",
	requireRole("global_manager"),
	validate("json", createWorkLocationInputSchema),
	async (c) => {
		const created = await createWorkLocation(c.req.valid("json"), actorOf(c));
		return c.json(locationsSpec.create.response.parse(created), 201);
	},
);

locations.patch(
	"/:id",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateWorkLocationInputSchema),
	async (c) => {
		const updated = await updateWorkLocation(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(locationsSpec.update.response.parse(updated));
	},
);

/**
 * Desactivar en vez de borrar (RN-08.10). Arrastra la limpieza de la selección de
 * quien la tuviera elegida y su aviso (RN-08.6), todo en la misma transacción.
 */
locations.post(
	"/:id/deactivate",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		const updated = await deactivateWorkLocation(
			c.req.valid("param").id,
			actorOf(c),
		);
		return c.json(locationsSpec.deactivate.response.parse(updated));
	},
);

locations.post(
	"/:id/reactivate",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		const updated = await reactivateWorkLocation(
			c.req.valid("param").id,
			actorOf(c),
		);
		return c.json(locationsSpec.reactivate.response.parse(updated));
	},
);
