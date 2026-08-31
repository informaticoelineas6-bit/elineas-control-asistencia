import { describe, expect, test } from "bun:test";
import type { WorkLocation } from "@elineas/validations";
import {
	type AttendanceMarkContext,
	validateAttendanceMark,
} from "#/services/attendance-rules.ts";

/**
 * Pruebas de la validación completa de un marcaje (spec 09 §4).
 *
 * La spec la llama *la unidad de test más importante del sistema* y su primer
 * criterio de aceptación es que **cada motivo de rechazo de §6 tenga un test que lo
 * provoque**. Aquí están los doce que la función puede devolver; `NOT_AUTHENTICATED`
 * lo cubre el middleware (401) y se prueba en la de integración.
 *
 * Sin base de datos y sin reloj: el instante entra como argumento, que es lo que
 * permite probar el borde del minuto, la medianoche y el doble toque.
 */

/** Sede en La Habana: 100 m de radio, admite hasta ±50 m de imprecisión. */
const location: WorkLocation = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Sede Central",
	centerLat: 23.1136,
	centerLng: -82.3666,
	radiusMeters: 100,
	accuracyThreshold: 50,
	blockOnPoorAccuracy: false,
	isActive: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Diurno en La Habana: entra 07:45–08:15, sale 16:00–18:00. */
const schedule = {
	checkinStartTime: "07:45",
	checkinEndTime: "08:15",
	checkoutStartTime: "16:00",
	checkoutEndTime: "18:00",
	timezone: "America/Havana",
	allowEarlyCheckin: false,
	allowLateCheckout: false,
};

/** La Habana está en UTC−4 en agosto. */
const havana = (localTime: string, date = "2026-08-19") => {
	const [hours = "0", minutes = "0"] = localTime.split(":");
	return new Date(
		Date.UTC(
			Number(date.slice(0, 4)),
			Number(date.slice(5, 7)) - 1,
			Number(date.slice(8, 10)),
			Number(hours) + 4,
			Number(minutes),
		),
	);
};

function context(
	overrides: Partial<AttendanceMarkContext> = {},
): AttendanceMarkContext {
	return {
		markType: "IN",
		at: havana("07:50"),
		role: "employee",
		profile: { isActive: true },
		department: {
			id: "22222222-2222-4222-8222-222222222222",
			name: "Producción",
			isPaused: false,
			pauseReason: null,
		},
		schedule,
		calendarByDate: {},
		globalToleranceMinutes: 0,
		requestedLocationId: location.id,
		selectedLocation: location,
		activeLocations: [location],
		// En el centro exacto y con buena precisión.
		position: { latitude: 23.1136, longitude: -82.3666, accuracy: 10 },
		recentMarks: [],
		...overrides,
	};
}

