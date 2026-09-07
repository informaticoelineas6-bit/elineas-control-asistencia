import {
	buildReportGrid,
	type MonthlyReport,
	type ReportGrid,
	toValueMatrix,
} from "@elineas/validations";
import { writeXlsx } from "hucre/xlsx";

/**
 * Serialización a XLSX de una cuadrícula ya construida, con **hucre**.
 *
 * Lo importante de este archivo es lo que **no** hace: no decide ni una columna.
 * Las cuadrículas se arman en `@elineas/validations` —`buildReportGrid` para la
 * matriz mensual de la spec 16, `buildPayrollGrid` para los ajustes de la 17— y
 * aquí sólo se envuelven en un libro. Esa es la respuesta a la deuda crítica del
 * punto 73, donde la exportación a Sheets reimplementaba la misma matriz a mano
 * y nada detectaba que las dos se hubieran separado.
 *
 * `hucre` en vez de las alternativas habituales por tres razones concretas de
 * este proyecto: **cero dependencias** (SheetJS ya no se publica en npm y
 * ExcelJS arrastra nueve), **ESM nativo y TypeScript de origen**, que es como
 * está escrito todo lo demás aquí, y que su formato de escritura por filas —una
 * matriz de celdas con estilo opcional— es exactamente la forma que ya tiene
 * `ReportGrid`, así que la traducción es de una línea.
 */
export async function gridToXlsx(
	grid: ReportGrid,
	/**
	 * Cuántas filas y columnas quedan fijas al desplazarse. Una matriz de 31
	 * columnas se lee desplazándose, y sin esto se pierde de vista de quién es la
	 * fila.
	 */
	freezePane: { rows: number; columns: number },
): Promise<Uint8Array> {
	return writeXlsx({
		sheets: [
			{
				name: grid.sheetName,
				rows: grid.rows.map((row) =>
					row.map((cell) =>
						cell.header
							? { value: cell.value, style: { font: { bold: true } } }
							: cell.value,
					),
				),
				freezePane,
			},
		],
	});
}

/** El reporte mensual de la spec 16 (§7.1): identidad + un día por columna. */
export const reportToXlsx = (report: MonthlyReport): Promise<Uint8Array> =>
	gridToXlsx(buildReportGrid(report), { rows: 1, columns: 3 });

/**
 * La misma cuadrícula como matriz de valores planos: es lo que la API de Google
 * Sheets (`spreadsheets.values.update`) consume tal cual.
 *
 * **El transporte a Sheets no está** (decisión 2 de la §11, abierta), pero esto
 * sí, y no por adelantar trabajo: es la mitad del requisito de aceptación de la
 * §7 — hay una prueba que escribe el XLSX, lo vuelve a leer y lo compara con
 * esta matriz **celda a celda**. Es la comprobación que el legacy no tenía y por
 * la que sus dos exportaciones podían separarse en silencio.
 */
export const reportToValueMatrix = (report: MonthlyReport) =>
	toValueMatrix(buildReportGrid(report));
