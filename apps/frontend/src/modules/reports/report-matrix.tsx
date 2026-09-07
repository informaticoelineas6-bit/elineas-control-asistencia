import type { MonthlyReport } from "@elineas/validations";
import { buildReportGrid, DAY_CODE_LABELS } from "@elineas/validations";

/**
 * La matriz empleado × día (spec 16 §2), en pantalla.
 *
 * **Se pinta desde `buildReportGrid`, el mismo módulo del que sale el XLSX.**
 * No es purismo: es la misma razón por la que la §7 exige un solo constructor —
 * si la pantalla armara su propia tabla, sería una tercera implementación de la
 * matriz, y la primera en desincronizarse sería la que la gente mira antes de
 * descargar.
 *
 * Los códigos van con color de estado **y** con su significado en el `title`,
 * porque un tono no dice qué es `NL`. La leyenda de arriba los nombra todos: son
 * siete, y siete clases de color son ya demasiadas para distinguir sólo por
 * tono.
 */

const CODE_TONE: Record<string, string> = {
	P: "text-emerald-700 dark:text-emerald-400",
	T: "text-amber-700 dark:text-amber-400",
	D: "text-muted-foreground",
	NL: "text-muted-foreground/60",
	V: "text-sky-700 dark:text-sky-400",
	AJ: "text-sky-700 dark:text-sky-400",
	ANJ: "text-rose-700 dark:text-rose-400 font-semibold",
};

export function ReportMatrix({ report }: { report: MonthlyReport }) {
	const grid = buildReportGrid(report);
	const [header, ...rows] = grid.rows;

	if (!header) return null;

	// Claves estables por columna: las tres de identidad, una por día del mes y
	// las seis del resumen. Usar el índice sería correcto aquí —la cuadrícula no
	// se reordena— pero esto no depende de que siga siéndolo.
	const columnKeys = [
		"empleado",
		"correo",
		"departamento",
		...report.days,
		"sum-presente",
		"sum-descanso",
		"sum-tardanza",
		"sum-aj",
		"sum-anj",
		"sum-vacaciones",
	];

	return (
		<div className="space-y-3">
			<ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
				{Object.entries(DAY_CODE_LABELS).map(([code, label]) => (
					<li key={code} className="flex items-center gap-1.5">
						<span className={`font-mono ${CODE_TONE[code] ?? ""}`}>{code}</span>
						<span className="text-muted-foreground">{label}</span>
					</li>
				))}
			</ul>

			{/* Una matriz de treinta y tantas columnas no cabe: se desplaza dentro de
			    su caja, no arrastra la página entera. */}
			<div className="overflow-x-auto rounded-xl border">
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr className="border-b bg-muted/40">
							{header.map((cell, index) => (
								<th
									key={columnKeys[index] ?? String(cell.value)}
									scope="col"
									className={`px-2 py-2 text-xs font-medium whitespace-nowrap ${
										index < 3 ? "text-left" : "text-center"
									}`}
								>
									{cell.value}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr
								key={report.rows[rowIndex]?.userId ?? rowIndex}
								className="border-b last:border-0"
							>
								{row.map((cell, index) => {
									const isCode = index >= 3 && index < 3 + report.days.length;
									const code = String(cell.value);

									return (
										<td
											key={columnKeys[index] ?? code}
											className={`px-2 py-1.5 whitespace-nowrap ${
												index < 3 ? "text-left" : "text-center tabular-nums"
											} ${isCode ? `font-mono text-xs ${CODE_TONE[code] ?? ""}` : ""}`}
											title={
												isCode
													? `${report.days[index - 3]}: ${DAY_CODE_LABELS[code as keyof typeof DAY_CODE_LABELS] ?? code}`
													: undefined
											}
										>
											{cell.value}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
