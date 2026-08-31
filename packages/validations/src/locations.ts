import { z } from "zod";
import { markRejectionReasonSchema } from "./attendance.ts";
import { distanceInMeters, latitudeSchema, longitudeSchema } from "./geo.ts";

/**
 * Sedes y geocerca (spec 08).
 *
 * Aquí vive **la geometría**, no sólo los esquemas: la distancia Haversine y el
 * veredicto de una geocerca son la misma cuenta en el servidor —que es la
 * autoridad (RN-08.2)— y en la interfaz, que necesita decir "estás a 180 m" antes
 * de que nadie intente marcar. Escribirla dos veces es garantizar que un día
 * discrepen, y la pregunta que resuelve es literalmente si alguien puede trabajar.
 *
 * Que el cliente calcule **no** significa que el servidor le crea: el backend
 * recalcula siempre a partir de lat/lng, y jamás acepta un `inside_geofence`
 * venido de fuera (RN-08.2). Compartir la función es compartir la regla, no la
 * confianza.
 *
 * Decisiones cerradas de la §9, para no volver a discutirlas al leer el código:
 *
 * 1. **Se valida contra la sede seleccionada** (RN-08.5), no contra la más
 *    cercana; el rechazo dice si hay otra activa en rango, para que el arreglo sea
 *    un toque y no una llamada a soporte.
 * 2. **La selección vive en el perfil**, no sólo en el dispositivo: sobrevive al
 *    cambio de teléfono y el servidor puede invalidarla al desactivar la sede
 *    (RN-08.6).
 * 3. El selector de ubicación usa **Leaflet con mosaicos de OpenStreetMap**, con
 *    degradación a coordenadas a mano si no cargan.
 * 4. El modo de salida por geocerca **se mantiene en la configuración con
 *    advertencia**; el seguimiento en segundo plano es de la spec 20.
 */

/**
 * Radio de la geocerca. El mínimo no es capricho: por debajo de unos metros, el
 * error del propio GPS deja a la gente fuera de su puesto de trabajo. El máximo
 * está alto a propósito — hay sedes que son una finca entera.
 */
export const radiusMetersSchema = z
	.number()
	.int("El radio se mide en metros enteros")
	.min(10, "Un radio menor de 10 m lo rechaza el propio error del GPS")
	.max(20_000, "El radio no puede pasar de 20 km");

/** Precisión reportada por el dispositivo que se considera aceptable. */
export const accuracyThresholdSchema = z
	.number()
	.int("El umbral se mide en metros enteros")
	.min(5, "Un umbral menor de 5 m no lo alcanza ningún teléfono")
	.max(1000, "El umbral no puede pasar de 1000 m");

export const workLocationNameSchema = z
	.string()
	.trim()
	.min(1, "El nombre de la sede es obligatorio")
	.max(80, "El nombre no puede pasar de 80 caracteres");

