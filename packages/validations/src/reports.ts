import { z } from "zod";
import type { AbsenceOverlay } from "./absences.ts";
import type { attendanceDayStatusSchema } from "./attendance.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Reportería mensual (spec 16).
 *
 * **Este archivo es la respuesta a la deuda crítica de la §7** (punto 73 del
 * legacy): allí la exportación a Google Sheets *reimplementaba a mano* la misma
 * matriz que la exportación XLSX, porque la función remota no podía importar el
 * código compartido. No había contrato común ni prueba que detectara una
 * desincronización, así que cambiar una columna en un lado dejaba el otro
 * silenciosamente mal.
 *
 * Aquí la matriz se construye **una vez** —`buildReportGrid`— y cada formato
 * serializa esa misma estructura. La spec lo marca como *requisito de
 * aceptación, no sugerencia*, y hay una prueba que compara las dos salidas
 * celda a celda.
 *
 * Vive en `@elineas/validations` y no en el backend a propósito: es el paquete
 * que ya comparten servidor e interfaz, y así la pantalla de reportes puede
 * pintar la misma tabla que se descarga sin recomponerla.
 */

// ── §2 Los códigos de la matriz ───────────────────────────────────────────────

/**
 * Los siete códigos de la §2.
 *
 * **Decisión 1 de la §11, cerrada con lo que se pudo comprobar.** La spec pedía
 * confirmarlos contra el legacy "para no romper la continuidad de los reportes
 * históricos"; el código del legacy no está en este repositorio y `old-docs.md`
 * sólo documenta dos cosas — que `AJ`/`ANJ` son los de ausencia justificada e
 * injustificada (punto 54) y los nombres de las seis columnas del resumen—, y
 * las dos coinciden con esta tabla. El resto se toma tal como la spec los
 * escribe.
 *
 * El riesgo de continuidad es además menor de lo que la pregunta sugiere: los
 * reportes se **regeneran** desde la agregación diaria, no se leen de archivos
 * viejos, así que un cambio de código no corrompe nada — sólo obliga a mirar
 * dos veces un XLSX archivado.
 */
export const dayCodeSchema = z.enum(["P", "T", "D", "NL", "V", "AJ", "ANJ"]);

export const DAY_CODE_LABELS: Record<DayCode, string> = {
	P: "Presente",
	T: "Tarde",
	D: "Descanso",
	NL: "No laborable",
	V: "Vacaciones",
	AJ: "Ausencia justificada",
	ANJ: "Ausencia injustificada",
};

/**
 * **La única traducción** del vocabulario de la spec 15 a los códigos de ésta.
 *
 * Que sea una función y no una tabla es por `AUSENTE`: su código depende de la
 * superposición de la spec 13, y un día ausente **sin revisar es `ANJ`**
 * (RN-13.10) — el reporte no esconde una ausencia que nadie explicó, aunque no
 * genere descuento.
 */
export function dayCodeOf(
	status: AttendanceDayStatus,
	absence: AbsenceOverlay | null,
): DayCode {
	switch (status) {
		case "PRESENTE":
			return "P";
		case "TARDE":
			return "T";
		case "DESCANSO":
			return "D";
		case "NO_LABORABLE":
			return "NL";
		case "VACACIONES":
			return "V";
		case "AUSENTE":
			return absence?.code ?? "ANJ";
	}
}

/**
 * El resumen de seis columnas de la §2, con los nombres que documenta el legacy
 * (punto 54).
 *
 * `noLaborable` **no es una de las seis** y sin embargo está: sin él, RN-16.1
 * —"la suma de las columnas = días del mes"— sería imposible de cumplir en
 * cuanto el mes tuviera un feriado. Es la séptima cifra que la spec necesitaba
 * y no nombró; se devuelve aparte para que las seis del entregable sigan siendo
 * las seis.
 */
export const monthlySummarySchema = z.object({
	presente: z.number().int().nonnegative(),
	descanso: z.number().int().nonnegative(),
	tardanza: z.number().int().nonnegative(),
	ausenciaJustificada: z.number().int().nonnegative(),
	ausenciaInjustificada: z.number().int().nonnegative(),
	vacaciones: z.number().int().nonnegative(),
	noLaborable: z.number().int().nonnegative(),
});

const EMPTY_SUMMARY: MonthlySummary = {
	presente: 0,
	descanso: 0,
	tardanza: 0,
	ausenciaJustificada: 0,
	ausenciaInjustificada: 0,
	vacaciones: 0,
	noLaborable: 0,
};

