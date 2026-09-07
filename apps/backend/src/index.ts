import { createApp } from "#/app.ts";
import { config } from "#/lib/config";
import { refreshYesterday } from "#/services/daily-facts-store.ts";
import { processQueuedRuns } from "#/services/report-runs.ts";

const app = createApp();

/**
 * Los dos procesos de fondo de la spec 16, y **están aquí a propósito**.
 *
 * `app.ts` construye la aplicación y es lo que importan las pruebas; si los
 * temporizadores vivieran allí, cada archivo de pruebas arrancaría un
 * trabajador que escribiría en la base mientras el caso hace sus
 * comprobaciones. Aquí sólo llegan cuando el servidor se sirve de verdad, y las
 * pruebas llaman a las mismas funciones cuando les toca.
 *
 * - **La cola de reportes** (§3): un reporte mensual de toda la empresa no se
 *   genera en una petición HTTP. Se mira cada pocos segundos, no cada
 *   milisegundo: la interfaz sondea cada 15 s (RN-16.6), así que adelantarse más
 *   no se nota.
 * - **El refresco del día anterior** (RN-16.9): el proceso programado que
 *   mantiene los hechos diarios al día. Corre al arrancar y luego cada hora, en
 *   vez de a una hora fija: sin un planificador externo, "cada hora" garantiza
 *   que el día anterior queda calculado aunque el contenedor se reinicie a
 *   cualquier hora, y recalcular lo mismo es inocuo por RN-16.10.
 */
const QUEUE_TICK_MS = 5_000;
const FACTS_TICK_MS = 60 * 60 * 1000;

function background(
	name: string,
	task: () => Promise<unknown>,
	everyMs: number,
) {
	const tick = async () => {
		try {
			await task();
		} catch (error) {
			// Un fallo de fondo no debe tumbar el servidor ni quedarse callado.
			console.error(`[${name}] falló:`, error);
		}
	};

	void tick();
	setInterval(tick, everyMs).unref();
}

background("cola de reportes", processQueuedRuns, QUEUE_TICK_MS);
background("hechos diarios", refreshYesterday, FACTS_TICK_MS);

export default {
	port: config.port,
	// Explícito: dentro de un contenedor hay que escuchar en todas las
	// interfaces, no solo en loopback, para que el mapeo de puertos de Docker
	// pueda alcanzarlo.
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
