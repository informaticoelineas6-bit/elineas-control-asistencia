import { describe, expect, test } from "bun:test";
import {
	computeDailyStatus,
	type DailyContext,
} from "#/services/daily-status.ts";

/**
 * Pruebas de la clasificación de un día (spec 15 §2 y §3, adelantada por la 09 §5).
 *
 * Es la función que van a compartir el historial propio, "Mi semana", los paneles y
 * la reportería mensual. En el legacy esta lógica estaba en tres sitios distintos;
 * aquí se prueba una vez porque hay una sola.
 */

const at = (localTime: string, date = "2026-08-19") => {
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

const mark = (
	markType: "IN" | "OUT",
	localTime: string,
	late = { isLate: false, lateMinutes: 0 },
) => ({ markType, markedAt: at(localTime), ...late });

function context(overrides: Partial<DailyContext> = {}): DailyContext {
	return {
		date: "2026-08-19",
		marks: [],
		isWorkday: true,
		isRestDay: false,
		...overrides,
	};
}

describe("estados (spec 15 §2)", () => {
	test("PRESENTE: entrada y salida dentro de tolerancia", () => {
		const fact = computeDailyStatus(
			context({ marks: [mark("IN", "07:50"), mark("OUT", "17:00")] }),
		);

		expect(fact.status).toBe("PRESENTE");
		expect(fact.incomplete).toBe(false);
		expect(fact.workedMinutes).toBe(9 * 60 + 10);
	});

	test("TARDE: la entrada pasó la tolerancia", () => {
		const fact = computeDailyStatus(
			context({
				marks: [
					mark("IN", "08:10", { isLate: true, lateMinutes: 25 }),
					mark("OUT", "17:00"),
				],
			}),
		);

		expect(fact.status).toBe("TARDE");
		expect(fact.isLate).toBe(true);
		expect(fact.lateMinutes).toBe(25);
	});

	test("AUSENTE: día laborable sin marcas", () => {
		const fact = computeDailyStatus(context());
		expect(fact.status).toBe("AUSENTE");
		expect(fact.workedMinutes).toBeNull();
		expect(fact.pending).toBe(false);
	});

	test("AUSENTE de una jornada que sigue abierta queda como provisional", () => {
		const fact = computeDailyStatus(context({ isOpen: true }));
		expect(fact.status).toBe("AUSENTE");
		expect(fact.pending).toBe(true);
	});

	test("DESCANSO: día de descanso de la persona", () => {
		expect(computeDailyStatus(context({ isRestDay: true })).status).toBe(
			"DESCANSO",
		);
	});

	test("NO_LABORABLE: el calendario del departamento lo marca así", () => {
		expect(computeDailyStatus(context({ isWorkday: false })).status).toBe(
			"NO_LABORABLE",
		);
	});

	test("NO_LABORABLE gana sobre DESCANSO cuando no hay marcas", () => {
		expect(
			computeDailyStatus(context({ isWorkday: false, isRestDay: true })).status,
		).toBe("NO_LABORABLE");
	});

	test("con marcas, la presencia gana sobre no laborable (RN-15.2)", () => {
		const fact = computeDailyStatus(
			context({
				isWorkday: false,
				isRestDay: true,
				marks: [mark("IN", "07:50"), mark("OUT", "12:00")],
			}),
		);

		expect(fact.status).toBe("PRESENTE");
	});
});

describe("datos derivados (spec 15 §3)", () => {
	test("jornada sin salida: incompleta y sin minutos inventados (RN-15.3)", () => {
		const fact = computeDailyStatus(context({ marks: [mark("IN", "07:50")] }));

		expect(fact.incomplete).toBe(true);
		expect(fact.workedMinutes).toBeNull();
		expect(fact.firstIn).not.toBeNull();
		expect(fact.lastOut).toBeNull();
	});

	test("dos pares: el almuerzo no cuenta como trabajado", () => {
		const fact = computeDailyStatus(
			context({
				marks: [
					mark("IN", "08:00"),
					mark("OUT", "12:00"),
					mark("IN", "13:00"),
					mark("OUT", "17:00"),
				],
			}),
		);

		// 4 h + 4 h, no las 9 h que hay entre la primera entrada y la última salida.
		expect(fact.workedMinutes).toBe(8 * 60);
		expect(fact.firstIn).toEqual(at("08:00"));
		expect(fact.lastOut).toEqual(at("17:00"));
	});

	test("el orden de llegada de las marcas no altera el cálculo", () => {
		const fact = computeDailyStatus(
			context({ marks: [mark("OUT", "17:00"), mark("IN", "07:00")] }),
		);
		expect(fact.workedMinutes).toBe(10 * 60);
	});

	test("una salida suelta deja el día sin minutos y no la cuenta", () => {
		const fact = computeDailyStatus(context({ marks: [mark("OUT", "17:00")] }));

		expect(fact.status).toBe("PRESENTE");
		expect(fact.workedMinutes).toBe(0);
		expect(fact.firstIn).toBeNull();
	});
});
