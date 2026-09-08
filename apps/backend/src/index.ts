import { createApp } from "#/app.ts";
import { config } from "#/lib/config";
import { withCorrelationId } from "#/lib/correlation.ts";
import { withLiveScope } from "#/lib/live.ts";
import { refreshYesterday } from "#/services/daily-facts-store.ts";
import { purgeReadNotifications } from "#/services/notifications.ts";
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
/**
 * La purga de notificaciones leídas (spec 14 RN-14.6) no tiene prisa ninguna:
 * es mantenimiento, y con `notification_retention_days` en 0 —el default— no
 * hace nada en absoluto. Una vez al día, y al arrancar.
 */
const PURGE_TICK_MS = 24 * 60 * 60 * 1000;

function background(
	name: string,
	task: () => Promise<unknown>,
	everyMs: number,
) {
	const tick = async () => {
		try {
			// RN-18.8 — Cada vuelta abre su propio ámbito de correlación: las
			// entradas de una corrida comparten identificador y las de dos corridas
			// distintas no se confunden. Y el de avisos en vivo (spec 14 RN-14.4),
			// para que lo que notifique un proceso de fondo salga cuando ya escribió.
			await withCorrelationId(() => withLiveScope(task));
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
background(
	"purga de notificaciones",
	async () => {
		const purged = await purgeReadNotifications();
		// Silencio cuando no hay nada que decir: con la clave en 0 esto correría
		// todos los días para escribir "purgué 0".
		if (purged > 0) {
			console.log(`[purga de notificaciones] ${purged} leídas eliminadas`);
		}
	},
	PURGE_TICK_MS,
);

export default {
	port: config.port,
	// Explícito: dentro de un contenedor hay que escuchar en todas las
	// interfaces, no solo en loopback, para que el mapeo de puertos de Docker
	// pueda alcanzarlo.
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
