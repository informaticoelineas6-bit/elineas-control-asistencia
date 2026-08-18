import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { config as appConfig } from "#/lib/config";
import { auth } from "#/routes/auth";
import { config as configRoutes } from "#/routes/config.ts";
import { departments } from "#/routes/departments.ts";
import { me } from "#/routes/me";
import { notifications } from "#/routes/notifications.ts";
import { users } from "#/routes/users.ts";

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
	app.route("/api/notifications", notifications);
	app.route("/api/config", configRoutes);
	app.route("/api/users", users);

	app.get("/api/health", (c) => c.json({ status: "ok" }));

	return app;
}
