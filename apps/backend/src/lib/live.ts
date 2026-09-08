import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

/**
 * RN-14.4 — La mitad "en vivo" de la entrega de notificaciones.
 *
 * Aquí no hay ni un dato de notificación: sólo el aviso de que **algo cambió**
 * para una persona, y a quién hay que decírselo. El contenido lo pide el cliente
 * por `GET /notifications` como siempre, así que el aislamiento de RN-14.1 se
 * comprueba en un solo sitio y no en dos.
 *
 * **Dos cosas que no son obvias y que dan forma al archivo:**
 *
 * 1. **El aviso se publica cuando la transacción ya escribió, no cuando se
 *    llama a `notify()`.** Una notificación nace dentro de la transacción del
 *    hecho que la origina (RN-14.2): si el aviso saliera en ese momento, el
 *    cliente volvería a preguntar **antes** del `COMMIT`, no vería nada nuevo y
 *    se quedaría con el contador viejo hasta el siguiente sondeo — treinta
 *    segundos de "no ha pasado nada" justo después de que pasara. Y si la
 *    transacción se revirtiera, habría avisado de algo que no existe.
 *
 *    Así que los destinatarios se acumulan en un `AsyncLocalStorage` y se
 *    publican **después** de que el handler termine, en el mismo middleware que
 *    abrió el ámbito. Si el handler falla, no se publica nada.
 *
 * 2. **El ámbito se abre por petición, igual que el de correlación** (RN-18.8,
 *    `lib/correlation.ts`), y por el mismo motivo de fondo: que ningún servicio
 *    de dominio tenga que acordarse de nada. `notify()` encola; el resto sale
 *    solo.
 *
 * Fuera de un ámbito —una tarea de fondo que no pasa por el middleware— se
 * publica en el momento. Es correcto porque esas tareas escriben en su propia
 * transacción y ya está confirmada cuando terminan, y en el peor caso un aviso
 * temprano sólo provoca una consulta de más.
 */

/** Lo que hace un suscriptor cuando le toca: despertar y volver a preguntar. */
type Wake = () => void;

const subscribers = new Map<string, Set<Wake>>();

/**
 * Registra un suscriptor —una conexión SSE abierta— y devuelve cómo darse de
 * baja. **Hay que llamarla**: sin eso, cada recarga de pestaña dejaría un
 * suscriptor muerto en el mapa y el proceso acumularía memoria durante días.
 */
export function subscribeLiveUpdates(userId: string, wake: Wake): () => void {
	const set = subscribers.get(userId) ?? new Set<Wake>();
	set.add(wake);
	subscribers.set(userId, set);

	return () => {
		set.delete(wake);
		if (set.size === 0) subscribers.delete(userId);
	};
}

/** Cuántas conexiones hay abiertas. Sólo para diagnóstico y pruebas. */
export const liveSubscriberCount = (userId: string): number =>
	subscribers.get(userId)?.size ?? 0;

const pending = new AsyncLocalStorage<Set<string>>();

/**
 * Encola un aviso para estas personas. La llama `notify()`, y nadie más
 * debería: un aviso sin notificación detrás manda al cliente a preguntar por
 * nada.
 */
export function queueLiveUpdate(userIds: readonly string[]): void {
	const store = pending.getStore();
	if (!store) {
		publish(userIds);
		return;
	}
	for (const userId of userIds) store.add(userId);
}

function publish(userIds: Iterable<string>): void {
	for (const userId of userIds) {
		for (const wake of subscribers.get(userId) ?? []) {
			// Un suscriptor que revienta al despertar no puede tumbar la petición
			// que provocó el aviso: el sondeo de respaldo lo cubre.
			try {
				wake();
			} catch (error) {
				console.error("[live] un suscriptor falló al despertar:", error);
			}
		}
	}
}

/** Abre el ámbito y publica al terminar. Sólo si terminó bien. */
export const liveUpdates: MiddlewareHandler = async (_c, next) => {
	const store = new Set<string>();
	await pending.run(store, next);
	publish(store);
};

/** El mismo ámbito alrededor de una tarea que no nace de una petición. */
export async function withLiveScope<T>(task: () => Promise<T>): Promise<T> {
	const store = new Set<string>();
	const result = await pending.run(store, task);
	publish(store);
	return result;
}
