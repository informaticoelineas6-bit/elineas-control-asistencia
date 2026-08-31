import { createApp } from "#/app.ts";
import { config } from "#/lib/config";

const app = createApp();

export default {
	port: config.port,
	// Explícito: dentro de un contenedor hay que escuchar en todas las
	// interfaces, no solo en loopback, para que el mapeo de puertos de Docker
	// pueda alcanzarlo.
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
