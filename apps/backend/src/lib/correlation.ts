import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

/**
 * RN-18.8 — El identificador de correlación de una cadena de acciones.
 *
 * La regla pide que una acción con efectos en cascada —justificar una ausencia →
 * ajuste de nómina → notificación— comparta un identificador entre sus entradas
 * de bitácora, para poder leer la cadena completa. Lo difícil no es generarlo:
 * es **hacerlo llegar** a las tres escrituras sin pasarlo a mano por cada
 * servicio.
 *
 * Pasarlo como argumento sería repetir el error que la spec 18 §5 diagnostica en
 * el legacy: *"lo que nadie recordó instrumentar, no se auditó"*. Cada nueva
 * llamada a `audit()` tendría que acordarse de propagar el id, y la que se
 * olvidara rompería justo la cadena que la regla quiere poder leer — sin fallar
 * ni avisar.
 *
 * Así que vive en un `AsyncLocalStorage`: el middleware abre un ámbito por
 * petición y `audit()` lo lee sola. **Ningún servicio de dominio se entera**, y
 * una escritura nueva queda correlacionada sin escribir una línea para ello.
 *
 * Fuera de una petición —los procesos de fondo de la spec 16— el ámbito lo abre
 * `withCorrelationId` en cada vuelta del temporizador, así que las entradas de
 * una misma corrida comparten id y las de dos corridas no se confunden.
 */
const storage = new AsyncLocalStorage<string>();

/** Un ámbito de correlación por petición HTTP. */
export const correlate: MiddlewareHandler = (_c, next) =>
	storage.run(crypto.randomUUID(), next);

/** Un ámbito de correlación alrededor de una tarea que no nace de una petición. */
export const withCorrelationId = <T>(task: () => Promise<T>): Promise<T> =>
	storage.run(crypto.randomUUID(), task);

/** Nulo cuando la escritura no ocurre dentro de ningún ámbito (p. ej. en pruebas). */
export const currentCorrelationId = (): string | null =>
	storage.getStore() ?? null;