/** RN-16.1 — Un código por día, y cada día cae en exactamente una casilla. */
export function summarizeCodes(codes: readonly DayCode[]): MonthlySummary {
	const summary = { ...EMPTY_SUMMARY };
	for (const code of codes) {
		switch (code) {
			case "P":
				summary.presente += 1;
				break;
			case "T":
				summary.tardanza += 1;
				break;
			case "D":
				summary.descanso += 1;
				break;
			case "NL":
				summary.noLaborable += 1;
				break;
			case "V":
				summary.vacaciones += 1;
				break;
			case "AJ":
				summary.ausenciaJustificada += 1;
				break;
			case "ANJ":
				summary.ausenciaInjustificada += 1;
				break;
		}
	}
	return summary;
}

/** RN-16.1 — El total del resumen. Debe ser igual a los días del periodo. */
export const summaryTotal = (summary: MonthlySummary): number =>
	summary.presente +
	summary.descanso +
	summary.tardanza +
	summary.ausenciaJustificada +
	summary.ausenciaInjustificada +
	summary.vacaciones +
	summary.noLaborable;

// ── El reporte, ya resuelto ───────────────────────────────────────────────────

/** `2026-03`. Un mes natural (decisión 3 de la §11). */
export const reportPeriodSchema = z
	.string()
	.regex(/^\d{4}-(0[1-9]|1[0-2])$/, "El periodo tiene el formato 2026-03.");

export const reportScopeSchema = z.enum(["global", "department"]);

export const reportRowSchema = z.object({
	userId: z.uuid(),
	userFullName: z.string(),
	userEmail: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	/** Un código por día del periodo, en el orden de `days`. */
	codes: z.array(dayCodeSchema),
	summary: monthlySummarySchema,
});

export const monthlyReportSchema = z.object({
	period: reportPeriodSchema,
	scope: reportScopeSchema,
	departmentId: z.uuid().nullable(),
	/** Los días del periodo, `yyyy-MM-dd`, en orden. */
	days: z.array(isoDateSchema),
	rows: z.array(reportRowSchema),
	/** Con qué versión de reglas se calculó (§5, RN-16.12). */
	ruleVersion: z.number().int().positive(),
	generatedAt: z.iso.datetime(),
});

export const monthlyReportQuerySchema = z.object({
	period: reportPeriodSchema,
	departmentId: z.uuid().optional(),
});

// ── §7 La matriz, construida una sola vez ─────────────────────────────────────

/**
 * Una celda de la cuadrícula. `header` marca las que van en negrita al
 * serializar; el valor es lo único que se compara entre formatos.
 */
export type ReportCell = { value: string | number; header?: boolean };

export type ReportGrid = {
	sheetName: string;
	rows: ReportCell[][];
};

/**
 * **La cuadrícula del reporte, construida una vez.** XLSX y Google Sheets
 * serializan *esto*; ninguno de los dos vuelve a decidir qué columnas hay ni en
 * qué orden.
 *
 * Encabezado: identidad de la persona, un día por columna, y las seis del
 * resumen. Los días se rotulan con su número, no con la fecha entera: una
 * columna por día con `2026-03-17` dentro es ilegible y el mes ya está en el
 * nombre de la hoja.
 */
export function buildReportGrid(report: MonthlyReport): ReportGrid {
	const header: ReportCell[] = [
		{ value: "Empleado", header: true },
		{ value: "Correo", header: true },
		{ value: "Departamento", header: true },
		...report.days.map((date) => ({
			value: Number(date.slice(8)),
			header: true,
		})),
		{ value: "Presente", header: true },
		{ value: "Descanso", header: true },
		{ value: "Tardanza", header: true },
		{ value: "A. Justificada", header: true },
		{ value: "A. Injustificada", header: true },
		{ value: "Vacaciones", header: true },
	];

	const rows = report.rows.map((row): ReportCell[] => [
		{ value: row.userFullName },
		{ value: row.userEmail },
		{ value: row.departmentName ?? "" },
		...row.codes.map((code) => ({ value: code })),
		{ value: row.summary.presente },
		{ value: row.summary.descanso },
		{ value: row.summary.tardanza },
		{ value: row.summary.ausenciaJustificada },
		{ value: row.summary.ausenciaInjustificada },
		{ value: row.summary.vacaciones },
	]);

	return { sheetName: `Asistencia ${report.period}`, rows: [header, ...rows] };
}

/**
 * La cuadrícula como matriz de valores planos: es lo que espera la API de
 * Google Sheets (`values.update`) y lo que la prueba de la §9 compara contra el
 * XLSX ya escrito y vuelto a leer.
 *
 * Es deliberadamente trivial. Toda la decisión —qué columnas, en qué orden, con
 * qué códigos— está en `buildReportGrid`; esto sólo quita el envoltorio.
 */
export const toValueMatrix = (grid: ReportGrid): (string | number)[][] =>
	grid.rows.map((row) => row.map((cell) => cell.value));

// ── §3 Corridas ───────────────────────────────────────────────────────────────

export const reportRunStatusSchema = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
]);

