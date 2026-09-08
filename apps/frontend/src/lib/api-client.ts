const backendUrl = import.meta.env.VITE_BACKEND_URL;

/**
 * La URL absoluta de un path del backend.
 *
 * `apiFetch` no sirve para todo: el flujo de notificaciones en vivo (spec 14
 * RN-14.4) lo abre `EventSource`, que construye la petición por su cuenta y sólo
 * acepta una URL. Esto evita que el módulo de notificaciones tenga que leer
 * `VITE_BACKEND_URL` por segunda vez.
 */
export const apiUrl = (path: string): string => `${backendUrl}${path}`;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * Llamada al backend con las cookies de sesión incluidas.
 *
 * `credentials: "include"` es imprescindible: los tokens del Identity Server
 * viven en cookies httpOnly del origen del backend y el JavaScript de esta app
 * no puede —ni debe— leerlos (RN-00.36).
 */
export async function apiFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(`${backendUrl}${path}`, {
		...init,
		credentials: "include",
		headers: {
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
}

/** Lanza `ApiError` con el mensaje que manda el backend, no uno genérico. */
export async function apiError(res: Response): Promise<ApiError> {
	let message = "No se pudo completar la operación.";
	try {
		const body = (await res.json()) as { error?: string };
		if (body.error) message = body.error;
	} catch {
		// respuesta sin cuerpo JSON: nos quedamos con el mensaje por defecto
	}
	return new ApiError(res.status, message);
}

/**
 * Petición al backend que devuelve JSON validado por el esquema del contrato.
 *
 * Validar la respuesta no es ceremonia: es lo que hace que un cambio en el
 * backend falle aquí y ahora, con un mensaje claro, en vez de pintar
 * `undefined` tres componentes más abajo (api-conventions.md).
 *
 * El esquema se pide de forma estructural (`{ parse }`) para no depender de Zod
 * directamente desde el frontend: la única fuente de esquemas es
 * `@elineas/contracts`.
 */
export async function apiJson<T>(
	path: string,
	schema: { parse: (value: unknown) => T },
	init: RequestInit = {},
): Promise<T> {
	const res = await apiFetch(path, init);
	if (!res.ok) throw await apiError(res);
	return schema.parse(await res.json());
}
