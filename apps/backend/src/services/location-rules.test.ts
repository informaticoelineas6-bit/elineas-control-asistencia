import { describe, expect, test } from "bun:test";
import {
	devicePositionSchema,
	distanceInMeters,
	evaluateGeofence,
	formatDistance,
	type WorkLocation,
} from "@elineas/validations";
import {
	nearbyLocations,
	validateMarkLocation,
} from "#/services/location-rules.ts";

/**
 * Pruebas de la parte de ubicación de la validación de un marcaje (spec 08 §3).
 *
 * Hermanas de `schedule-rules.test.ts` y por el mismo motivo: es la regla que
 * decide si alguien puede trabajar, y es pura — sin base de datos y sin GPS de
 * verdad—, así que se puede probar el metro exacto del borde de la geocerca, la
 * precisión justo por encima del umbral y la sede que se desactivó a media mañana.
 */

/** Grados de latitud que equivalen a un metro (constante a cualquier longitud). */
const DEGREES_PER_METER = 1 / 111_194.9;

const location = (over: Partial<WorkLocation> = {}): WorkLocation => ({
	id: crypto.randomUUID(),
	name: "Sede Central",
	centerLat: 23.1136,
	centerLng: -82.3666,
	radiusMeters: 100,
	accuracyThreshold: 50,
	blockOnPoorAccuracy: false,
	isActive: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...over,
});

/** Un punto a N metros al norte del centro de la sede. */
const metersNorth = (from: WorkLocation, meters: number, accuracy = 10) => ({
	latitude: from.centerLat + meters * DEGREES_PER_METER,
	longitude: from.centerLng,
	accuracy,
});

describe("distancia Haversine (RN-08.1)", () => {
	test("el mismo punto está a cero metros", () => {
		const point = { latitude: 23.1136, longitude: -82.3666 };
		expect(distanceInMeters(point, point)).toBe(0);
	});

	test("una milésima de grado de latitud son ~111,2 m en cualquier parte", () => {
		const ecuador = distanceInMeters(
			{ latitude: 0, longitude: 0 },
			{ latitude: 0.001, longitude: 0 },
		);
		const habana = distanceInMeters(
			{ latitude: 23.1136, longitude: -82.3666 },
			{ latitude: 23.1146, longitude: -82.3666 },
		);

		expect(ecuador).toBeCloseTo(111.19, 1);
		expect(habana).toBeCloseTo(111.19, 1);
	});

	test("una milésima de grado de longitud se acorta con la latitud", () => {
		const ecuador = distanceInMeters(
			{ latitude: 0, longitude: 0 },
			{ latitude: 0, longitude: 0.001 },
		);
		const habana = distanceInMeters(
			{ latitude: 23.1136, longitude: -82.3666 },
			{ latitude: 23.1136, longitude: -82.3656 },
		);

		expect(ecuador).toBeCloseTo(111.19, 1);
		// 111,19 × cos(23,11°) ≈ 102,3 m
		expect(habana).toBeCloseTo(102.3, 0);
	});

	test("es simétrica", () => {
		const a = { latitude: 23.1, longitude: -82.3 };
		const b = { latitude: 23.2, longitude: -82.4 };
		expect(distanceInMeters(a, b)).toBeCloseTo(distanceInMeters(b, a), 6);
	});

	test("el helper de metros al norte es fiel a la distancia calculada", () => {
		const sede = location();
		const point = metersNorth(sede, 250);
		expect(
			distanceInMeters(
				{ latitude: sede.centerLat, longitude: sede.centerLng },
				point,
			),
		).toBeCloseTo(250, 0);
	});
});

describe("veredicto de una geocerca (RN-08.1, RN-08.3)", () => {
	test("dentro del radio, dentro", () => {
		const sede = location();
		const verdict = evaluateGeofence(sede, metersNorth(sede, 40));

		expect(verdict.insideGeofence).toBe(true);
		expect(verdict.metersOutside).toBe(0);
		expect(verdict.distanceMeters).toBeCloseTo(40, 0);
	});

	test("el metro exacto del radio todavía cuenta como dentro", () => {
		const sede = location();
		expect(evaluateGeofence(sede, metersNorth(sede, 99.5)).insideGeofence).toBe(
			true,
		);
	});

	test("un metro más allá del radio, fuera", () => {
		const sede = location();
		const verdict = evaluateGeofence(sede, metersNorth(sede, 101));

		expect(verdict.insideGeofence).toBe(false);
		expect(verdict.metersOutside).toBeCloseTo(1, 0);
	});

	test("la precisión se juzga contra el umbral de la sede", () => {
		const sede = location({ accuracyThreshold: 50 });

		expect(evaluateGeofence(sede, metersNorth(sede, 10, 50)).accuracyOk).toBe(
			true,
		);
		expect(evaluateGeofence(sede, metersNorth(sede, 10, 51)).accuracyOk).toBe(
			false,
		);
	});

	test("sólo bloquea si la sede lo pide", () => {
		const permisiva = location({ blockOnPoorAccuracy: false });
		const estricta = location({ blockOnPoorAccuracy: true });

		expect(
			evaluateGeofence(permisiva, metersNorth(permisiva, 10, 300))
				.blockedByAccuracy,
		).toBe(false);
		expect(
			evaluateGeofence(estricta, metersNorth(estricta, 10, 300))
				.blockedByAccuracy,
		).toBe(true);
	});
});

