import { describe, expect, test } from "bun:test";
import {
	type MarkTimeInput,
	resolveWorkday,
	todayIn,
	validateMarkTime,
	zonedParts,
} from "#/services/schedule-rules.ts";

/**
 * Pruebas de la parte horaria de la validación de un marcaje (spec 07 §4).
 *
 * La spec lo pide con nombre y apellido: *"Esta función es el corazón de reglas
 * del producto. Debe tener tests unitarios exhaustivos: es el punto 71 de la deuda
 * del legacy (cero cobertura) y no debe repetirse."*
 *
 * Son **unitarias de verdad**: la función es pura, así que aquí no hay base de
 * datos, ni Identity Server, ni reloj del sistema — el instante entra como
 * argumento. Eso permite probar la medianoche, una zona horaria distinta a la del
 * servidor y el minuto exacto del límite sin montar un escenario.
 */

/** Diurno: entra de 07:45 a 08:15, sale de 16:00 a 18:00. La Habana. */
const dayShift = {
	checkinStartTime: "07:45",
	checkinEndTime: "08:15",
	checkoutStartTime: "16:00",
	checkoutEndTime: "18:00",
	timezone: "America/Havana",
	allowEarlyCheckin: false,
	allowLateCheckout: false,
};

/** Nocturno: entra de 22:00 a 22:30 y sale de 05:00 a 06:00 del día siguiente. */
const nightShift = {
	...dayShift,
	checkinStartTime: "22:00",
	checkinEndTime: "22:30",
	checkoutStartTime: "05:00",
	checkoutEndTime: "06:00",
};

/** La Habana está en UTC−4 en agosto: 12:00Z son las 08:00 locales. */
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

function input(overrides: Partial<MarkTimeInput> = {}): MarkTimeInput {
	return {
		markType: "IN",
		at: havana("08:00"),
		role: "employee",
		department: { isPaused: false, pauseReason: null },
		schedule: dayShift,
		globalToleranceMinutes: 0,
		...overrides,
	};
}

