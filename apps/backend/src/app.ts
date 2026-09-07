import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { config as appConfig } from "#/lib/config";
import { absences } from "#/routes/absences.ts";
import { attendance } from "#/routes/attendance.ts";
import { auth } from "#/routes/auth";
import { config as configRoutes } from "#/routes/config.ts";
import { dashboard } from "#/routes/dashboard.ts";
import { departments } from "#/routes/departments.ts";
import { incidents } from "#/routes/incidents.ts";
import { locations } from "#/routes/locations.ts";
import { me } from "#/routes/me";
import { notifications } from "#/routes/notifications.ts";
import { attendanceFacts, reports } from "#/routes/reports.ts";
import { departmentRest, restGroupsRouter } from "#/routes/rest.ts";
import { schedules } from "#/routes/schedules.ts";
import { users } from "#/routes/users.ts";
import { vacations } from "#/routes/vacations.ts";

/**
 * Construye la aplicación con todas sus rutas.
 *
 * Está separada de `index.ts` —que es quien la sirve— para que las pruebas puedan
 * pedirle respuestas con `app.request()` sin abrir un puerto.
 */
export function createApp() {
	const app = new Hono();

	app.use(
		"*",
		cors({
			origin: appConfig.frontendUrl,
			credentials: true,
			allowHeaders: ["Content-Type"],
			allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		}),
	);

	// Errores en un solo formato: el frontend siempre encuentra `error` con un
	// mensaje comprensible, no un volcado genérico (criterio de aceptación de la
	// spec 00: "un mensaje comprensible, no un error genérico").
	app.onError((err, c) => {
		if (err instanceof HTTPException) {
			return c.json({ error: err.message }, err.status);
		}
		console.error(err);
		return c.json({ error: "Error interno del servidor." }, 500);
	});

	app.route("/api/auth", auth);
	app.route("/api/me", me);
	app.route("/api/departments", departments);
	// Dos routers sobre el mismo prefijo: los horarios y el calendario (spec 07)
	// cuelgan del departamento pero son otro dominio, con su propio servicio y sus
	// propias reglas de rol. Los paths no se solapan.
	app.route("/api/departments", schedules);
	// Y un tercero: los grupos de descanso (spec 10) también cuelgan del
	// departamento. Los paths no se solapan y cada dominio conserva su servicio.
	app.route("/api/departments", departmentRest);
	app.route("/api/work-locations", locations);
	// **Antes** que `/api/attendance`: los dos prefijos se solapan, y el router
	// más específico tiene que poder atender lo suyo antes de que el general
	// responda 404 por no conocer esa ruta.
	app.route("/api/attendance/facts", attendanceFacts);
	app.route("/api/attendance", attendance);
	app.route("/api/incidents", incidents);
	app.route("/api/absences", absences);
	app.route("/api/dashboard", dashboard);
	app.route("/api/reports", reports);
	app.route("/api/notifications", notifications);
	app.route("/api/rest-groups", restGroupsRouter);
	app.route("/api/config", configRoutes);
	app.route("/api/users", users);
	app.route("/api/vacations", vacations);

	app.get("/api/health", (c) => c.json({ status: "ok" }));

	return app;
}