describe("sede seleccionada (RN-08.5, RN-08.6, RN-08.7)", () => {
	test("sin sede elegida no se juzga nada, y el aviso propone la más cercana", () => {
		const cerca = location({ name: "Sede Norte" });
		const lejos = location({
			name: "Sede Sur",
			centerLat: 23.05,
			centerLng: -82.4,
		});

		const verdict = validateMarkLocation({
			selected: null,
			activeLocations: [lejos, cerca],
			position: devicePositionSchema.parse(metersNorth(cerca, 20)),
		});

		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toBe("INVALID_LOCATION");
		expect(verdict.message).toContain("Sede Norte");
		expect(verdict.nearby.at(0)?.name).toBe("Sede Norte");
	});

	test("sin sede elegida y sin sedes activas, el aviso lo dice", () => {
		const verdict = validateMarkLocation({
			selected: null,
			activeLocations: [],
			position: devicePositionSchema.parse({
				latitude: 23.1,
				longitude: -82.3,
				accuracy: 10,
			}),
		});

		expect(verdict.reason).toBe("INVALID_LOCATION");
		expect(verdict.message).toContain("no hay ninguna sede activa");
		expect(verdict.nearby).toEqual([]);
	});

	test("la sede que declara el cliente tiene que ser la del perfil (RN-09.6)", () => {
		const mia = location({ name: "Sede Central" });
		const otra = location({ name: "Sede Norte" });

		const verdict = validateMarkLocation({
			requestedLocationId: otra.id,
			selected: mia,
			activeLocations: [mia, otra],
			position: devicePositionSchema.parse(metersNorth(mia, 10)),
		});

		expect(verdict.reason).toBe("INVALID_LOCATION");
		expect(verdict.message).toContain("Sede Central");
	});

	test("una sede desactivada invalida la selección guardada", () => {
		const sede = location({ isActive: false });

		const verdict = validateMarkLocation({
			selected: sede,
			activeLocations: [],
			position: devicePositionSchema.parse(metersNorth(sede, 5)),
		});

		expect(verdict.reason).toBe("INVALID_LOCATION");
		expect(verdict.message).toContain("ya no está activa");
	});

	test("dentro de su sede, aceptado, con la distancia en el mensaje", () => {
		const sede = location();
		const verdict = validateMarkLocation({
			requestedLocationId: sede.id,
			selected: sede,
			activeLocations: [sede],
			position: devicePositionSchema.parse(metersNorth(sede, 23)),
		});

		expect(verdict.allowed).toBe(true);
		expect(verdict.reason).toBeNull();
		expect(verdict.insideGeofence).toBe(true);
		expect(verdict.distanceMeters).toBeCloseTo(23, 0);
		expect(verdict.message).toContain("23 m");
	});

	test("estar dentro de OTRA sede no salva el marcaje, pero el rechazo lo dice", () => {
		const mia = location({ name: "Sede Central" });
		// A 400 m al norte, con radio 100: la posición cae dentro de esta y fuera de
		// la mía.
		const vecina = location({
			name: "Sede Norte",
			centerLat: mia.centerLat + 400 * DEGREES_PER_METER,
		});
		const position = devicePositionSchema.parse(metersNorth(mia, 400));

		const verdict = validateMarkLocation({
			selected: mia,
			activeLocations: [mia, vecina],
			position,
		});

		// RN-08.5: se valida contra la elegida, y ésta se incumple.
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toBe("OUTSIDE_GEOFENCE");
		// …pero el mensaje convierte el rechazo en un toque en el selector.
		expect(verdict.message).toContain("Sede Norte");
		expect(verdict.nearby.some((each) => each.insideGeofence)).toBe(true);
	});

	test("fuera de todas las sedes, el rechazo dice cuánto falta", () => {
		const sede = location();
		const verdict = validateMarkLocation({
			selected: sede,
			activeLocations: [sede],
			position: devicePositionSchema.parse(metersNorth(sede, 180)),
		});

		expect(verdict.reason).toBe("OUTSIDE_GEOFENCE");
		expect(verdict.message).toContain("180 m");
		expect(verdict.message).toContain("faltan");
	});
});

