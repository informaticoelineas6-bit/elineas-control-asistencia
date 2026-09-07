import { absencesSpec } from "@elineas/contracts";
import {
	isoDateSchema,
	listAbsenceReviewsQuerySchema,
	pendingAbsencesQuerySchema,
	reviewAbsenceInputSchema,
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
	requireRole,
	requireScope,
} from "#/middleware/auth";
import {
	absenceTargetOf,
	countPendingAbsences,
	listAbsenceReviews,
	listPendingAbsences,
	reviewAbsence,
} from "#/services/absences.ts";

/**
 * Justificación de ausencias (spec 13 §6). Montado en `/api/absences`.
 *
 * **Todo el router exige al menos `department_head`** (RN-13.3), con
 * `requireRole` sobre `*` en vez de endpoint por endpoint: aquí no hay ninguna
 * operación que un `employee` pueda hacer, ni siquiera de lectura, así que la
 * puerta va en la entrada. Es lo contrario de `/incidents` y `/vacations`, donde
 * el ámbito propio conviven con el de gestión y por eso la comprobación es por
 * ruta.
 *
 * ⚠️ **Ningún endpoint de nómina cuelga de aquí, ni de ningún otro sitio.** El
 * efecto económico viaja en la respuesta de la revisión y lo escribe el servicio
 * (RN-13.5); `/payroll/*` llega con la spec 17 y con su propio `requireRole`.
 */
export const absences = new Hono();

absences.use("*", requireAuth);
absences.use("*", requireRole("department_head"));

const targetParams = z.object({
	userId: z.uuid("El identificador de persona no es válido."),
	date: isoDateSchema,
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/** `"all"` para un gestor global; la lista concreta para un jefe (RN-03.2). */
const managedScope = (auth: AuthContext) => ({
	managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
		? ("all" as const)
		: auth.managedDepartmentIds,
});

/**
 * `GET /absences/pending?from=&to=&departmentId=` (§5): los días ausentes sin
 * decisión del ámbito. Sin rango, los últimos 30 días.
 */
absences.get(
	"/pending",
	validate("query", pendingAbsencesQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const query = c.req.valid("query");
		if (query.departmentId) requireScope(auth, query.departmentId);

		const rows = await listPendingAbsences(managedScope(auth), query);
		return c.json(absencesSpec.pending.response.parse(rows));
	},
);

/** `GET /absences/pending-count` — el badge de RN-05.8. */
absences.get(
	"/pending-count",
	validate("query", pendingAbsencesQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const query = c.req.valid("query");
		if (query.departmentId) requireScope(auth, query.departmentId);

		const count = await countPendingAbsences(managedScope(auth), query);
		return c.json(absencesSpec.pendingCount.response.parse({ count }));
	},
);

/** `GET /absences?userId=&from=&to=`: las decisiones ya tomadas del ámbito. */
absences.get(
	"/",
	validate("query", listAbsenceReviewsQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const rows = await listAbsenceReviews(
			managedScope(auth),
			c.req.valid("query"),
		);
		return c.json(absencesSpec.list.response.parse(rows));
	},
);

/**
 * `PUT /absences/:userId/:date` (RN-13.2, upsert).
 *
 * El ámbito se comprueba contra el **departamento de la persona revisada**,
 * leído de su perfil — mismo patrón que en incidencias y vacaciones. El
 * autobloqueo de RN-13.3 lo aplica el servicio.
 */
absences.put(
	"/:userId/:date",
	validate("param", targetParams),
	validate("json", reviewAbsenceInputSchema),
	async (c) => {
		const auth = getAuth(c);
		const { userId, date } = c.req.valid("param");

		const target = await absenceTargetOf(userId);
		if (!canManage(auth, target.departmentId)) {
			throw new HTTPException(403, {
				message: "Esa persona está fuera de tu ámbito.",
			});
		}

		const result = await reviewAbsence(
			target,
			date,
			c.req.valid("json"),
			actorOf(c),
		);

		// RN-17.1 / hallazgo H-3: el importe sólo viaja a un rol administrativo.
		// Quien justifica es el jefe, y el descuento es su sueldo dividido por el
		// divisor — enseñárselo le enseña el sueldo. Ve el hecho, no la cifra.
		const canSeeAmounts = roleAtLeast(auth.effectiveRole, "global_manager");
		return c.json(
			absencesSpec.review.response.parse({
				...result,
				payrollAdjustment: canSeeAmounts
					? result.payrollAdjustment
					: { ...result.payrollAdjustment, amount: null, currency: null },
			}),
		);
	},
);