export const workLocationSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	centerLat: latitudeSchema,
	centerLng: longitudeSchema,
	radiusMeters: radiusMetersSchema,
	accuracyThreshold: accuracyThresholdSchema,
	/**
	 * RN-08.3. Con `true`, una lectura peor que el umbral **bloquea** el marcaje;
	 * con `false` se acepta y la precisión queda registrada para auditoría.
	 */
	blockOnPoorAccuracy: z.boolean(),
	isActive: z.boolean(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export const createWorkLocationInputSchema = z.object({
	name: workLocationNameSchema,
	centerLat: latitudeSchema,
	centerLng: longitudeSchema,
	radiusMeters: radiusMetersSchema,
	accuracyThreshold: accuracyThresholdSchema,
	/**
	 * Por defecto **advierte en vez de bloquear**: una sede recién creada no debe
	 * dejar a nadie sin poder marcar por un umbral que aún no se ha calibrado con
	 * los teléfonos que hay en planta. Endurecerlo es un interruptor; descubrir que
	 * bloqueaba de más es un turno perdido.
	 */
	blockOnPoorAccuracy: z.boolean().default(false),
});

/**
 * El parche se declara campo a campo y **no** con `.partial()` sobre el esquema de
 * alta: ese esquema le da un default a `blockOnPoorAccuracy`, y un default
 * sobrevive a `.partial()` — un `PATCH` que sólo cambiaba el radio llegaba al
 * servicio con `blockOnPoorAccuracy: false` y apagaba el bloqueo de una sede sin
 * que nadie lo hubiera pedido. Lo cazó la prueba del parche vacío.
 */
export const updateWorkLocationInputSchema = z
	.object({
		name: workLocationNameSchema.optional(),
		centerLat: latitudeSchema.optional(),
		centerLng: longitudeSchema.optional(),
		radiusMeters: radiusMetersSchema.optional(),
		accuracyThreshold: accuracyThresholdSchema.optional(),
		blockOnPoorAccuracy: z.boolean().optional(),
	})
	.refine(
		(patch) => Object.values(patch).some((value) => value !== undefined),
		{ message: "No hay nada que actualizar" },
	);

/** `?includeInactive=`. Por defecto **no**: el catálogo que se usa para marcar. */
export const listWorkLocationsQuerySchema = z.object({
	includeInactive: z.stringbool().default(false),
});

/** `PUT /me/work-location`. Nulo = quitar la selección. */
export const selectWorkLocationInputSchema = z.object({
	workLocationId: z.uuid("El identificador de sede no es válido.").nullable(),
});

// ── Geometría ─────────────────────────────────────────────────────────────────

/** Distancia a la sede, contando desde su centro. */
export function distanceToLocation(
	location: Pick<WorkLocation, "centerLat" | "centerLng">,
	position: { latitude: number; longitude: number },
): number {
	return distanceInMeters(
		{ latitude: location.centerLat, longitude: location.centerLng },
		position,
	);
}

export type GeofenceEvaluation = {
	distanceMeters: number;
	/** RN-08.1: dentro si `distancia ≤ radius_meters`. */
	insideGeofence: boolean;
	accuracyMeters: number;
	/** `false` si la lectura es peor que el umbral de la sede (RN-08.3). */
	accuracyOk: boolean;
	/** `true` sólo si además la sede bloquea con mala precisión. */
	blockedByAccuracy: boolean;
	/** Metros que sobran para entrar. 0 si está dentro. */
	metersOutside: number;
};

/**
 * Veredicto de **una** sede para una lectura. Pura y compartida: el servidor la
 * usa para decidir y la interfaz para explicar antes de intentarlo.
 */
export function evaluateGeofence(
	location: Pick<
		WorkLocation,
		| "centerLat"
		| "centerLng"
		| "radiusMeters"
		| "accuracyThreshold"
		| "blockOnPoorAccuracy"
	>,
	position: { latitude: number; longitude: number; accuracy: number },
): GeofenceEvaluation {
	const distanceMeters = distanceToLocation(location, position);
	const insideGeofence = distanceMeters <= location.radiusMeters;
	const accuracyOk = position.accuracy <= location.accuracyThreshold;

	return {
		distanceMeters,
		insideGeofence,
		accuracyMeters: position.accuracy,
		accuracyOk,
		blockedByAccuracy: !accuracyOk && location.blockOnPoorAccuracy,
		metersOutside: insideGeofence ? 0 : distanceMeters - location.radiusMeters,
	};
}

// ── Resultado de la parte de ubicación de un marcaje ──────────────────────────

export const locationVerdictSchema = z.object({
	allowed: z.boolean(),
	/** Motivo tipado de la spec 09 §6 cuando no se permite. */
	reason: markRejectionReasonSchema.nullable(),
	/** Mensaje en español, ya con los metros concretos. */
	message: z.string(),
	/** La sede contra la que se juzgó, si había alguna. */
	location: workLocationSchema.nullable(),
	distanceMeters: z.number().nullable(),
	insideGeofence: z.boolean().nullable(),
	accuracyMeters: z.number(),
	accuracyOk: z.boolean().nullable(),
	/**
	 * Otras sedes activas y su distancia, la más cercana primero. Es lo que
	 * convierte un rechazo en algo accionable: "Sede Norte está a 40 m".
	 */
	nearby: z.array(
		z.object({
			id: z.uuid(),
			name: z.string(),
			distanceMeters: z.number(),
			insideGeofence: z.boolean(),
		}),
	),
});

/**
 * `GET`/`PUT /me/work-location`: la sede de quien pregunta y si le hace falta
 * tenerla elegida para operar (RN-08.7).
 *
 * `required` sale del rol —sólo el gestor global queda fuera, por RN-03.4— y lo
 * resuelve el servidor: la interfaz no tiene que volver a razonar sobre roles para
 * saber si debe insistir con el selector.
 */
export const myWorkLocationSchema = z.object({
	location: workLocationSchema.nullable(),
	required: z.boolean(),
});

export type WorkLocation = z.infer<typeof workLocationSchema>;
export type MyWorkLocation = z.infer<typeof myWorkLocationSchema>;
export type CreateWorkLocationInput = z.infer<
	typeof createWorkLocationInputSchema
>;
export type UpdateWorkLocationInput = z.infer<
	typeof updateWorkLocationInputSchema
>;
export type SelectWorkLocationInput = z.infer<
	typeof selectWorkLocationInputSchema
>;
export type LocationVerdict = z.infer<typeof locationVerdictSchema>;
