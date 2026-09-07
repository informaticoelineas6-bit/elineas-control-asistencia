import { vacationsSpec } from "@elineas/contracts";
import {
	createVacationRequestInputSchema,
	listVacationRequestsQuerySchema,
	reviewVacationRequestInputSchema,
	roleAtLeast,
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
	requireScope,
} from "#/middleware/auth";
import {
	cancelVacationRequest,
	departmentOfVacationRequest,
	listManagedVacationRequests,
	listOwnVacationRequests,
	requestVacation,
	reviewVacationRequest,
} from "#/services/vacations.ts";

/**
 * Solicitudes de vacaciones (spec 11 §6). Montado en `/api/vacations`.
 *
 * El saldo (`GET /balance`) no vive aquí: cuelga de `/me` y de `/users/:id`,
 * junto al resto de "lo mío" y "lo de otra persona" — mismo criterio que el
 * horario y los descansos de las specs 07 y 10.
 */
export const vacations = new Hono();

vacations.use("*", requireAuth);

const idParam = z.object({
	id: z.uuid("El identificador de solicitud no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/**
 * `GET /vacations/requests?status=&scope=&departmentId=`.
 *
 * `scope=own` (el default) es lo que cualquiera puede pedir: las suyas, sin
 * parámetro de persona posible — mismo criterio que `/attendance/me`.
 * `scope=managed` es la bandeja de revisión y exige al menos `department_head`;
 * con `departmentId` se acota a uno del ámbito, comprobado con `requireScope`
 * como en `/users`.
 */
vacations.get(
	"/requests",
	validate("query", listVacationRequestsQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const query = c.req.valid("query");

		if (query.scope === "own") {
			const rows = await listOwnVacationRequests(auth.profile.id, query.status);
			return c.json(vacationsSpec.list.response.parse(rows));
		}

		if (!roleAtLeast(auth.effectiveRole, "department_head")) {
			throw new HTTPException(403, {
				message: "No tienes ámbito de gestión sobre vacaciones.",
			});
		}
		if (query.departmentId) requireScope(auth, query.departmentId);

		const rows = await listManagedVacationRequests(
			{
				managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
					? "all"
					: auth.managedDepartmentIds,
			},
			query,
		);
		return c.json(vacationsSpec.list.response.parse(rows));
	},
);

/**
 * `POST /vacations/requests`: siempre para uno mismo. Pedir vacaciones para
 * otra persona no está en la spec (§5.1 empieza con "el empleado ve su saldo",
 * en primera persona) y crearía un endpoint que nadie ha pedido para saltarse
 * el flujo de aprobación.
 */
vacations.post(
	"/requests",
	validate("json", createVacationRequestInputSchema),
	async (c) => {
		const auth = getAuth(c);
		const created = await requestVacation(
			auth.profile,
			auth.effectiveRole,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(vacationsSpec.request.response.parse(created), 201);
	},
);

/** `POST /vacations/requests/:id/cancel` (RN-11.10): quien la pidió o rol administrativo. */
vacations.post(
	"/requests/:id/cancel",
	validate("param", idParam),
	async (c) => {
		const auth = getAuth(c);
		const cancelled = await cancelVacationRequest(c.req.valid("param").id, {
			...actorOf(c),
			role: auth.effectiveRole,
		});
		return c.json(vacationsSpec.cancel.response.parse(cancelled));
	},
);

/**
 * `POST /vacations/requests/:id/review` (RN-11.8): ámbito sobre el
 * **departamento de quien pidió**, no un parámetro del cliente — se resuelve
 * leyendo la solicitud, mismo patrón que `departmentOfGroup` en la spec 10. El
 * autobloqueo ("nadie revisa la suya") lo comprueba el servicio, que es quien
 * conoce `request.userId`.
 */
vacations.post(
	"/requests/:id/review",
	validate("param", idParam),
	validate("json", reviewVacationRequestInputSchema),
	async (c) => {
		const { id } = c.req.valid("param");
		const auth = getAuth(c);

		const departmentId = await departmentOfVacationRequest(id);
		if (!canManage(auth, departmentId)) {
			throw new HTTPException(403, {
				message: "Esa solicitud está fuera de tu ámbito.",
			});
		}

		const reviewed = await reviewVacationRequest(
			id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(vacationsSpec.review.response.parse(reviewed));
	},
);
