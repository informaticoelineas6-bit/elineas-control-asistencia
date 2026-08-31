import {
	configSchema,
	publicConfigSchema,
	updateConfigInputSchema,
} from "@elineas/validations";

/**
 * Contrato de configuración global (spec 06 §5).
 *
 * Dos lecturas distintas y a propósito: `get` devuelve la tabla entera y es sólo
 * para `global_manager+` (RN-06.1); `getPublic` devuelve el subconjunto seguro
 * que necesita cualquier rol para que la interfaz aplique las mismas reglas que
 * el servidor —zona horaria, tolerancia y modo de salida— sin ver el resto.
 */
export const configSpec = {
	get: {
		method: "GET",
		path: "/api/config",
		response: configSchema,
	},
	update: {
		method: "PATCH",
		path: "/api/config",
		body: updateConfigInputSchema,
		response: configSchema,
	},
	getPublic: {
		method: "GET",
		path: "/api/config/public",
		response: publicConfigSchema,
	},
} as const;
