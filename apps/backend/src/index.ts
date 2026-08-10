import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { config } from "#/lib/config";
import { auth } from "#/routes/auth";
import { me } from "#/routes/me";

const app = new Hono();

app.use(
	"*",
	cors({
		origin: config.frontendUrl,
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

app.get("/api/health", (c) => c.json({ status: "ok" }));

export default {
	port: config.port,
	// Explícito: dentro de un contenedor hay que escuchar en todas las
	// interfaces, no solo en loopback, para que el mapeo de puertos de Docker
	// pueda alcanzarlo.
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
