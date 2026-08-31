import {
	createWorkLocationInputSchema,
	devicePositionSchema,
	listWorkLocationsQuerySchema,
	locationVerdictSchema,
	myWorkLocationSchema,
	selectWorkLocationInputSchema,
	updateWorkLocationInputSchema,
	workLocationSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de sedes y geocerca (spec 08 §7).
 *
 * Roles mínimos que aplica el backend:
 * - **lista de activas**: cualquier autenticado — es el catálogo con el que se
 *   elige sede antes de marcar;
 * - **la lista completa** (`?includeInactive=true`) y **toda escritura**:
 *   `global_manager`, porque mover un centro o un radio decide quién puede marcar;
 * - **`/me/work-location`** y **`/me/location-check`**: cualquier autenticado, y
 *   sólo sobre lo suyo.
 *
 * Dos desvíos de la §7, ambos por coherencia con lo que ya existe:
 *
 * - No hay `GET /work-locations/all`: la lista completa se pide con
 *   `?includeInactive=true` sobre el mismo path, igual que
 *   `/departments?includePaused=` (spec 01). Un path por variante de filtro se
 *   multiplica en cuanto aparece el segundo filtro.
 * - Se añade `POST /:id/reactivate`. Desactivar sin poder reactivar es un callejón
 *   sin salida, y una sede no se borra nunca (RN-08.10), así que sin esto una sede
 *   apagada por error se queda apagada para siempre.
 */
export const locationsSpec = {
	list: {
		method: "GET",
		path: "/api/work-locations",
		query: listWorkLocationsQuerySchema,
		response: z.array(workLocationSchema),
	},
	create: {
		method: "POST",
		path: "/api/work-locations",
		body: createWorkLocationInputSchema,
		response: workLocationSchema,
	},
	update: {
		method: "PATCH",
		path: "/api/work-locations/:id",
		body: updateWorkLocationInputSchema,
		response: workLocationSchema,
	},
	deactivate: {
		method: "POST",
		path: "/api/work-locations/:id/deactivate",
		response: workLocationSchema,
	},
	reactivate: {
		method: "POST",
		path: "/api/work-locations/:id/reactivate",
		response: workLocationSchema,
	},
	mine: {
		method: "GET",
		path: "/api/me/work-location",
		response: myWorkLocationSchema,
	},
	select: {
		method: "PUT",
		path: "/api/me/work-location",
		body: selectWorkLocationInputSchema,
		response: myWorkLocationSchema,
	},
	/**
	 * Veredicto del servidor para una lectura del dispositivo (spec 08 §6). No
	 * escribe nada: no es un marcaje, es la consulta que resuelve *"la app dice que
	 * estoy fuera y estoy dentro"* con la cuenta que hace el servidor (RN-08.2).
	 */
	check: {
		method: "POST",
		path: "/api/me/location-check",
		body: devicePositionSchema,
		response: locationVerdictSchema,
	},
} as const;
