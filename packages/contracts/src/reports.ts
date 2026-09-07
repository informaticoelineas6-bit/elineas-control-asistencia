import {
	createReportRunInputSchema,
	listReportRunsQuerySchema,
	monthlyReportQuerySchema,
	monthlyReportSchema,
	refreshFactsInputSchema,
	refreshFactsResultSchema,
	reportDownloadSchema,
	reportKpisQuerySchema,
	reportKpisSchema,
	reportRunSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de reportería mensual (spec 16 §8).
 *
 * **Ámbito.** `monthly`, `runs`, `enqueue`, `download` y `retry` exigen al
 * menos `department_head` y se acotan a su ámbito: un jefe encola y descarga
 * reportes **de su departamento**, y el reporte global es lo mismo para quien
 * gestiona la empresa entera — el `scope` de una corrida no lo elige el
 * cliente, sale de si mandó `departmentId` y de lo que su rol alcanza. `kpis` y
 * `refreshFacts` son de `global_manager`.
 *
 * ⚠️ **`POST /reports/export-to-sheet` de la §8 no está.** Es la decisión 2 de
 * la §11 —"¿se mantiene la integración con Google Sheets, o basta el XLSX?"— y
 * es una decisión de negocio con una restricción de infraestructura detrás. Lo
 * que sí está construido es lo que la §7 marca como **requisito de aceptación**:
 * la matriz se arma una sola vez (`buildReportGrid`) y hay dos serializadores
 * sobre ella, el XLSX y el de matriz de valores que la API de Sheets consume
 * tal cual, con una prueba que los compara celda a celda. Lo que falta es el
 * transporte, no la forma.
 */
export const reportsSpec = {
	/** Los datos en JSON, para pintar la misma tabla que se descarga. */
	monthly: {
		method: "GET",
		path: "/api/reports/monthly",
		query: monthlyReportQuerySchema,
		response: monthlyReportSchema,
	},
	runs: {
		method: "GET",
		path: "/api/reports/runs",
		query: listReportRunsQuerySchema,
		response: z.array(reportRunSchema),
	},
	enqueue: {
		method: "POST",
		path: "/api/reports/runs",
		body: createReportRunInputSchema,
		response: reportRunSchema,
	},
	/**
	 * RN-16.5 — Devuelve un **enlace firmado y temporal**, no el archivo: así la
	 * descarga no pasa por el mismo camino que la autorización y el enlace puede
	 * caducar por su cuenta.
	 */
	download: {
		method: "GET",
		path: "/api/reports/runs/:id/download",
		response: reportDownloadSchema,
	},
	/** RN-16.4 — Crea una fila nueva; la anterior se conserva. */
	retry: {
		method: "POST",
		path: "/api/reports/runs/:id/retry",
		response: reportRunSchema,
	},
	kpis: {
		method: "GET",
		path: "/api/reports/kpis",
		query: reportKpisQuerySchema,
		response: reportKpisSchema,
	},
	/** RN-16.9 — Recálculo por rango de los hechos diarios. */
	refreshFacts: {
		method: "POST",
		path: "/api/attendance/facts/refresh",
		body: refreshFactsInputSchema,
		response: refreshFactsResultSchema,
	},
} as const;
