import {
	type DevicePosition,
	distanceToLocation,
	evaluateGeofence,
	formatDistance,
	type LocationVerdict,
	type MarkRejectionReason,
	type WorkLocation,
} from "@elineas/validations";

/**
 * **Parte de ubicación de la validación de un marcaje** (spec 08 §3).
 *
 * Hermana de `schedule-rules.ts`, y con la misma forma y los mismos motivos: pura,
 * sin base de datos ni reloj, con el contexto ya cargado por quien la llama (spec
 * 09 §4), y fallando al primer no con un motivo tipado y un mensaje que dice qué
 * hacer.
 *
 * Las tres reglas que la gobiernan:
 *
 * - **RN-08.2 — El servidor recalcula.** Entra lat/lng y precisión; **nunca** un
 *   `insideGeofence` ni una distancia venidos del cliente. El esquema de
 *   `devicePositionSchema` ni siquiera tiene esos campos, para que nadie los añada
 *   "por comodidad".
 * - **RN-08.5 — Se valida contra la sede seleccionada**, no contra la más cercana
 *   (decisión 1 de la §9). Estar dentro de otra geocerca no salva el marcaje… pero
 *   el rechazo **lo dice**, con nombre y metros, para que el arreglo sea un toque
 *   en el selector y no una llamada a soporte.
 * - **RN-08.3 — La precisión se juzga antes que la geocerca.** La spec 09 §RN-09.6
 *   enumera geocerca y luego precisión; cuando las dos fallan, el orden sólo cambia
 *   el mensaje, y con ±300 m de error decirle a alguien "estás a 180 m" es
 *   precisamente el reclamo que la pantalla de diagnóstico (§6) existe para
 *   resolver. Con `block_on_poor_accuracy = false` la mala precisión no bloquea: se
 *   acepta y queda registrada (`accuracyOk: false`).
 */

export type MarkLocationInput = {
	/**
	 * Sede que declara el cliente al marcar (spec 09 RN-09.6). En el diagnóstico no
	 * viene: se juzga directamente la del perfil.
	 */
	requestedLocationId?: string | null;
	/** La sede seleccionada en el perfil, tal como está en base (activa o no). */
	selected: WorkLocation | null;
	/** Sedes **activas**, para el aviso de "hay otra en rango". */
	activeLocations: readonly WorkLocation[];
	position: DevicePosition;
};

/** Cuántas sedes se devuelven en el listado de distancias del diagnóstico. */
const NEARBY_LIMIT = 12;

/** Sedes activas ordenadas por distancia, con su veredicto de pertenencia. */
export function nearbyLocations(
	activeLocations: readonly WorkLocation[],
	position: { latitude: number; longitude: number },
	limit = NEARBY_LIMIT,
): LocationVerdict["nearby"] {
	return activeLocations
		.map((location) => {
			const distanceMeters = distanceToLocation(location, position);
			return {
				id: location.id,
				name: location.name,
				distanceMeters,
				insideGeofence: distanceMeters <= location.radiusMeters,
			};
		})
		.sort((a, b) => a.distanceMeters - b.distanceMeters)
		.slice(0, limit);
}

function reject(
	reason: MarkRejectionReason,
	message: string,
	base: LocationVerdict,
): LocationVerdict {
	return { ...base, allowed: false, reason, message };
}

export function validateMarkLocation(
	input: MarkLocationInput,
): LocationVerdict {
	const { position, selected } = input;
	const nearby = nearbyLocations(input.activeLocations, position);

	const base: LocationVerdict = {
		allowed: false,
		reason: null,
		message: "",
		location: selected,
		distanceMeters: null,
		insideGeofence: null,
		accuracyMeters: position.accuracy,
		accuracyOk: null,
		nearby,
	};

	// RN-08.7 — Sin sede elegida no se puede juzgar nada. El aviso lleva la más
	// cercana porque es, casi siempre, la que hay que elegir.
	if (!selected) {
		const closest = nearby.at(0);
		return reject(
			"INVALID_LOCATION",
			closest
				? `Elige tu sede de trabajo antes de marcar. La más cercana es ${closest.name}, a ${formatDistance(closest.distanceMeters)}.`
				: "Elige tu sede de trabajo antes de marcar. Todavía no hay ninguna sede activa: avisa a un gestor.",
			base,
		);
	}

	// Spec 09 RN-09.6 — La sede que declara el cliente tiene que ser la del perfil.
	// Si no coincide, el cliente está trabajando con una selección vieja.
	if (input.requestedLocationId && input.requestedLocationId !== selected.id) {
		return reject(
			"INVALID_LOCATION",
			`El marcaje va contra una sede distinta de la que tienes seleccionada (${selected.name}). Vuelve a elegirla y reinténtalo.`,
			base,
		);
	}

	// RN-08.6 — Una sede desactivada invalida la selección guardada.
	if (!selected.isActive) {
		return reject(
			"INVALID_LOCATION",
			`${selected.name} ya no está activa como sede. Elige otra en tu perfil.`,
			base,
		);
	}

	const geofence = evaluateGeofence(selected, position);
	const withGeofence: LocationVerdict = {
		...base,
		distanceMeters: geofence.distanceMeters,
		insideGeofence: geofence.insideGeofence,
		accuracyOk: geofence.accuracyOk,
	};

	// RN-08.3 — Mala precisión con bloqueo activado.
	if (geofence.blockedByAccuracy) {
		return reject(
			"POOR_GPS_ACCURACY",
			`Tu dispositivo reporta una precisión de ±${formatDistance(position.accuracy)} y ${selected.name} admite hasta ±${formatDistance(selected.accuracyThreshold)}. Sal al exterior o espera unos segundos a que el GPS mejore.`,
			withGeofence,
		);
	}

	// RN-08.1 — Fuera de la geocerca de **su** sede (RN-08.5).
	if (!geofence.insideGeofence) {
		const alternative = nearby.find(
			(each) => each.insideGeofence && each.id !== selected.id,
		);

		return reject(
			"OUTSIDE_GEOFENCE",
			alternative
				? `Estás a ${formatDistance(geofence.distanceMeters)} del centro de ${selected.name}, que permite ${formatDistance(selected.radiusMeters)}. Sí estás dentro de ${alternative.name}: si hoy trabajas ahí, cámbiala en tu perfil.`
				: `Estás a ${formatDistance(geofence.distanceMeters)} del centro de ${selected.name}, que permite ${formatDistance(selected.radiusMeters)}: te faltan ${formatDistance(geofence.metersOutside)} para entrar. Acércate o reporta una incidencia.`,
			withGeofence,
		);
	}

	return {
		...withGeofence,
		allowed: true,
		reason: null,
		// La precisión mala que **no** bloquea se acepta y se dice, para que quien
		// mire el diagnóstico entienda por qué la distancia puede no ser exacta.
		message: geofence.accuracyOk
			? `Dentro de ${selected.name}, a ${formatDistance(geofence.distanceMeters)} del centro.`
			: `Dentro de ${selected.name}, a ${formatDistance(geofence.distanceMeters)} del centro, pero con una precisión de ±${formatDistance(position.accuracy)}: la distancia puede no ser exacta.`,
	};
}
