import { incidentsSpec } from "@elineas/contracts";
import {
	createIncidentInputSchema,
	listIncidentsQuerySchema,
	ownBlockedMarksQuerySchema,
	pendingIncidentsCountQuerySchema,
	reviewIncidentInputSchema,
	roleAtLeast,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import {
	type AuthContext,
	canManage,
	getAuth,
	requireAuth,
	requireScope,
} from "#/middleware/auth";
import { listBlockedMarksOfWorkDate } from "#/services/attendance.ts";
import {
	countPendingIncidents,
	getIncidentContext,
	incidentOwnerOf,
	listManagedIncidents,
	listOwnIncidents,
	reportIncident,
	reviewIncident,
} from "#/services/incidents.ts";

/**
 * Incidencias de asistencia (spec 12 §7). Montado en `/api/incidents`.
 *
 * Los cinco endpoints se reparten en dos ámbitos, como en vacaciones: lo propio
 * —que cualquiera con sesión puede pedir y que **no acepta un identificador de
 * persona**, así que no hay forma de leer ni de reportar por otro (RN-12.3)— y
 * el de gestión, que exige al menos `department_head` y se acota al ámbito de
 * quien pregunta (RN-12.6, RN-03.2).
 */
export const incidents = new Hono();

incidents.use("*", requireAuth);

const idParam = z.object({
	id: z.uuid("El identificador de incidencia no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/** El ámbito tal como lo espera el servicio: `"all"` para un gestor global. */
const managedScope = (auth: AuthContext) => ({
	managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
		? ("all" as const)
		: auth.managedDepartmentIds,
});

function requireManagementRole(auth: AuthContext): void {
	if (!roleAtLeast(auth.effectiveRole, "department_head")) {
		throw new HTTPException(403, {
			message: "No tienes ámbito de gestión sobre incidencias.",
		});
	}
}

/**
 * `GET /incidents?status=&scope=&departmentId=&incidentType=&search=`.
 *
 * `scope=own` (el default) son las propias. `scope=managed` es la bandeja de
 * revisión; con `departmentId` se acota a uno del ámbito, comprobado con
 * `requireScope` como en `/users`.
 */
incidents.get("/", validate("query", listIncidentsQuerySchema), async (c) => {
	const auth = getAuth(c);
	const query = c.req.valid("query");

	if (query.scope === "own") {
		const rows = await listOwnIncidents(auth.profile.id, query);
		return c.json(incidentsSpec.list.response.parse(rows));
	}

	requireManagementRole(auth);
	if (query.departmentId) requireScope(auth, query.departmentId);

	const rows = await listManagedIncidents(managedScope(auth), query);
	return c.json(incidentsSpec.list.response.parse(rows));
});

/**
 * `POST /incidents`: siempre para uno mismo (RN-12.3). Responde 201 porque crea
 * un recurso, igual que la solicitud de vacaciones.
 */
incidents.post("/", validate("json", createIncidentInputSchema), async (c) => {
	const auth = getAuth(c);
	const created = await reportIncident(
		auth.profile,
		c.req.valid("json"),
		actorOf(c),
	);
	return c.json(incidentsSpec.report.response.parse(created), 201);
});

/**
 * `GET /incidents/pending-count?scope=` — el badge de la navegación (RN-05.8).
 * `own` cuenta las propias sin revisar (§6); `managed`, las que esperan por
 * quien pregunta.
 */
incidents.get(
	"/pending-count",
	validate("query", pendingIncidentsCountQuerySchema),
	async (c) => {
		const auth = getAuth(c);

		if (c.req.valid("query").scope === "own") {
			const count = await countPendingIncidents({ userId: auth.profile.id });
			return c.json(incidentsSpec.pendingCount.response.parse({ count }));
		}

		requireManagementRole(auth);
		const count = await countPendingIncidents(managedScope(auth));
		return c.json(incidentsSpec.pendingCount.response.parse({ count }));
	},
);

/**
 * `GET /incidents/blocked-marks?date=`: los intentos rechazados **propios** de
 * ese día, para poder abrir la incidencia desde la fila que la explica (RN-12.2).
 * Sin parámetro de persona, como todo lo propio.
 */
incidents.get(
	"/blocked-marks",
	validate("query", ownBlockedMarksQuerySchema),
	async (c) => {
		const marks = await listBlockedMarksOfWorkDate(
			getAuth(c).profile.id,
			c.req.valid("query").date,
		);
		return c.json(incidentsSpec.blockedMarks.response.parse(marks));
	},
);

/**
 * Ámbito sobre una incidencia concreta: el **departamento de quien reportó**, no
 * un parámetro del cliente — se resuelve leyendo la fila, igual que en
 * vacaciones y en los grupos de descanso.
 *
 * `allowOwner` distingue los dos usos: el contexto lo puede ver también quien
 * reportó (es su propio día), pero revisar es sólo de la gestión, y ahí el
 * autobloqueo de RN-12.6 lo aplica el servicio, que conoce `incident.userId`.
 */
async function requireIncidentScope(
	c: Context,
	id: string,
	options: { allowOwner: boolean },
): Promise<void> {
	const auth = getAuth(c);
	const owner = await incidentOwnerOf(id);

	if (options.allowOwner && owner.userId === auth.profile.id) return;
	if (canManage(auth, owner.departmentId)) return;

	throw new HTTPException(403, {
		message: "Esa incidencia está fuera de tu ámbito.",
	});
}

/**
 * `GET /incidents/:id/context` (§6): el día de la incidencia con su estado
 * calculado, sus marcas y los intentos rechazados de esa jornada.
 */
incidents.get("/:id/context", validate("param", idParam), async (c) => {
	const { id } = c.req.valid("param");
	await requireIncidentScope(c, id, { allowOwner: true });
	return c.json(
		incidentsSpec.context.response.parse(await getIncidentContext(id)),
	);
});

/** `POST /incidents/:id/review` (RN-12.6, RN-12.7, RN-12.8). */
incidents.post(
	"/:id/review",
	validate("param", idParam),
	validate("json", reviewIncidentInputSchema),
	async (c) => {
		const { id } = c.req.valid("param");
		requireManagementRole(getAuth(c));
		await requireIncidentScope(c, id, { allowOwner: false });

		const reviewed = await reviewIncident(id, c.req.valid("json"), actorOf(c));
		return c.json(incidentsSpec.review.response.parse(reviewed));
	},
);
