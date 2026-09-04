import { restSpec, usersSpec } from "@elineas/contracts";
import {
	deactivateUserInputSchema,
	listUsersQuerySchema,
	restScheduleQuerySchema,
	roleAtLeast,
	updateCompensationInputSchema,
	updateDepartmentResponsibilitiesInputSchema,
	updateRestScheduleInputSchema,
	updateUserInputSchema,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import {
	canManage,
	getAuth,
	requireAuth,
	requireRole,
	requireScope,
} from "#/middleware/auth";
import {
	getResponsibilities,
	setResponsibilities,
} from "#/services/responsibilities.ts";
import {
	getRestScheduleView,
	setRestSchedule,
} from "#/services/rest-schedules.ts";
import {
	deactivateUser,
	deleteUser,
	getCompensation,
	getProfileRow,
	getUser,
	listIncompleteUsers,
	listUsers,
	reactivateUser,
	setCompensation,
	updateUser,
} from "#/services/users.ts";

/**
 * Usuarios y perfiles (spec 02 §7). Montado en `/api/users`.
 *
 * **No hay alta ni reseteo de contraseña**: son operaciones del Identity Server
 * (RN-00.28). Lo que hay es el segundo paso del alta y el ciclo de vida operativo.
 */
export const users = new Hono();

users.use("*", requireAuth);

const idParam = z.object({
	id: z.uuid("El identificador de perfil no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/**
 * El perfil de destino, comprobado contra el ámbito de quien pregunta (RN-03.2).
 *
 * El ámbito se resuelve **contra el departamento del perfil de destino**, no
 * contra lo que diga el cliente. Está en una función porque lo piden ya tres
 * endpoints, y repetirlo por endpoint es como el legacy acabó invirtiendo los
 * argumentos de la comprobación (hallazgo H-1).
 *
 * Un perfil sin departamento queda fuera para un jefe y dentro para un gestor
 * global, que es exactamente lo que hace `canManage`: sin departamento no hay
 * ámbito que alcance.
 */
async function requireManageable(c: Context, id: string) {
	const target = await getProfileRow(id);
	if (!canManage(getAuth(c), target.departmentId)) {
		throw new HTTPException(403, {
			message: "Ese perfil está fuera de tu ámbito.",
		});
	}
	return target;
}

/**
 * Listado acotado al ámbito (RN-03.2). Un `global_manager` ve todo; un
 * `department_head`, sólo los departamentos que gestiona.
 */
users.get(
	"/",
	requireRole("department_head"),
	validate("query", listUsersQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const filters = c.req.valid("query");

		// Si pide un departamento concreto, se comprueba el ámbito explícitamente:
		// devolver una lista vacía escondería que la respuesta correcta era un 403.
		if (filters.departmentId) requireScope(auth, filters.departmentId);

		const rows = await listUsers(
			{
				managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
					? "all"
					: auth.managedDepartmentIds,
			},
			filters,
		);

		return c.json(usersSpec.list.response.parse(rows));
	},
);

/**
 * Perfiles incompletos (RN-02.3). Antes de `/:id`, o el patrón se comería la ruta.
 * Sólo `global_manager`: es quien puede resolverlos asignando departamento.
 */
users.get("/incomplete", requireRole("global_manager"), async (c) => {
	const rows = await listIncompleteUsers();
	return c.json(usersSpec.incomplete.response.parse(rows));
});

users.get(
	"/:id",
	requireRole("department_head"),
	validate("param", idParam),
	async (c) => {
		const { id } = c.req.valid("param");
		await requireManageable(c, id);

		const user = await getUser(id);
		if (!user) {
			throw new HTTPException(404, { message: "Ese perfil no existe." });
		}
		return c.json(usersSpec.detail.response.parse(user));
	},
);

users.patch(
	"/:id",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateUserInputSchema),
	async (c) => {
		const updated = await updateUser(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(usersSpec.update.response.parse(updated));
	},
);

users.post(
	"/:id/deactivate",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", deactivateUserInputSchema),
	async (c) => {
		const updated = await deactivateUser(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(usersSpec.deactivate.response.parse(updated));
	},
);

users.post(
	"/:id/reactivate",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		const updated = await reactivateUser(c.req.valid("param").id, actorOf(c));
		return c.json(usersSpec.reactivate.response.parse(updated));
	},
);

/** Borra el perfil, nunca la cuenta del IS (RN-02.8). */
users.delete(
	"/:id",
	requireRole("superadmin"),
	validate("param", idParam),
	async (c) => {
		await deleteUser(c.req.valid("param").id, actorOf(c));
		return c.json({ ok: true } as const);
	},
);

/**
 * Compensación (spec 02 §6). Endpoints separados y con su propio rol mínimo: son
 * los únicos que tocan `employee_compensation`, así que el dato salarial no puede
 * salir por ninguna otra parte.
 */
users.get(
	"/:id/compensation",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		const compensation = await getCompensation(c.req.valid("param").id);
		return c.json(usersSpec.compensation.response.parse(compensation));
	},
);

users.put(
	"/:id/compensation",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateCompensationInputSchema),
	async (c) => {
		const compensation = await setCompensation(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(usersSpec.updateCompensation.response.parse(compensation));
	},
);

/**
 * Ámbito departamental (spec 03 §7). Los **roles** no se tocan desde aquí
 * (RN-03.8): se otorgan en la consola del Identity Server, que es donde queda su
 * rastro. Lo que sí se gestiona y se audita en este sistema son los
 * departamentos adicionales que forman el ámbito de un `department_head`
 * (RN-03.2).
 */
users.get(
	"/:id/department-responsibilities",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		const responsibilities = await getResponsibilities(c.req.valid("param").id);
		return c.json(usersSpec.responsibilities.response.parse(responsibilities));
	},
);

users.put(
	"/:id/department-responsibilities",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateDepartmentResponsibilitiesInputSchema),
	async (c) => {
		const responsibilities = await setResponsibilities(
			c.req.valid("param").id,
			c.req.valid("json").departmentIds,
			actorOf(c),
		);
		return c.json(
			usersSpec.updateResponsibilities.response.parse(responsibilities),
		);
	},
);

/**
 * Descansos de otra persona (spec 10 §6, matriz de la §4): un `department_head`
 * ve y edita los de su ámbito. La configuración propia va por `/api/me`.
 */
users.get(
	"/:id/rest-schedule",
	requireRole("department_head"),
	validate("param", idParam),
	validate("query", restScheduleQuerySchema),
	async (c) => {
		const { id } = c.req.valid("param");
		await requireManageable(c, id);

		const view = await getRestScheduleView(
			id,
			{ role: getAuth(c).effectiveRole, isSelf: getAuth(c).profile.id === id },
			c.req.valid("query").date,
		);
		return c.json(restSpec.ofUser.response.parse(view));
	},
);

users.put(
	"/:id/rest-schedule",
	requireRole("department_head"),
	validate("param", idParam),
	validate("json", updateRestScheduleInputSchema),
	async (c) => {
		const { id } = c.req.valid("param");
		await requireManageable(c, id);

		const view = await setRestSchedule(id, c.req.valid("json"), {
			...actorOf(c),
			role: getAuth(c).effectiveRole,
		});
		return c.json(restSpec.updateOfUser.response.parse(view));
	},
);