describe("orden de evaluación (spec 07 §4)", () => {
	test("el rol se comprueba primero: el gestor global no marca (RN-03.4)", () => {
		const result = validateMarkTime(
			input({
				role: "global_manager",
				// Todo lo demás también fallaría; lo que se comprueba es que gana el rol.
				department: { isPaused: true, pauseReason: "inventario" },
				schedule: null,
			}),
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("ROLE_CANNOT_MARK");
	});

	test("el superadmin sí marca, porque hereda al empleado (spec 03 §2)", () => {
		expect(validateMarkTime(input({ role: "superadmin" })).allowed).toBe(true);
	});

	test("la pausa del departamento gana sobre el calendario (RN-07.9)", () => {
		const result = validateMarkTime(
			input({
				department: { isPaused: true, pauseReason: "corte de agua" },
				calendarByDate: {
					"2026-08-19": { isWorkday: false, lateToleranceMinutes: null },
				},
			}),
		);

		expect(result.reason).toBe("DEPARTMENT_PAUSED");
		// El motivo viaja en el mensaje: un rechazo sin motivo obliga a preguntar.
		expect(result.message).toContain("corte de agua");
	});

	test("sin horario configurado no se puede marcar (RN-09.4)", () => {
		const result = validateMarkTime(input({ schedule: null }));
		expect(result.reason).toBe("NO_SCHEDULE");
	});

	test("el día no laborable se comprueba antes de la ventana horaria", () => {
		const result = validateMarkTime(
			input({
				// 03:00: fuera de toda ventana. Aun así el motivo es el calendario,
				// porque es el paso 3 y la ventana el 5.
				at: havana("03:00"),
				calendarByDate: {
					"2026-08-19": {
						isWorkday: false,
						lateToleranceMinutes: null,
						note: "Feriado: día de prueba",
					},
				},
			}),
		);

		expect(result.reason).toBe("NOT_WORKDAY");
		expect(result.message).toContain("Feriado: día de prueba");
	});

	test("el descanso se comprueba antes de la ventana (RN-10.4)", () => {
		const result = validateMarkTime(
			input({
				at: havana("03:00"),
				isRestDay: (date) => date === "2026-08-19",
			}),
		);
		expect(result.reason).toBe("REST_DAY");
	});
});

describe("ventana de entrada (RN-07.3)", () => {
	test("dentro de la ventana se acepta", () => {
		const result = validateMarkTime(input({ at: havana("07:50") }));
		expect(result.allowed).toBe(true);
		expect(result.workDate).toBe("2026-08-19");
		expect(result.localTime).toBe("07:50");
	});

	test("el minuto exacto del cierre todavía entra", () => {
		expect(validateMarkTime(input({ at: havana("08:15") })).allowed).toBe(true);
	});

	test("un minuto después del cierre se rechaza con motivo legible", () => {
		const result = validateMarkTime(input({ at: havana("08:16") }));

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
		// Criterio de aceptación: el rechazo dice la ventana y la hora que es.
		expect(result.message).toContain("07:45");
		expect(result.message).toContain("08:15");
		expect(result.message).toContain("08:16");
	});

	test("antes de la apertura se rechaza si no hay entrada anticipada", () => {
		expect(validateMarkTime(input({ at: havana("07:15") })).reason).toBe(
			"OUTSIDE_TIME_WINDOW",
		);
	});

	test("con entrada anticipada, 30 minutos antes se acepta y no es tardanza", () => {
		const result = validateMarkTime(
			input({
				at: havana("07:15"),
				schedule: { ...dayShift, allowEarlyCheckin: true },
			}),
		);

		expect(result.allowed).toBe(true);
		expect(result.isLate).toBe(false);
		expect(result.lateMinutes).toBe(0);
	});

	test("la entrada anticipada no abre la ventana del día anterior", () => {
		const result = validateMarkTime(
			input({
				at: havana("23:30", "2026-08-18"),
				schedule: { ...dayShift, allowEarlyCheckin: true },
			}),
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
	});
});

describe("ventana de salida (RN-07.4)", () => {
	test("dentro de la ventana se acepta y no se evalúa tardanza", () => {
		const result = validateMarkTime(
			input({ markType: "OUT", at: havana("17:00") }),
		);

		expect(result.allowed).toBe(true);
		// La tardanza es un concepto de la entrada (RN-09.7): en la salida no viene.
		expect(result.isLate).toBeUndefined();
		expect(result.lateMinutes).toBeUndefined();
	});

	test("después del cierre se rechaza salvo con salida tardía", () => {
		expect(
			validateMarkTime(input({ markType: "OUT", at: havana("18:30") })).reason,
		).toBe("OUTSIDE_TIME_WINDOW");

		expect(
			validateMarkTime(
				input({
					markType: "OUT",
					at: havana("18:30"),
					schedule: { ...dayShift, allowLateCheckout: true },
				}),
			).allowed,
		).toBe(true);
	});

	test("la salida tardía llega hasta el final del día, no más", () => {
		const late = { ...dayShift, allowLateCheckout: true };

		expect(
			validateMarkTime(
				input({ markType: "OUT", at: havana("23:59"), schedule: late }),
			).allowed,
		).toBe(true);

		// 00:10 del día siguiente ya es otro día laboral, y en él la ventana de
		// salida no ha abierto.
		expect(
			validateMarkTime(
				input({
					markType: "OUT",
					at: havana("00:10", "2026-08-20"),
					schedule: late,
				}),
			).reason,
		).toBe("OUTSIDE_TIME_WINDOW");
	});
});

describe("tardanza (RN-07.8, RN-09.7)", () => {
	test("dentro de ventana pero pasada la tolerancia: se acepta y queda como tarde", () => {
		const result = validateMarkTime(
			input({ at: havana("07:51"), globalToleranceMinutes: 5 }),
		);

		expect(result.allowed).toBe(true);
		expect(result.isLate).toBe(true);
		// Los minutos son de retraso real sobre las 07:45, no lo que sobra de la
		// tolerancia.
		expect(result.lateMinutes).toBe(6);
		expect(result.toleranceMinutes).toBe(5);
	});

	test("3 minutos tarde con tolerancia de 5 no genera tardanza", () => {
		const result = validateMarkTime(
			input({ at: havana("07:48"), globalToleranceMinutes: 5 }),
		);

		expect(result.allowed).toBe(true);
		expect(result.isLate).toBe(false);
		expect(result.lateMinutes).toBe(3);
	});

	test("la tolerancia de la fecha gana sobre la global", () => {
		const at = havana("08:05");

		const withGlobal = validateMarkTime(
			input({ at, globalToleranceMinutes: 5 }),
		);
		expect(withGlobal.isLate).toBe(true);
		expect(withGlobal.toleranceSource).toBe("global");

		const withDate = validateMarkTime(
			input({
				at,
				globalToleranceMinutes: 5,
				calendarByDate: {
					"2026-08-19": { isWorkday: true, lateToleranceMinutes: 30 },
				},
			}),
		);
		expect(withDate.isLate).toBe(false);
		expect(withDate.toleranceMinutes).toBe(30);
		expect(withDate.toleranceSource).toBe("calendar");
	});

	test("una tolerancia de 0 en la fecha gana sobre una global generosa", () => {
		const result = validateMarkTime(
			input({
				at: havana("07:46"),
				globalToleranceMinutes: 60,
				calendarByDate: {
					"2026-08-19": { isWorkday: true, lateToleranceMinutes: 0 },
				},
			}),
		);

		expect(result.isLate).toBe(true);
		expect(result.toleranceMinutes).toBe(0);
	});
});

describe("calendario (RN-07.6, RN-07.7)", () => {
	test("una fecha sin fila es laborable por defecto", () => {
		const result = validateMarkTime(input({ calendarByDate: {} }));
		expect(result.allowed).toBe(true);
	});

	test("una fila laborable explícita no cambia nada", () => {
		const result = validateMarkTime(
			input({
				calendarByDate: {
					"2026-08-19": { isWorkday: true, lateToleranceMinutes: null },
				},
			}),
		);
		expect(result.allowed).toBe(true);
	});

	test("la fila de otra fecha no afecta a este marcaje", () => {
		const result = validateMarkTime(
			input({
				calendarByDate: {
					"2026-08-20": { isWorkday: false, lateToleranceMinutes: null },
				},
			}),
		);
		expect(result.allowed).toBe(true);
	});
});

describe("jornada nocturna (RN-07.5)", () => {
	test("la entrada de la noche pertenece a su propio día", () => {
		const result = validateMarkTime(
			input({ at: havana("22:10"), schedule: nightShift }),
		);

		expect(result.allowed).toBe(true);
		expect(result.workDate).toBe("2026-08-19");
	});

	test("la salida de la madrugada pertenece al día laboral anterior", () => {
		const result = validateMarkTime(
			input({
				markType: "OUT",
				at: havana("05:30", "2026-08-20"),
				schedule: nightShift,
			}),
		);

		expect(result.allowed).toBe(true);
		expect(result.workDate).toBe("2026-08-19");
	});

	test("el calendario se consulta con el día laboral, no con el día natural", () => {
		const result = validateMarkTime(
			input({
				markType: "OUT",
				at: havana("05:30", "2026-08-20"),
				schedule: nightShift,
				calendarByDate: {
					// El día natural (20) es laborable; el laboral al que pertenece la
					// salida (19) no lo es.
					"2026-08-19": { isWorkday: false, lateToleranceMinutes: null },
					"2026-08-20": { isWorkday: true, lateToleranceMinutes: null },
				},
			}),
		);

		expect(result.reason).toBe("NOT_WORKDAY");
		expect(result.workDate).toBe("2026-08-19");
	});

	test("el descanso también se juzga por el día laboral", () => {
		const result = validateMarkTime(
			input({
				markType: "OUT",
				at: havana("05:30", "2026-08-20"),
				schedule: nightShift,
				isRestDay: (date) => date === "2026-08-19",
			}),
		);

		expect(result.reason).toBe("REST_DAY");
	});

	test("fuera de la madrugada, la salida vuelve a ser del día natural", () => {
		const result = validateMarkTime(
			input({
				markType: "OUT",
				at: havana("12:00", "2026-08-20"),
				schedule: nightShift,
			}),
		);

		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
		expect(result.workDate).toBe("2026-08-20");
	});

	test("un horario diurno nunca atribuye una marca al día anterior", () => {
		const result = validateMarkTime(
			input({ at: havana("07:50"), schedule: dayShift }),
		);
		expect(result.workDate).toBe("2026-08-19");
	});
});

describe("zona horaria (RN-07.2)", () => {
	// El mismo instante, dos departamentos: la decisión sale de la zona del
	// horario, nunca de la del servidor — que dentro de un contenedor es UTC.
	const instant = new Date("2026-08-19T12:00:00.000Z");

	test("en La Habana son las 08:00 y el marcaje entra", () => {
		const result = validateMarkTime(input({ at: instant }));
		expect(result.allowed).toBe(true);
		expect(result.localTime).toBe("08:00");
	});

	test("con el mismo horario en Tokio son las 21:00 y se rechaza", () => {
		const result = validateMarkTime(
			input({ at: instant, schedule: { ...dayShift, timezone: "Asia/Tokyo" } }),
		);

		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
		expect(result.localTime).toBe("21:00");
	});

	test("en UTC son las 12:00 y también se rechaza", () => {
		const result = validateMarkTime(
			input({ at: instant, schedule: { ...dayShift, timezone: "UTC" } }),
		);
		expect(result.localTime).toBe("12:00");
		expect(result.reason).toBe("OUTSIDE_TIME_WINDOW");
	});

	test("la fecha local puede ser distinta de la del instante en UTC", () => {
		// 03:00Z del día 20 son las 23:00 del 19 en La Habana.
		const result = validateMarkTime(
			input({
				markType: "OUT",
				at: new Date("2026-08-20T03:00:00.000Z"),
				schedule: { ...dayShift, allowLateCheckout: true },
			}),
		);

		expect(result.allowed).toBe(true);
		expect(result.workDate).toBe("2026-08-19");
	});
});

describe("utilidades", () => {
	test("zonedParts convierte un instante a fecha y minutos locales", () => {
		const parts = zonedParts(
			new Date("2026-08-19T12:00:00.000Z"),
			"America/Havana",
		);
		expect(parts).toEqual({ date: "2026-08-19", minutes: 8 * 60 });
	});

	test("todayIn resuelve el día en la zona pedida", () => {
		const at = new Date("2026-08-20T03:00:00.000Z");
		expect(todayIn("America/Havana", at)).toBe("2026-08-19");
		expect(todayIn("UTC", at)).toBe("2026-08-20");
	});

	test("resolveWorkday: sin fila, laborable con la tolerancia global", () => {
		expect(resolveWorkday("2026-08-19", null, 7)).toEqual({
			date: "2026-08-19",
			isWorkday: true,
			fromDefault: true,
			lateToleranceMinutes: 7,
			toleranceSource: "global",
			note: null,
		});
	});

	test("resolveWorkday: con fila, manda la fila", () => {
		expect(
			resolveWorkday(
				"2026-08-19",
				{ isWorkday: false, lateToleranceMinutes: 20, note: "Inventario" },
				7,
			),
		).toEqual({
			date: "2026-08-19",
			isWorkday: false,
			fromDefault: false,
			lateToleranceMinutes: 20,
			toleranceSource: "calendar",
			note: "Inventario",
		});
	});
});
