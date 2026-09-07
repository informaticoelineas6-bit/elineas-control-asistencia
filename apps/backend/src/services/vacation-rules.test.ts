import { describe, expect, test } from "bun:test";
import {
	computeBalance,
	countWorkableDays,
	createVacationRequestInputSchema,
	MAX_VACATION_REQUEST_DAYS,
	rangesOverlap,
	reviewVacationRequestInputSchema,
} from "@elineas/validations";

/**
 * Pruebas de la aritmética compartida de vacaciones (spec 11 §2, RN-11.5,
 * RN-11.6), pura y exhaustiva — igual que `rest-rules.test.ts` para la spec 10.
 * La resolución con base de datos (saldo real, solapamiento, transacción) se
 * prueba en `routes/vacations.test.ts`.
 */

describe("computeBalance (§2)", () => {
	test("available = earned − aprobados − pendientes", () => {
		const balance = computeBalance({
			earnedDays: 10,
			approvedDays: 3,
			pendingDays: 2,
		});
		expect(balance).toEqual({ earned: 10, used: 3, pending: 2, available: 5 });
	});

	test("redondea a dos decimales sin arrastrar el error de coma flotante", () => {
		// 7 días × 1/24 acumula un decimal largo si no se redondea.
		const balance = computeBalance({
			earnedDays: 7 * (1 / 24),
			approvedDays: 0,
			pendingDays: 0,
		});
		expect(balance.earned).toBe(0.29);
	});

	test("un saldo consumido de más que lo ganado da disponible negativo", () => {
		// No debería llegar a pasar (RN-11.1 lo bloquea al escribir), pero la
		// función en sí no oculta el número: quien la llama decide qué hacer.
		const balance = computeBalance({
			earnedDays: 1,
			approvedDays: 2,
			pendingDays: 0,
		});
		expect(balance.available).toBe(-1);
	});
});

describe("rangesOverlap (RN-11.6)", () => {
	const range = (startDate: string, endDate: string) => ({
		startDate,
		endDate,
	});

	test("rangos idénticos se solapan", () => {
		expect(
			rangesOverlap(
				range("2026-09-01", "2026-09-05"),
				range("2026-09-01", "2026-09-05"),
			),
		).toBe(true);
	});

	test("uno dentro del otro se solapa", () => {
		expect(
			rangesOverlap(
				range("2026-09-01", "2026-09-10"),
				range("2026-09-03", "2026-09-04"),
			),
		).toBe(true);
	});

	test("se tocan en un solo día: se solapan (los dos extremos son inclusivos)", () => {
		expect(
			rangesOverlap(
				range("2026-09-01", "2026-09-05"),
				range("2026-09-05", "2026-09-10"),
			),
		).toBe(true);
	});

	test("un día de por medio: no se solapan", () => {
		expect(
			rangesOverlap(
				range("2026-09-01", "2026-09-05"),
				range("2026-09-07", "2026-09-10"),
			),
		).toBe(false);
	});

	test("el orden de los argumentos no cambia el resultado", () => {
		const a = range("2026-09-01", "2026-09-05");
		const b = range("2026-09-04", "2026-09-08");
		expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a));
	});
});

describe("countWorkableDays (RN-11.5, decisión 2 de la §9)", () => {
	const dates = [
		"2026-09-14", // lunes, laborable
		"2026-09-15", // martes, laborable
		"2026-09-16", // miércoles, no laborable (feriado)
		"2026-09-17", // jueves, laborable pero es descanso
		"2026-09-18", // viernes, laborable
	];
	const isWorkday = (date: string) => date !== "2026-09-16";
	const isRestDay = (date: string) => date === "2026-09-17";

	test("cuenta sólo los días laborables y que no son descanso", () => {
		expect(countWorkableDays(dates, isWorkday, isRestDay)).toBe(3);
	});

	test("un rango enteramente no laborable o de descanso consume 0", () => {
		expect(countWorkableDays(["2026-09-16"], isWorkday, isRestDay)).toBe(0);
		expect(countWorkableDays(["2026-09-17"], isWorkday, isRestDay)).toBe(0);
	});

	test("sin descansos ni no laborables, cuenta el rango completo", () => {
		expect(
			countWorkableDays(
				dates,
				() => true,
				() => false,
			),
		).toBe(dates.length);
	});
});

describe("createVacationRequestInputSchema", () => {
	test("rechaza el rango invertido", () => {
		const result = createVacationRequestInputSchema.safeParse({
			startDate: "2026-09-10",
			endDate: "2026-09-01",
		});
		expect(result.success).toBe(false);
	});

	test("rechaza un rango más largo que el techo técnico", () => {
		const result = createVacationRequestInputSchema.safeParse({
			startDate: "2026-01-01",
			endDate: "2028-01-01",
		});
		expect(result.success).toBe(false);
	});

	test("acepta un rango normal", () => {
		const result = createVacationRequestInputSchema.safeParse({
			startDate: "2026-09-14",
			endDate: "2026-09-20",
		});
		expect(result.success).toBe(true);
	});

	test("acepta justo el techo técnico, un año", () => {
		const result = createVacationRequestInputSchema.safeParse({
			startDate: "2026-01-01",
			endDate: "2027-01-01",
		});
		expect(MAX_VACATION_REQUEST_DAYS).toBe(366);
		expect(result.success).toBe(true);
	});
});

describe("reviewVacationRequestInputSchema (asimetría de RN-11.10)", () => {
	test("aprobar sin comentario es válido", () => {
		expect(
			reviewVacationRequestInputSchema.safeParse({ approved: true }).success,
		).toBe(true);
	});

	test("rechazar sin comentario no es válido", () => {
		const result = reviewVacationRequestInputSchema.safeParse({
			approved: false,
		});
		expect(result.success).toBe(false);
	});

	test("rechazar con comentario sí es válido", () => {
		expect(
			reviewVacationRequestInputSchema.safeParse({
				approved: false,
				comment: "No hay cobertura para esas fechas.",
			}).success,
		).toBe(true);
	});
});
