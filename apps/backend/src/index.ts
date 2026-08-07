import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "#/lib/auth";
import { todos } from "#/routes/todos";

const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3004";

const app = new Hono();

app.use(
	"*",
	cors({
		origin: frontendUrl,
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/todos", todos);

app.get("/api/health", (c) => c.json({ status: "ok" }));

const port = Number(process.env.PORT ?? 3001);

export default {
	port,
	// Explícito: dentro de un contenedor hay que escuchar en todas las
	// interfaces, no solo en loopback, para que el mapeo de puertos de Docker
	// pueda alcanzarlo.
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