export const reportRunSchema = z.object({
	id: z.uuid(),
	scope: reportScopeSchema,
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	periodStart: isoDateSchema,
	periodEnd: isoDateSchema,
	status: reportRunStatusSchema,
	requestedBy: z.uuid(),
	rowCount: z.number().int().nonnegative().nullable(),
	durationMs: z.number().int().nonnegative().nullable(),
	errorMessage: z.string().nullable(),
	retryCount: z.number().int().nonnegative(),
	ruleVersion: z.number().int().positive(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * `POST /reports/runs`.
 *
 * **No lleva `scope`**: se deduce de si viene `departmentId`. Un cuerpo con
 * `scope: "global"` y un `departmentId` a la vez es contradictorio, y admitirlo
 * obliga a decidir cuál gana; sin el campo, la pregunta no existe.
 */
export const createReportRunInputSchema = z.object({
	period: reportPeriodSchema,
	departmentId: z.uuid().optional(),
});

export const listReportRunsQuerySchema = z.object({
	status: reportRunStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** RN-16.5 — El enlace es temporal, y el token no es adivinable. */
export const reportDownloadSchema = z.object({
	url: z.string(),
	expiresAt: z.iso.datetime(),
	filename: z.string(),
});

/** RN-16.9 — Recálculo por rango, invocable a mano. */
export const refreshFactsInputSchema = z
	.object({ from: isoDateSchema, to: isoDateSchema })
	.refine(({ from, to }) => from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	})
	.refine(
		({ from, to }) =>
			(Date.parse(`${to}T00:00:00.000Z`) -
				Date.parse(`${from}T00:00:00.000Z`)) /
				86_400_000 <=
			366,
		{ message: "El rango no puede pasar de un año." },
	);

export const refreshFactsResultSchema = z.object({
	from: isoDateSchema,
	to: isoDateSchema,
	/** Hechos escritos o reescritos. */
	facts: z.number().int().nonnegative(),
	ruleVersion: z.number().int().positive(),
});

// ── §6 Observabilidad ─────────────────────────────────────────────────────────

/**
 * KPIs de la reportería contra sus SLOs (spec 06 §3.7).
 *
 * ⚠️ **Hallazgo H-1 de la §6:** en el legacy, la función de KPIs llamaba a la
 * comprobación de ámbito **con los argumentos invertidos**. Fallaba cerrado —no
 * filtraba datos ajenos— pero un jefe nunca veía los KPIs de su departamento.
 * Aquí no puede repetirse: el ámbito lo aplica `requireRole`/`canManage`, la
 * misma comprobación tipada que todo lo demás, y estos KPIs son de la
 * reportería entera y sólo los ve un gestor global.
 */
export const reportKpisSchema = z.object({
	windowDays: z.number().int().positive(),
	total: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	errorRatePct: z.number(),
	availabilityPct: z.number(),
	/** Nulo si no hay ninguna corrida completada en la ventana. */
	p95DurationMs: z.number().int().nonnegative().nullable(),
	slo: z.object({
		errorRatePct: z.number(),
		availabilityPct: z.number(),
	}),
	meetsSlo: z.boolean(),
});

export const reportKpisQuerySchema = z.object({
	windowDays: z.coerce.number().int().min(1).max(365).default(30),
});

/** p95 sobre una muestra ya ordenada o no: se ordena aquí. */
export function p95(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	// Índice del percentil 95 por el método del "nearest rank", que es el que no
	// necesita interpolar y da un valor que existió de verdad.
	const index = Math.ceil(0.95 * sorted.length) - 1;
	return sorted[Math.min(index, sorted.length - 1)] ?? null;
}

type AttendanceDayStatus = z.infer<typeof attendanceDayStatusSchema>;

export type DayCode = z.infer<typeof dayCodeSchema>;
export type MonthlySummary = z.infer<typeof monthlySummarySchema>;
export type ReportScope = z.infer<typeof reportScopeSchema>;
export type ReportRow = z.infer<typeof reportRowSchema>;
export type MonthlyReport = z.infer<typeof monthlyReportSchema>;
export type MonthlyReportQuery = z.infer<typeof monthlyReportQuerySchema>;
export type ReportRunStatus = z.infer<typeof reportRunStatusSchema>;
export type ReportRun = z.infer<typeof reportRunSchema>;
export type CreateReportRunInput = z.infer<typeof createReportRunInputSchema>;
export type ListReportRunsQuery = z.infer<typeof listReportRunsQuerySchema>;
export type ReportDownload = z.infer<typeof reportDownloadSchema>;
export type RefreshFactsInput = z.infer<typeof refreshFactsInputSchema>;
export type RefreshFactsResult = z.infer<typeof refreshFactsResultSchema>;
export type ReportKpis = z.infer<typeof reportKpisSchema>;
export type ReportKpisQuery = z.infer<typeof reportKpisQuerySchema>;