describe("precisión del GPS (RN-08.3)", () => {
	test("mala precisión con bloqueo activado rechaza, aunque esté dentro", () => {
		const sede = location({ blockOnPoorAccuracy: true, accuracyThreshold: 50 });
		const verdict = validateMarkLocation({
			selected: sede,
			activeLocations: [sede],
			position: devicePositionSchema.parse(metersNorth(sede, 10, 300)),
		});

		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toBe("POOR_GPS_ACCURACY");
		expect(verdict.insideGeofence).toBe(true);
		expect(verdict.accuracyOk).toBe(false);
	});

	test("mala precisión sin bloqueo acepta y deja constancia", () => {
		const sede = location({
			blockOnPoorAccuracy: false,
			accuracyThreshold: 50,
		});
		const verdict = validateMarkLocation({
			selected: sede,
			activeLocations: [sede],
			position: devicePositionSchema.parse(metersNorth(sede, 10, 300)),
		});

		expect(verdict.allowed).toBe(true);
		expect(verdict.accuracyOk).toBe(false);
		expect(verdict.message).toContain("precisión");
	});

	test("con las dos cosas mal, manda la precisión: es el mensaje que sirve", () => {
		const sede = location({ blockOnPoorAccuracy: true, accuracyThreshold: 50 });
		const verdict = validateMarkLocation({
			selected: sede,
			activeLocations: [sede],
			position: devicePositionSchema.parse(metersNorth(sede, 500, 400)),
		});

		// Decirle "estás a 500 m" a quien tiene ±400 m de error es justo el reclamo
		// que la pantalla de diagnóstico existe para resolver.
		expect(verdict.reason).toBe("POOR_GPS_ACCURACY");
		expect(verdict.insideGeofence).toBe(false);
	});
});

describe("el servidor no se cree al cliente (RN-08.2)", () => {
	test("un insideGeofence enviado por el cliente ni llega al cálculo", () => {
		const position = devicePositionSchema.parse({
			latitude: 23.1136,
			longitude: -82.3666,
			accuracy: 10,
			insideGeofence: true,
			distanceMeters: 0,
		});

		expect(position).not.toHaveProperty("insideGeofence");
		expect(position).not.toHaveProperty("distanceMeters");
	});

	test("coordenadas imposibles las para el esquema", () => {
		for (const bad of [
			{ latitude: 91, longitude: 0, accuracy: 10 },
			{ latitude: 0, longitude: 181, accuracy: 10 },
			{ latitude: 0, longitude: 0, accuracy: -1 },
		]) {
			expect(devicePositionSchema.safeParse(bad).success).toBe(false);
		}
	});

	test("mentir en la sede propia no cambia el veredicto: manda lat/lng", () => {
		// La sede dice que su radio son 100 m; la posición está a 900.
		const sede = location();
		const verdict = validateMarkLocation({
			selected: sede,
			activeLocations: [sede],
			position: devicePositionSchema.parse(metersNorth(sede, 900)),
		});

		expect(verdict.allowed).toBe(false);
		expect(verdict.distanceMeters).toBeCloseTo(900, 0);
	});
});

describe("sedes cercanas y formato", () => {
	test("se ordenan por distancia y se recortan", () => {
		const base = location({ name: "Base" });
		const sedes = Array.from({ length: 20 }, (_, index) =>
			location({
				name: `Sede ${index}`,
				centerLat: base.centerLat + (index + 1) * 50 * DEGREES_PER_METER,
			}),
		);

		const nearby = nearbyLocations(
			[...sedes].reverse(),
			{ latitude: base.centerLat, longitude: base.centerLng },
			5,
		);

		expect(nearby.length).toBe(5);
		expect(nearby.map((each) => each.name)).toEqual([
			"Sede 0",
			"Sede 1",
			"Sede 2",
			"Sede 3",
			"Sede 4",
		]);
		expect(nearby[0]?.distanceMeters).toBeLessThan(
			nearby[1]?.distanceMeters ?? 0,
		);
	});

	test("las distancias se escriben como las lee una persona", () => {
		expect(formatDistance(0)).toBe("0 m");
		expect(formatDistance(23.4)).toBe("23 m");
		expect(formatDistance(999)).toBe("999 m");
		expect(formatDistance(1200)).toBe("1,2 km");
	});
});
