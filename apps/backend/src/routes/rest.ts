import { restSpec } from "@elineas/contracts";
import {
	createRestGroupInputSchema,
	restDaysRangeQuerySchema,
	updateRestGroupInputSchema,
	updateRestGroupMembersInputSchema,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import {
	getAuth,
	requireAuth,
	requireRole,
	requireScope,
} from "#/middleware/auth";
import {
	createRestGroup,
	deleteRestGroup,
	departmentOfGroup,
	getDepartmentRestDays,
	listRestGroups,
	setRestGroupMembers,
	updateRestGroup,
} from "#/services/rest-schedules.ts";

/**
 * Grupos de descanso y calendario de descansos del equipo (spec 10 §6).
 *
 * Son **dos routers** porque son dos prefijos: lo que cuelga del departamento
 * —listar y crear grupos, ver quién descansa cada día— y lo que cuelga del grupo
 * —editarlo, retirarlo, asignarle gente—. La configuración individual vive en
 * `/me/rest-schedule` y `/users/:id/rest-schedule`, en sus routers de siempre.
 *
 * El reparto de roles es el de la §4 y tiene su razón: **los días de un grupo son
 * una regla de empresa** —cambiarlos cambia los descansos de todos sus miembros, y
 * hacia atrás (ver `updateRestGroup`)—, así que se quedan en `global_manager`;
 * **asignar personas a un grupo** es la operación del día a día de un jefe con su
 * turno, y es de `department_head` con ámbito.
 */

const idParam = z.object({
	id: z.uuid("El identificador no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
	role: getAuth(c).effectiveRole,
});

/** Montado en `/api/departments`, junto a los routers de las specs 01 y 07. */
export const departmentRest = new Hono();

departmentRest.use("*", requireAuth);

departmentRest.get(
	"/:id/rest-groups",
	requireRole("department_head"),
	validate("param", idParam),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), id);

		return c.json(restSpec.groups.response.parse(await listRestGroups(id)));
	},
);

departmentRest.post(
	"/:id/rest-groups",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", createRestGroupInputSchema),
	async (c) => {
		const created = await createRestGroup(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(restSpec.createGroup.response.parse(created), 201);
	},
);

/**
 * Quién descansa cada día del rango (spec 10 §7). Lo lee un `department_head` con
 * ámbito: es su herramienta para ver el turno completo, incluido quién se ha
 * quedado sin descansos configurados (RN-10.10).
 */
departmentRest.get(
	"/:id/rest-days",
	requireRole("department_head"),
	validate("param", idParam),
	validate("query", restDaysRangeQuerySchema),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), id);

		const days = await getDepartmentRestDays(id, c.req.valid("query"));
		return c.json(restSpec.departmentRestDays.response.parse(days));
	},
);

/** Montado en `/api/rest-groups`. */
export const restGroupsRouter = new Hono();

restGroupsRouter.use("*", requireAuth);

restGroupsRouter.patch(
	"/:id",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateRestGroupInputSchema),
	async (c) => {
		const updated = await updateRestGroup(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(restSpec.updateGroup.response.parse(updated));
	},
);

restGroupsRouter.delete(
	"/:id",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		await deleteRestGroup(c.req.valid("param").id, actorOf(c));
		return c.json({ ok: true } as const);
	},
);

/**
 * Asignación de personas al grupo: `department_head` **con ámbito sobre el
 * departamento del grupo**, no sobre el que diga el cliente. El ámbito se resuelve
 * leyendo el grupo, que es la única fuente de a qué departamento pertenece.
 */
restGroupsRouter.put(
	"/:id/members",
	requireRole("department_head"),
	validate("param", idParam),
	validate("json", updateRestGroupMembersInputSchema),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), await departmentOfGroup(id));

		const groups = await setRestGroupMembers(
			id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(restSpec.setMembers.response.parse(groups));
	},
);
