import { describe, expect, test } from "bun:test";
import {
	effectivePeriodOf,
	reviewAbsenceInputSchema,
} from "@elineas/validations";

/**
 * Pruebas de las reglas puras de la justificación de ausencias (spec 13 RN-13.6)
 * y del periodo de nómina (spec 17 §7).
 *
 * La regla central de esta spec —RN-13.1, sólo días ausentes— no vive aquí sino
 * en `daily-status.test.ts`, porque es la superposición de la agregación diaria
 * la que decide qué días son clasificables; y la cadena de RN-13.4, que es la
 * crítica, se prueba con la base delante en `routes/absences.test.ts`: un
 * descuento no se demuestra sin contar filas.
 */

describe("RN-13.6 — la asimetría de las notas", () => {
	test("justificar sin notas falla, y el error apunta al campo", () => {
		const result = reviewAbsenceInputSchema.safeParse({ isJustified: true });
		expect(result.success).toBe(false);
		expect(result.error?.issues.at(0)?.path).toEqual(["notes"]);
	});

	test("justificar con notas de sólo espacios también falla", () => {
		expect(
			reviewAbsenceInputSchema.safeParse({ isJustified: true, notes: "   " })
				.success,
		).toBe(false);
	});

	test("justificar con notas pasa", () => {
		expect(
			reviewAbsenceInputSchema.safeParse({
				isJustified: true,
				notes: "Certificado médico entregado en RRHH.",
			}).success,
		).toBe(true);
	});

	test("marcar injustificada no exige notas", () => {
		expect(
			reviewAbsenceInputSchema.safeParse({ isJustified: false }).success,
		).toBe(true);
	});

	test("es la asimetría inversa a la de incidencias y vacaciones", () => {
		// Allí el que exige motivo es el **rechazo**; aquí, la justificación. El
		// criterio es el mismo —se pide la razón de la decisión discrecional— y lo
		// que cambia es cuál lo es: allí negar algo a una persona, aquí perdonar un
		// descuento.
		expect(
			reviewAbsenceInputSchema.safeParse({ isJustified: false }).success,
		).toBe(true);
		expect(
			reviewAbsenceInputSchema.safeParse({ isJustified: true }).success,
		).toBe(false);
	});
});

describe("effectivePeriodOf (spec 17 §7)", () => {
	test("el periodo es el mes de la ausencia, en su día 1", () => {
		expect(effectivePeriodOf("2026-03-17")).toBe("2026-03-01");
	});

	test("el primero y el último día del mes caen en el mismo periodo", () => {
		expect(effectivePeriodOf("2026-01-01")).toBe("2026-01-01");
		expect(effectivePeriodOf("2026-01-31")).toBe("2026-01-01");
	});

	test("no depende de cuándo se revisó: responde la pregunta de la §7", () => {
		// "Un descuento por una ausencia de marzo registrado en abril, ¿a qué mes
		// pertenece?" — a marzo. La función sólo mira la fecha de la ausencia
		// porque es el único argumento que recibe.
		expect(effectivePeriodOf("2026-03-31")).toBe("2026-03-01");
	});
});
