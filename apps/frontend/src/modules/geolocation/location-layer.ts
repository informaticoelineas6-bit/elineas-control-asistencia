import type { DevicePosition } from "@elineas/validations";

/**
 * Capa de ubicación del cliente (spec 08 §4).
 *
 * Una sola abstracción sobre dos runtimes. Hoy sólo existe el **web**; el nativo
 * (Capacitor) llega con la spec 20, y por eso la interfaz de este módulo no menciona
 * `navigator`: cuando haya plugin, se cambia la implementación de estas cuatro
 * funciones y **nada más del proyecto se toca**.
 *
 * ⚠️ **Deuda heredada (punto 77).** El seguimiento en segundo plano en Android usaba
 * `watchPosition` como sustituto de un servicio nativo, y Android mata el proceso.
 * Aquí sólo hay seguimiento **en primer plano** —con la pantalla abierta—, que es lo
 * que necesitan el diagnóstico (§6) y el marcaje (spec 09). El modo de salida por
 * geocerca sigue sin ser fiable, y por eso su opción lleva advertencia en
 * Configuración: la decisión de ofrecerlo de verdad es de la spec 20.
 *
 * Lo que **no** hace esta capa: decidir. No calcula si estás dentro de una geocerca
 * ni cachea veredictos. Lee el GPS y devuelve lo que dice, con su precisión; quien
 * decide es el servidor (RN-08.2).
 */

export type PositionReading = DevicePosition & {
	/** Instante de la lectura, en ISO. Sirve para saber si está rancia. */
	timestamp: string;
};

export type LocationPermission =
	| "granted"
	| "prompt"
	| "denied"
	/** El dispositivo o el navegador no tiene geolocalización. */
	| "unsupported"
	/** No se puede saber sin pedirla (Safari, por ejemplo). */
	| "unknown";

export type LocationErrorKind =
	| "denied"
	| "unavailable"
	| "timeout"
	| "unsupported";

export class LocationError extends Error {
	constructor(
		readonly kind: LocationErrorKind,
		message: string,
	) {
		super(message);
		this.name = "LocationError";
	}
}

/**
 * Mensajes en español y **accionables** (RN-08.9): un "error de geolocalización" no
 * le dice a nadie qué hacer, y el permiso denegado no se puede volver a pedir por
 * código — hay que explicar dónde se cambia.
 */
const MESSAGES: Record<LocationErrorKind, string> = {
	denied:
		"No diste permiso de ubicación. Sin él no se puede validar dónde estás.",
	unavailable:
		"El dispositivo no pudo obtener tu ubicación. Sal al exterior o comprueba que el GPS esté encendido.",
	timeout:
		"La ubicación tardó demasiado. Comprueba que el GPS esté encendido y vuelve a intentarlo.",
	unsupported: "Este dispositivo o navegador no tiene geolocalización.",
};

const supported = () =>
	typeof navigator !== "undefined" && "geolocation" in navigator;

function toReading(position: GeolocationPosition): PositionReading {
	return {
		latitude: position.coords.latitude,
		longitude: position.coords.longitude,
		// Algunos navegadores devuelven `null` en precisión; tratarlo como 0 diría
		// "lectura perfecta", que es justo lo contrario de lo que significa.
		accuracy: Number.isFinite(position.coords.accuracy)
			? position.coords.accuracy
			: Number.MAX_SAFE_INTEGER,
		timestamp: new Date(position.timestamp).toISOString(),
	};
}

function toError(error: GeolocationPositionError): LocationError {
	const kind: LocationErrorKind =
		error.code === error.PERMISSION_DENIED
			? "denied"
			: error.code === error.TIMEOUT
				? "timeout"
				: "unavailable";
	return new LocationError(kind, MESSAGES[kind]);
}

/**
 * Opciones de lectura. `enableHighAccuracy` es lo que enciende el GPS de verdad en
 * vez de resolver por red —en planta, dentro de una nave, la diferencia entre 20 m y
 * 2000 m— y `maximumAge: 0` evita que el navegador devuelva una lectura vieja: para
 * decidir un marcaje hace falta dónde estás ahora, no dónde estabas al desayunar.
 */
const READ_OPTIONS: PositionOptions = {
	enableHighAccuracy: true,
	timeout: 15_000,
	maximumAge: 0,
};

export function getCurrentPosition(): Promise<PositionReading> {
	if (!supported()) {
		return Promise.reject(
			new LocationError("unsupported", MESSAGES.unsupported),
		);
	}

	return new Promise((resolve, reject) => {
		navigator.geolocation.getCurrentPosition(
			(position) => resolve(toReading(position)),
			(error) => reject(toError(error)),
			READ_OPTIONS,
		);
	});
}

/**
 * Seguimiento **en primer plano**. Devuelve la función para detenerlo; llamarla es
 * obligatorio al desmontar, o el GPS se queda encendido gastando batería con la
 * pantalla apagada.
 */
export function watchPosition(
	onReading: (reading: PositionReading) => void,
	onError?: (error: LocationError) => void,
): () => void {
	if (!supported()) {
		onError?.(new LocationError("unsupported", MESSAGES.unsupported));
		return () => {};
	}

	const id = navigator.geolocation.watchPosition(
		(position) => onReading(toReading(position)),
		(error) => onError?.(toError(error)),
		READ_OPTIONS,
	);

	return () => navigator.geolocation.clearWatch(id);
}

/**
 * Estado del permiso **sin pedirlo**. Hay navegadores sin `permissions.query` para
 * geolocalización, y ahí la única forma de saberlo es intentarlo: por eso existe
 * `unknown` en vez de mentir con `prompt`.
 */
export async function permissionState(): Promise<LocationPermission> {
	if (!supported()) return "unsupported";
	if (typeof navigator === "undefined" || !navigator.permissions) {
		return "unknown";
	}

	try {
		const status = await navigator.permissions.query({
			name: "geolocation" as PermissionName,
		});
		return status.state as LocationPermission;
	} catch {
		return "unknown";
	}
}

/** Cuántos segundos tiene una lectura. Para avisar de que está rancia. */
export function readingAgeSeconds(reading: PositionReading): number {
	return Math.max(
		0,
		Math.round((Date.now() - new Date(reading.timestamp).getTime()) / 1000),
	);
}
