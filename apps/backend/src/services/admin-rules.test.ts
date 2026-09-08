import { describe, expect, test } from "bun:test";
import {
	parseImportRow,
	toImportDate,
	toImportTime,
} from "@elineas/validations";

/**
 * Pruebas puras de la importación de histórico (spec 19 §2.4).
 *
 * **Esto es donde se gana o se pierde la importación de verdad.** Un archivo
 * exportado de Excel no trae fechas como texto: trae **números de serie**, y una
 * hora es una fracción de día. Sin esas dos conversiones, un histórico real daría
 * cero filas válidas y el informe diría "fecha no válida" sobre algo que en la
 * pantalla se ve perfectamente — el peor error posible, porque parece un
 * problema del archivo.
 *
 * Lo que necesita la base está en `routes/admin.test.ts`.
 */

describe("fechas", () => {
	test("texto ISO, con o sin hora detrás", () => {
		expect(toImportDate("2026-03-14")).toBe("2026-03-14");
		expect(toImportDate("2026-03-14T08:00:00.000Z")).toBe("2026-03-14");
	});

	test("número de serie de Excel", () => {
		// El epoch de Excel es el 30/12/1899, no el 1/1/1900: arrastra de Lotus
		// 1-2-3 el año 1900 como bisiesto, que no lo fue.
		expect(toImportDate(45730)).toBe("2025-03-14");
		expect(toImportDate(45730.4791666667)).toBe("2025-03-14");
	});

	test("formato local, que es como lo escribe una persona aquí", () => {
		expect(toImportDate("14/03/2026")).toBe("2026-03-14");
		expect(toImportDate("4-3-2026")).toBe("2026-03-04");
	});

	test("lo que no es una fecha no se adivina", () => {
		expect(toImportDate("marzo")).toBeNull();
		expect(toImportDate("")).toBeNull();
		expect(toImportDate(null)).toBeNull();
		// Un número que no puede ser una fecha razonable tampoco: un `1` sería
		// 1899, y eso es un dato mal puesto, no un histórico.
		expect(toImportDate(1)).toBeNull();
		expect(toImportDate(999_999)).toBeNull();
	});
});

describe("horas", () => {
	test("texto, con y sin segundos", () => {
		expect(toImportTime("08:30")).toBe("08:30");
		expect(toImportTime("08:30:45")).toBe("08:30");
		expect(toImportTime("8:05")).toBe("08:05");
	});

	test("fracción de día de Excel", () => {
		// 0.5 es mediodía, y no es una coincidencia: es medio día.
		expect(toImportTime(0.5)).toBe("12:00");
		expect(toImportTime(0.354166666)).toBe("08:30");
		// Con el día delante, como en un `timestamp` completo.
		expect(toImportTime(45730.75)).toBe("18:00");
	});

	test("una hora imposible no se acepta", () => {
		expect(toImportTime("25:00")).toBeNull();
		expect(toImportTime("08:70")).toBeNull();
		expect(toImportTime("mañana")).toBeNull();
	});
});

describe("una fila entera", () => {
	const row = 7;

	test("acepta el vocabulario en español y en inglés", () => {
		for (const [cell, expected] of [
			["entrada", "IN"],
			["Salida", "OUT"],
			["IN", "IN"],
			["out", "OUT"],
		] as const) {
			const result = parseImportRow(
				["alguien@elineas.com", "2026-03-14", "08:00", cell],
				row,
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.markType).toBe(expected);
		}
	});

	test("normaliza el correo, que es la clave con la que se busca a la persona", () => {
		const result = parseImportRow(
			["  Alguien@Elineas.COM ", "2026-03-14", "08:00", "IN"],
			row,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.email).toBe("alguien@elineas.com");
	});

	test("devuelve el motivo y la fila, no una excepción", () => {
		// RN-19.2 pide un informe con **las** filas con error y su motivo; con una
		// excepción sólo se podría contar la primera.
		const result = parseImportRow(["no-es-un-correo", "x", "y", "z"], row);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issue.row).toBe(row);
			expect(result.issue.message).toContain("correo");
		}
	});

	test("cada columna que falta tiene su propio mensaje", () => {
		const cases = [
			[["a@b.com", "no es fecha", "08:00", "IN"], "fecha"],
			[["a@b.com", "2026-03-14", "no es hora", "IN"], "hora"],
			[["a@b.com", "2026-03-14", "08:00", "bailar"], "tipo"],
		] as const;

		for (const [cells, expected] of cases) {
			const result = parseImportRow(cells, row);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.issue.message.toLowerCase()).toContain(expected);
		}
	});
});