describe("aceptación", () => {
	test("una entrada en ventana, en la geocerca y sin marcas previas entra", () => {
		const result = validateAttendanceMark(context());

		expect(result.accepted).toBe(true);
		expect(result.reason).toBeNull();
		expect(result.workDate).toBe("2026-08-19");
		expect(result.insideGeofence).toBe(true);
		expect(result.distanceToCenter).toBeCloseTo(0, 0);
		expect(result.message).toContain("Entrada registrada a las 07:50");
	});

	test("la salida entra si hay una entrada abierta de esa jornada", () => {
		const result = validateAttendanceMark(
			context({
				markType: "OUT",
				at: havana("17:00"),
				recentMarks: [
					{
						id: "a",
						markType: "IN",
						markedAt: havana("07:50"),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.accepted).toBe(true);
		expect(result.message).toContain("Salida registrada a las 17:00");
	});

	test("volver a entrar después de una salida es legítimo (almuerzo)", () => {
		const result = validateAttendanceMark(
			context({
				at: havana("08:10"),
				recentMarks: [
					{
						id: "b",
						markType: "OUT",
						markedAt: havana("08:05"),
						workDate: "2026-08-19",
					},
					{
						id: "a",
						markType: "IN",
						markedAt: havana("07:50"),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.accepted).toBe(true);
	});

	test("la tardanza no bloquea: se acepta y queda etiquetada (RN-09.7)", () => {
		const result = validateAttendanceMark(
			context({ at: havana("07:51"), globalToleranceMinutes: 5 }),
		);

		expect(result.accepted).toBe(true);
		expect(result.isLate).toBe(true);
		expect(result.lateMinutes).toBe(6);
		expect(result.message).toContain("6 minutos de tardanza");
	});

	test("3 minutos tarde con tolerancia de 5 no es tardanza", () => {
		const result = validateAttendanceMark(
			context({ at: havana("07:48"), globalToleranceMinutes: 5 }),
		);

		expect(result.accepted).toBe(true);
		expect(result.isLate).toBe(false);
	});
});

describe("motivos de rechazo (spec 09 §6)", () => {
	test("INACTIVE_ACCOUNT: la cuenta está desactivada", () => {
		const result = validateAttendanceMark(
			context({ profile: { isActive: false } }),
		);
		expect(result.reason).toBe("INACTIVE_ACCOUNT");
		expect(result.accepted).toBe(false);
	});

	test("ON_VACATION: vacaciones aprobadas cubren la fecha", () => {
		const result = validateAttendanceMark(context({ onVacation: true }));
		expect(result.reason).toBe("ON_VACATION");
	});

	test("ROLE_CANNOT_MARK: el gestor global no marca", () => {
		const result = validateAttendanceMark(context({ role: "global_manager" }));
		expect(result.reason).toBe("ROLE_CANNOT_MARK");
	});

	test("DEPARTMENT_PAUSED: con el motivo de la pausa en el mensaje", () => {
		const result = validateAttendanceMark(
			context({
				department: {
					id: "22222222-2222-4222-8222-222222222222",
					name: "Producción",
					isPaused: true,
					pauseReason: "corte de agua",
				},
			}),
		);

		expect(result.reason).toBe("DEPARTMENT_PAUSED");
		expect(result.message).toContain("corte de agua");
	});

	test("NO_SCHEDULE: el departamento no tiene horario", () => {
		expect(validateAttendanceMark(context({ schedule: null })).reason).toBe(
			"NO_SCHEDULE",
		);
	});

	test("NO_SCHEDULE: sin departamento asignado, con mensaje propio", () => {
		const result = validateAttendanceMark(
			context({ department: null, schedule: null }),
		);
		expect(result.reason).toBe("NO_SCHEDULE");
		expect(result.message).toContain("departamento asignado");
	});

	test("NOT_WORKDAY: el calendario marca la fecha como no laborable", () => {
		const result = validateAttendanceMark(
			context({
				calendarByDate: {
					"2026-08-19": {
						isWorkday: false,
						lateToleranceMinutes: null,
						note: "Feriado",
					},
				},
			}),
		);

		expect(result.reason).toBe("NOT_WORKDAY");
		expect(result.message).toContain("incidencia");
	});

	test("REST_DAY: es día de descanso de esa persona", () => {
		const result = validateAttendanceMark(
			context({ isRestDay: (date) => date === "2026-08-19" }),
		);
		expect(result.reason).toBe("REST_DAY");
	});

	test("OUTSIDE_TIME_WINDOW: un minuto después del cierre", () => {
		const result = validateAttendanceMark(context({ at: havana("08:16") }));

		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
		expect(result.message).toContain("07:45");
		expect(result.message).toContain("08:16");
	});

	test("INVALID_LOCATION: sin sede seleccionada", () => {
		const result = validateAttendanceMark(
			context({ selectedLocation: null, requestedLocationId: null }),
		);

		expect(result.reason).toBe("INVALID_LOCATION");
		expect(result.message).toContain("Elige tu sede");
	});

	test("INVALID_LOCATION: la sede seleccionada está desactivada", () => {
		const result = validateAttendanceMark(
			context({
				selectedLocation: { ...location, isActive: false },
				activeLocations: [],
			}),
		);

		expect(result.reason).toBe("INVALID_LOCATION");
		expect(result.message).toContain("ya no está activa");
	});

	test("INVALID_LOCATION: el cliente manda una sede que no es la suya", () => {
		const result = validateAttendanceMark(
			context({ requestedLocationId: "33333333-3333-4333-8333-333333333333" }),
		);
		expect(result.reason).toBe("INVALID_LOCATION");
	});

	test("OUTSIDE_GEOFENCE: a 500 m del centro, con la distancia en el mensaje", () => {
		const result = validateAttendanceMark(
			context({
				position: { latitude: 23.1181, longitude: -82.3666, accuracy: 10 },
			}),
		);

		expect(result.reason).toBe("OUTSIDE_GEOFENCE");
		expect(result.insideGeofence).toBe(false);
		expect(result.distanceToCenter).toBeGreaterThan(400);
		expect(result.message).toContain("Sede Central");
	});

	test("OUTSIDE_GEOFENCE: si está dentro de otra sede activa, el mensaje lo dice", () => {
		const other: WorkLocation = {
			...location,
			id: "44444444-4444-4444-8444-444444444444",
			name: "Sede Norte",
			centerLat: 23.1181,
		};

		const result = validateAttendanceMark(
			context({
				activeLocations: [location, other],
				position: { latitude: 23.1181, longitude: -82.3666, accuracy: 10 },
			}),
		);

		expect(result.reason).toBe("OUTSIDE_GEOFENCE");
		expect(result.message).toContain("Sede Norte");
	});

	test("POOR_GPS_ACCURACY: sólo si la sede bloquea con mala precisión", () => {
		const strict = { ...location, blockOnPoorAccuracy: true };

		const blocked = validateAttendanceMark(
			context({
				selectedLocation: strict,
				activeLocations: [strict],
				position: { latitude: 23.1136, longitude: -82.3666, accuracy: 300 },
			}),
		);
		expect(blocked.reason).toBe("POOR_GPS_ACCURACY");

		// Con el interruptor apagado, la misma lectura entra y queda registrada.
		const tolerated = validateAttendanceMark(
			context({
				position: { latitude: 23.1136, longitude: -82.3666, accuracy: 300 },
			}),
		);
		expect(tolerated.accepted).toBe(true);
	});

	test("DUPLICATE_MARK: el mismo marcaje dentro de los 30 s no duplica", () => {
		const result = validateAttendanceMark(
			context({
				at: havana("07:50"),
				recentMarks: [
					{
						id: "ya-existe",
						markType: "IN",
						markedAt: new Date(havana("07:50").getTime() - 5_000),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.duplicate).toBe(true);
		expect(result.accepted).toBe(true);
		expect(result.duplicateOfId).toBe("ya-existe");
		expect(result.reason).toBe("DUPLICATE_MARK");
	});

	test("INVALID_SEQUENCE: dos entradas seguidas", () => {
		const result = validateAttendanceMark(
			context({
				at: havana("08:10"),
				recentMarks: [
					{
						id: "a",
						markType: "IN",
						markedAt: havana("07:50"),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.reason).toBe("INVALID_SEQUENCE");
		expect(result.message).toContain("07:50");
	});

	test("INVALID_SEQUENCE: una salida sin entrada previa", () => {
		const result = validateAttendanceMark(
			context({ markType: "OUT", at: havana("17:00") }),
		);
		expect(result.reason).toBe("INVALID_SEQUENCE");
	});

	test("INVALID_SEQUENCE: dos salidas seguidas", () => {
		const result = validateAttendanceMark(
			context({
				markType: "OUT",
				at: havana("17:30"),
				recentMarks: [
					{
						id: "b",
						markType: "OUT",
						markedAt: havana("17:00"),
						workDate: "2026-08-19",
					},
					{
						id: "a",
						markType: "IN",
						markedAt: havana("07:50"),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.reason).toBe("INVALID_SEQUENCE");
	});
});

describe("orden de evaluación y detalles del registro", () => {
	test("la cuenta desactivada gana sobre todo lo demás", () => {
		const result = validateAttendanceMark(
			context({
				profile: { isActive: false },
				onVacation: true,
				role: "global_manager",
				schedule: null,
			}),
		);
		expect(result.reason).toBe("INACTIVE_ACCOUNT");
	});

	test("las vacaciones ganan sobre el rol y sobre la ventana", () => {
		const result = validateAttendanceMark(
			context({
				onVacation: true,
				role: "global_manager",
				at: havana("03:00"),
			}),
		);
		expect(result.reason).toBe("ON_VACATION");
	});

	test("el antirrebote se adelanta a la ventana horaria y a la secuencia", () => {
		// 08:16 estaría fuera de ventana, pero es el segundo toque del de 08:15:58.
		const result = validateAttendanceMark(
			context({
				at: havana("08:16"),
				recentMarks: [
					{
						id: "primera",
						markType: "IN",
						markedAt: new Date(havana("08:16").getTime() - 2_000),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.duplicate).toBe(true);
		expect(result.reason).toBe("DUPLICATE_MARK");
	});

	test("pasados los 30 s ya no es repetición: manda la regla que toque", () => {
		const result = validateAttendanceMark(
			context({
				at: havana("08:10"),
				recentMarks: [
					{
						id: "primera",
						markType: "IN",
						markedAt: new Date(havana("08:10").getTime() - 31_000),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.duplicate).toBe(false);
		expect(result.reason).toBe("INVALID_SEQUENCE");
	});

	test("un rechazo por ubicación no tapa el marcaje bueno de 20 s después", () => {
		// Los intentos rechazados no entran en `recentMarks` (sólo las aceptadas), así
		// que el segundo intento se juzga por sus propios méritos.
		const result = validateAttendanceMark(context({ recentMarks: [] }));
		expect(result.accepted).toBe(true);
	});

	test("un rechazo horario trae igualmente distancia y pertenencia", () => {
		// La fila del intento rechazado tiene que poder decir dónde estaba la persona.
		const result = validateAttendanceMark(context({ at: havana("03:00") }));

		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
		expect(result.distanceToCenter).not.toBeNull();
		expect(result.insideGeofence).toBe(true);
	});

	test("la jornada nocturna atribuye la salida al día laboral anterior", () => {
		const night = {
			...schedule,
			checkinStartTime: "22:00",
			checkinEndTime: "22:30",
			checkoutStartTime: "05:00",
			checkoutEndTime: "06:00",
		};

		const result = validateAttendanceMark(
			context({
				markType: "OUT",
				at: havana("05:30", "2026-08-20"),
				schedule: night,
				recentMarks: [
					{
						id: "a",
						markType: "IN",
						markedAt: havana("22:10"),
						workDate: "2026-08-19",
					},
				],
			}),
		);

		expect(result.accepted).toBe(true);
		expect(result.workDate).toBe("2026-08-19");
	});
});
