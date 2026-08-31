import { departmentsSpec } from "@elineas/contracts";
import {
	createDepartmentInputSchema,
	listDepartmentsQuerySchema,
	pauseDepartmentInputSchema,
	updateDepartmentInputSchema,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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
	createDepartment,
	deleteDepartment,
	getDepartmentSummary,
	listDepartments,
	listMembers,
	pauseDepartment,
	resumeDepartment,
	updateDepartment,
} from "#/services/departments.ts";

/**
 * Departamentos (spec 01 §6). Montado en `/api/departments` desde `index.ts`.
 *
 * El rol mínimo de cada operación sale de la matriz de la spec 01 §2, y se aplica
 * **aquí, en el servidor**: el filtrado del aside en el frontend es sólo UX
 * (RN-03.3). Sin RLS de red de seguridad (RN-00.1), esta es la única barrera.
 */
export const departments = new Hono();

departments.use("*", requireAuth);

const idParam = z.object({
	id: z.uuid("El identificador de departamento no es válido."),
});

/** Actor de la operación, para la bitácora (spec 18 §2). */
const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/**
 * Lista: cualquier usuario autenticado. Es un catálogo que se usa en selectores
 * de toda la aplicación, y no revela nada sensible.
 */
departments.get(
	"/",
	validate("query", listDepartmentsQuerySchema),
	async (c) => {
		const { includePaused } = c.req.valid("query");
		const rows = await listDepartments({ includePaused });
		return c.json(departmentsSpec.list.response.parse(rows));
	},
);

/**
 * Detalle y miembros: `department_head` **con ámbito** sobre ese departamento
 * (spec 01 §2, RN-03.2). Un `global_manager` pasa el ámbito por rol.
 */
departments.get(
	"/:id",
	requireRole("department_head"),
	validate("param", idParam),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), id);

		const department = await getDepartmentSummary(id);
		if (!department) {
			throw new HTTPException(404, { message: "Ese departamento no existe." });
		}
		return c.json(departmentsSpec.detail.response.parse(department));
	},
);

departments.get(
	"/:id/members",
	requireRole("department_head"),
	validate("param", idParam),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), id);

		const members = await listMembers(id);
		return c.json(departmentsSpec.members.response.parse(members));
	},
);

departments.post(
	"/",
	requireRole("global_manager"),
	validate("json", createDepartmentInputSchema),
	async (c) => {
		const created = await createDepartment(c.req.valid("json"), actorOf(c));
		return c.json(departmentsSpec.create.response.parse(created), 201);
	},
);

departments.patch(
	"/:id",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateDepartmentInputSchema),
	async (c) => {
		const updated = await updateDepartment(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(departmentsSpec.update.response.parse(updated));
	},
);

departments.post(
	"/:id/pause",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", pauseDepartmentInputSchema),
	async (c) => {
		const paused = await pauseDepartment(
			c.req.valid("param").id,
			c.req.valid("json").reason,
			actorOf(c),
		);
		return c.json(departmentsSpec.pause.response.parse(paused));
	},
);

departments.post(
	"/:id/resume",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		const resumed = await resumeDepartment(c.req.valid("param").id, actorOf(c));
		return c.json(departmentsSpec.resume.response.parse(resumed));
	},
);

departments.delete(
	"/:id",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		await deleteDepartment(c.req.valid("param").id, actorOf(c));
		return c.json({ ok: true } as const);
	},
);
