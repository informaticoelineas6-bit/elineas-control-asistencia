import { describe, expect, test } from "bun:test";
import {
	buildReportGrid,
	dayCodeOf,
	dayCodeSchema,
	type MonthlyReport,
	p95,
	summarizeCodes,
	summaryTotal,
	toValueMatrix,
} from "@elineas/validations";
import { readXlsx } from "hucre/xlsx";
import { reportToXlsx } from "#/services/xlsx.ts";
import { periodRange } from "#/services/reports.ts";

/**
 * Pruebas de la matriz del reporte (spec 16 §2 y §7).
 *
 * La importante es la última: **el XLSX y la matriz que consume Google Sheets
 * salen del mismo módulo, y se comparan celda a celda**. Es el criterio de
 * aceptación que la §7 marca como *requisito, no sugerencia*, y responde a la
 * deuda crítica del punto 73 — en el legacy las dos exportaciones eran dos
 * implementaciones y nada detectaba que se hubieran separado.
 */

const report = (rows: MonthlyReport["rows"]): MonthlyReport => ({
	period: "2026-03",
	scope: "global",
	departmentId: null,
	days: ["2026-03-01", "2026-03-02", "2026-03-03"],
	rows,
	ruleVersion: 1,
	generatedAt: "2026-03-31T12:00:00.000Z",
});

const row = (codes: MonthlyReport["rows"][number]["codes"]) => ({
	userId: "11111111-1111-4111-8111-111111111111",
	userFullName: "Ana Pérez",
	userEmail: "ana@elineas.test",
	departmentId: "22222222-2222-4222-8222-222222222222",
	departmentName: "Almacén",
	codes,
	summary: summarizeCodes(codes),
});

describe("§2 — los códigos", () => {
	test("cada estado de la spec 15 tiene su código", () => {
		expect(dayCodeOf("PRESENTE", null)).toBe("P");
		expect(dayCodeOf("TARDE", null)).toBe("T");
		expect(dayCodeOf("DESCANSO", null)).toBe("D");
		expect(dayCodeOf("NO_LABORABLE", null)).toBe("NL");
		expect(dayCodeOf("VACACIONES", null)).toBe("V");
	});

	test("una ausencia revisada toma el código de su decisión", () => {
		expect(
			dayCodeOf("AUSENTE", { code: "AJ", reviewed: true, notes: null }),
		).toBe("AJ");
		expect(
			dayCodeOf("AUSENTE", { code: "ANJ", reviewed: true, notes: null }),
		).toBe("ANJ");
	});

	test("una ausencia sin revisar es ANJ (RN-13.10)", () => {
		// El reporte no esconde una ausencia que nadie explicó, aunque no genere
		// descuento. Es la asimetría que la spec 13 cerró.
		expect(dayCodeOf("AUSENTE", null)).toBe("ANJ");
	});

	test("los siete códigos de la §2 y ninguno más", () => {
		expect([...dayCodeSchema.options]).toEqual([
			"P",
			"T",
			"D",
			"NL",
			"V",
			"AJ",
			"ANJ",
		]);
	});
});

describe("RN-16.1 — los totales cuadran", () => {
	test("la suma del resumen es el número de días", () => {
		const codes = ["P", "P", "T", "D", "NL", "V", "AJ", "ANJ"] as const;
		const summary = summarizeCodes([...codes]);

		expect(summary).toEqual({
			presente: 2,
			tardanza: 1,
			descanso: 1,
			noLaborable: 1,
			vacaciones: 1,
			ausenciaJustificada: 1,
			ausenciaInjustificada: 1,
		});
		expect(summaryTotal(summary)).toBe(codes.length);
	});

	test("cuadra para cualquier combinación, incluido un mes entero", () => {
		// Cada código, repetido lo bastante para cubrir 31 días.
		const codes = Array.from(
			{ length: 31 },
			(_, index) => dayCodeSchema.options[index % 7] ?? "P",
		);
		expect(summaryTotal(summarizeCodes(codes))).toBe(31);
	});

	test("un mes sin nada sigue cuadrando", () => {
		expect(summaryTotal(summarizeCodes([]))).toBe(0);
	});
});

