import { z } from "zod";

/**
 * Coordenadas, lecturas del dispositivo y distancias.
 *
 * Módulo **hoja**: no importa nada de este paquete. Lo necesitan por igual las
 * sedes (spec 08) y los marcajes (spec 09), y tenerlo aparte es lo que evita que
 * esos dos se importen en círculo — que es como una cadena de esquemas acaba
 * evaluándose a `undefined` según por dónde entre el primer `import`.
 */

export const latitudeSchema = z
	.number()
	.min(-90, "La latitud está fuera de rango")
	.max(90, "La latitud está fuera de rango");

export const longitudeSchema = z
	.number()
	.min(-180, "La longitud está fuera de rango")
	.max(180, "La longitud está fuera de rango");

/**
 * Lectura del dispositivo. `accuracy` es el radio de error en metros que reporta
 * el propio GPS: sin él no se puede juzgar si el veredicto de la geocerca
 * significa algo (RN-08.3).
 *
 * **No** hay campos `distance` ni `insideGeofence`: el cliente no los envía porque
 * el servidor no los usaría (RN-08.2). Que no existan en el esquema es la forma de
 * que nadie los añada "por comodidad" más adelante.
 */
export const devicePositionSchema = z.object({
	latitude: latitudeSchema,
	longitude: longitudeSchema,
	accuracy: z
		.number()
		.min(0, "La precisión no puede ser negativa")
		.max(100_000, "Esa precisión no es una lectura real"),
	/** Antigüedad de la lectura, para el diagnóstico (§6). */
	timestamp: z.iso.datetime().optional(),
});

/**
 * Radio medio de la Tierra (IUGG), en metros. A la escala de una geocerca la
 * diferencia con otros valores es de centímetros; se fija aquí para que servidor y
 * cliente den **exactamente** el mismo número y nadie discuta por un metro.
 */
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * RN-08.1 — Distancia Haversine en metros entre dos puntos.
 *
 * Sobre la esfera, no sobre el elipsoide: a distancias de geocerca el error es de
 * unos centímetros, y una fórmula que quepa en diez líneas es una que se puede
 * revisar cuando alguien reclame que la app lo dejó fuera.
 */
export function distanceInMeters(
	from: { latitude: number; longitude: number },
	to: { latitude: number; longitude: number },
): number {
	const lat1 = toRadians(from.latitude);
	const lat2 = toRadians(to.latitude);
	const deltaLat = lat2 - lat1;
	const deltaLng = toRadians(to.longitude - from.longitude);

	const a =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "23 m", "1,2 km" — para mensajes que lee una persona en planta. */
export function formatDistance(meters: number): string {
	if (!Number.isFinite(meters)) return "distancia desconocida";
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
}

export type DevicePosition = z.infer<typeof devicePositionSchema>;
