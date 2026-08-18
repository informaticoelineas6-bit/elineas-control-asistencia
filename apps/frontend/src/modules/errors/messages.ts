import { ApiError } from "#/lib/api-client.ts";

/**
 * Traducción de errores a español (RN-05.10, RN-04.7).
 *
 * Equivalente al `error-messages.ts` del legacy. La regla es la misma: **el
 * código técnico se registra, no se enseña**. Un operario en planta que ve
 * "Failed to fetch" llama a soporte; uno que ve "No hay conexión con el
 * servidor" mira el wifi.
 *
 * Los errores del backend ya vienen en español —`ApiError` trae el mensaje que
 * escribió el handler— así que esos pasan tal cual. Lo que se traduce aquí es
 * todo lo demás: fallos de red, respuestas sin cuerpo, y los errores de
 * programación que no deberían llegar al usuario pero llegan.
 */

/** Mensajes por código HTTP, cuando el backend no mandó uno propio. */
const BY_STATUS: Record<number, string> = {
	400: "Los datos enviados no son válidos.",
	401: "Tu sesión expiró. Vuelve a iniciar sesión.",
	403: "No tienes permiso para esta operación.",
	404: "No encontramos lo que buscabas.",
	409: "La operación choca con el estado actual de los datos.",
	429: "Demasiadas peticiones seguidas. Espera un momento.",
	500: "Error interno del servidor.",
	502: "El servidor de identidad no respondió correctamente.",
	503: "El servicio no está disponible en este momento.",
};

const NETWORK_HINTS = [
	"failed to fetch",
	"networkerror",
	"load failed",
	"fetch failed",
	"network request failed",
];

export type FriendlyError = {
	/** Lo que se le enseña a la persona. Siempre en español. */
	message: string;
	/** Pista técnica para la consola y para el pie de la pantalla de error. */
	detail: string | null;
	/** `true` si reintentar tiene sentido (red caída, 5xx). */
	retryable: boolean;
};

export function friendlyError(error: unknown): FriendlyError {
	if (error instanceof ApiError) {
		return {
			// El backend responde siempre con `error` en español (`app.onError`); el
			// mapa por código es la red por si alguna respuesta llega sin cuerpo.
			message: error.message || BY_STATUS[error.status] || BY_STATUS[500],
			detail: `HTTP ${error.status}`,
			retryable: error.status >= 500 || error.status === 429,
		};
	}

	if (error instanceof Error) {
		const raw = error.message.toLowerCase();
		if (NETWORK_HINTS.some((hint) => raw.includes(hint))) {
			return {
				message:
					"No hay conexión con el servidor. Comprueba tu red e inténtalo otra vez.",
				detail: error.message,
				retryable: true,
			};
		}

		return {
			message: "Algo se rompió mientras cargábamos esta pantalla.",
			detail: `${error.name}: ${error.message}`,
			retryable: true,
		};
	}

	return {
		message: "Algo se rompió mientras cargábamos esta pantalla.",
		detail: typeof error === "string" ? error : null,
		retryable: true,
	};
}
