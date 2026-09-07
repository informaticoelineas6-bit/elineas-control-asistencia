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
		onVacation: false,
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

	test("VACACIONES: solicitud aprobada y vigente (spec 11 RN-11.12)", () => {
		expect(computeDailyStatus(context({ onVacation: true })).status).toBe(
			"VACACIONES",
		);
	});

	test("VACACIONES gana sobre DESCANSO (RN-15.1): no consume, pero se presenta así", () => {
		expect(
			computeDailyStatus(context({ onVacation: true, isRestDay: true })).status,
		).toBe("VACACIONES");
	});

	test("NO_LABORABLE gana sobre VACACIONES (RN-15.1)", () => {
		expect(
			computeDailyStatus(context({ onVacation: true, isWorkday: false }))
				.status,
		).toBe("NO_LABORABLE");
	});

	test("con marcas, la presencia gana también sobre vacaciones (RN-15.2)", () => {
		const fact = computeDailyStatus(
			context({
				onVacation: true,
				marks: [mark("IN", "07:50"), mark("OUT", "12:00")],
			}),
		);

		expect(fact.status).toBe("PRESENTE");
	});
});

describe("superposición AJ/ANJ (spec 13, RN-13.1 y RN-13.10)", () => {
	test("un día ausente sin revisar es ANJ, y consta que nadie lo revisó", () => {
		const day = computeDailyStatus(context());
		expect(day.status).toBe("AUSENTE");
		expect(day.absence).toEqual({ code: "ANJ", reviewed: false, notes: null });
	});

	test("revisado como justificado sale AJ, con sus notas", () => {
		const day = computeDailyStatus(
			context({
				absenceReview: { isJustified: true, notes: "Certificado médico" },
			}),
		);
		expect(day.absence).toEqual({
			code: "AJ",
			reviewed: true,
			notes: "Certificado médico",
		});
	});

	test("revisado como injustificado sale ANJ, pero revisado", () => {
		// Es la distinción que RN-13.10 necesita: en el reporte se ven igual, y en
		// la nómina no — sólo la decisión explícita descuenta.
		const day = computeDailyStatus(
			context({ absenceReview: { isJustified: false, notes: null } }),
		);
		expect(day.absence).toEqual({ code: "ANJ", reviewed: true, notes: null });
	});

	test("una jornada que aún puede completarse no se clasifica", () => {
		const day = computeDailyStatus(context({ isOpen: true }));
		expect(day.pending).toBe(true);
		expect(day.absence).toBeNull();
	});

	test("ningún otro estado lleva superposición (RN-13.1)", () => {
		// La lista de la regla, entera: presente, descanso, no laborable y
		// vacaciones. Que esta función devuelva `null` en los cuatro es lo que
		// permite comprobar RN-13.1 en el servidor mirando un solo campo.
		expect(
			computeDailyStatus(context({ marks: [mark("IN", "08:00")] })).absence,
		).toBeNull();
		expect(computeDailyStatus(context({ isRestDay: true })).absence).toBeNull();
		expect(
			computeDailyStatus(context({ isWorkday: false })).absence,
		).toBeNull();
		expect(
			computeDailyStatus(context({ onVacation: true })).absence,
		).toBeNull();
	});

	test("una revisión sobre un día que dejó de ser ausente se ignora", () => {
		// Puede pasar: alguien justifica el día 3 y luego se importa un marcaje
		// histórico de ese día (RN-15.2). El día pasa a PRESENTE y la fila de
		// revisión queda huérfana; enseñar "AJ" sobre un día presente sería peor
		// que ignorarla.
		const day = computeDailyStatus(
			context({
				marks: [mark("IN", "08:00")],
				absenceReview: { isJustified: true, notes: "Certificado" },
			}),
		);
		expect(day.status).toBe("PRESENTE");
		expect(day.absence).toBeNull();
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
