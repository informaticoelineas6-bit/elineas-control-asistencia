/**
 * Resuelve los parámetros de un `path` de contrato.
 *
 * Los paths se escriben una sola vez, en el contrato, con la misma sintaxis que
 * usa Hono (`/api/departments/:id`). El backend los monta tal cual; el frontend
 * los resuelve con esta función. Así no hay dos verdades sobre la URL de un
 * endpoint, que es justo lo que evita que backend y frontend se desincronicen
 * (api-conventions.md).
 */
export function resolvePath(
	path: string,
	params: Record<string, string> = {},
): string {
	const resolved = path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
		const value = params[name];
		if (value === undefined) {
			throw new Error(`Falta el parámetro "${name}" para el path "${path}".`);
		}
		return encodeURIComponent(value);
	});

	return resolved;
}

/** Añade los parámetros de consulta que estén definidos. */
export function withQuery(
	path: string,
	query: Record<string, string | number | boolean | undefined> = {},
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) search.set(key, String(value));
	}
	const suffix = search.toString();
	return suffix ? `${path}?${suffix}` : path;
}