describe("el periodo es un mes natural (decisión 3 de la §11)", () => {
	test("marzo va del 1 al 31", () => {
		expect(periodRange("2026-03")).toEqual({
			from: "2026-03-01",
			to: "2026-03-31",
		});
	});

	test("febrero bisiesto llega al 29", () => {
		expect(periodRange("2028-02").to).toBe("2028-02-29");
	});

	test("febrero normal, al 28", () => {
		expect(periodRange("2026-02").to).toBe("2026-02-28");
	});

	test("diciembre no se pasa al año siguiente", () => {
		expect(periodRange("2026-12")).toEqual({
			from: "2026-12-01",
			to: "2026-12-31",
		});
	});
});

describe("§7 — la matriz se construye una sola vez", () => {
	const sample = report([row(["P", "T", "D"])]);

	test("la cabecera lleva identidad, un día por columna y las seis del resumen", () => {
		const grid = buildReportGrid(sample);
		const header = grid.rows[0]?.map((cell) => cell.value);

		expect(header).toEqual([
			"Empleado",
			"Correo",
			"Departamento",
			1,
			2,
			3,
			"Presente",
			"Descanso",
			"Tardanza",
			"A. Justificada",
			"A. Injustificada",
			"Vacaciones",
		]);
		expect(grid.rows[0]?.every((cell) => cell.header)).toBe(true);
	});

	test("cada fila lleva un código por día y su resumen", () => {
		const grid = buildReportGrid(sample);
		expect(grid.rows[1]?.map((cell) => cell.value)).toEqual([
			"Ana Pérez",
			"ana@elineas.test",
			"Almacén",
			"P",
			"T",
			"D",
			1,
			1,
			1,
			0,
			0,
			0,
		]);
	});

	/**
	 * **El criterio de aceptación de la §9.** El XLSX se escribe de verdad, se
	 * vuelve a leer y se compara celda a celda con la matriz de valores que
	 * consume la API de Google Sheets. Si alguien añadiera una columna a uno de
	 * los dos caminos, esta prueba lo vería — que es exactamente lo que faltaba
	 * en el legacy (punto 73).
	 */
	test("el XLSX y la matriz de Sheets coinciden celda a celda", async () => {
		const big = report([
			row(["P", "T", "D"]),
			row(["ANJ", "AJ", "V"]),
			row(["NL", "NL", "P"]),
		]);

		const expected = toValueMatrix(buildReportGrid(big));
		const workbook = await readXlsx(await reportToXlsx(big));
		const actual = workbook.sheets[0]?.rows ?? [];

		expect(actual.length).toBe(expected.length);
		for (const [index, expectedRow] of expected.entries()) {
			expect(actual[index]).toEqual(expectedRow);
		}
	});

	test("el nombre de la hoja lleva el periodo", async () => {
		const workbook = await readXlsx(await reportToXlsx(sample));
		expect(workbook.sheets[0]?.name).toBe("Asistencia 2026-03");
	});
});

describe("§6 — el p95", () => {
	test("de una muestra ordenada o no, da el mismo valor", () => {
		const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
		expect(p95(values)).toBe(1000);
		expect(p95([...values].reverse())).toBe(1000);
	});

	test("con un solo valor, es ese valor", () => {
		expect(p95([42])).toBe(42);
	});

	test("sin muestra, es nulo y no cero", () => {
		// Cero diría "todas las corridas tardaron nada", que es falso: no hubo.
		expect(p95([])).toBeNull();
	});

	test("es un valor que existió, no una interpolación", () => {
		const values = [
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
		];
		expect(values).toContain(p95(values) as number);
	});
});
