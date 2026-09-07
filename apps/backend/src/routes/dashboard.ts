import { dashboardSpec } from "@elineas/contracts";
import { dashboardTrendQuerySchema, roleAtLeast } from "@elineas/validations";
import { type Context, Hono } from "hono";
import { validate } from "#/lib/validate.ts";
import {
	type AuthContext,
	getAuth,
	requireAuth,
	requireRole,
} from "#/middleware/auth";
import {
	getDashboardAlerts,
	getDashboardSummary,
	getDashboardTrend,
} from "#/services/dashboard.ts";

/**
 * Dashboard de inicio (spec 15 §5.1). Montado en `/api/dashboard`.
 *
 * `summary` lo pide **cualquier autenticado** y su contenido lo decide el rol,
 * no un parámetro: la §5.1 describe tres filas de una tabla —empleado, jefe,
 * gestor— y son la misma pantalla con más o menos secciones, no tres pantallas.
 * Un empleado recibe lo suyo y `scope: null`.
 *
 * `trend` y `alerts` exigen al menos `department_head`, porque no existe una
 * versión "propia" de ellos que signifique algo: la tendencia de una sola
 * persona es su historial, que ya tiene en `/attendance/me`.
 */
export const dashboard = new Hono();

dashboard.use("*", requireAuth);

/** `"all"` para un gestor global; la lista concreta para un jefe (RN-03.2). */
const managedScope = (auth: AuthContext) => ({
	managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
		? ("all" as const)
		: auth.managedDepartmentIds,
});

dashboard.get("/summary", async (c: Context) => {
	const auth = getAuth(c);
	const summary = await getDashboardSummary({
		profile: auth.profile,
		role: auth.effectiveRole,
		scope: managedScope(auth),
	});
	return c.json(dashboardSpec.summary.response.parse(summary));
});

dashboard.get(
	"/trend",
	requireRole("department_head"),
	validate("query", dashboardTrendQuerySchema),
	async (c) => {
		const trend = await getDashboardTrend(
			managedScope(getAuth(c)),
			c.req.valid("query").days,
		);
		return c.json(dashboardSpec.trend.response.parse(trend));
	},
);

dashboard.get("/alerts", requireRole("department_head"), async (c: Context) => {
	const alerts = await getDashboardAlerts(managedScope(getAuth(c)));
	return c.json(dashboardSpec.alerts.response.parse(alerts));
});
