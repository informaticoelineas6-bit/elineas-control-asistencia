import type { DashboardTrend } from "@elineas/validations";
import { useId, useState } from "react";
import { formatShortDate } from "#/lib/dates.ts";

/**
 * Tendencia de asistencia de los últimos días (spec 15 §5.1).
 *
 * **Qué se dibuja y por qué.** La spec pide "serie de presencia/ausencia", y eso
 * es lo que hay: tres estados por día —presente, tarde, ausente— apilados en una
 * barra. Los otros tres del vocabulario de la §2 (descanso, no laborable,
 * vacaciones) **no entran en la barra**: son días en los que no se esperaba a
 * nadie, y apilarlos taparía justo la señal que se viene a mirar. Van en el pie
 * del día, como contexto.
 *
 * **Los colores están validados, no elegidos a ojo.** Son los tonos de estado
 * que el calendario de asistencia ya usa —verde, ámbar, rojo— pero un escalón
 * más oscuros, porque los originales no pasaban la banda de luminosidad en modo
 * oscuro. Esta terna pasa las cinco comprobaciones (banda de luminosidad, croma
 * mínimo, separación bajo daltonismo, separación con visión normal y contraste
 * contra la superficie) **en claro y en oscuro con los mismos valores**, así que
 * no hace falta una paleta por modo.
 *
 *   emerald-700 #047857 · amber-600 #d97706 · rose-600 #e11d48
 *
 * El par ámbar↔rojo es el más justo bajo deuteranopía (ΔE 9.4), por encima del
 * umbral pero no de sobra: por eso el color **nunca va solo**. Hay leyenda, hay
 * tabla equivalente para lectores de pantalla y el detalle sale al pasar por
 * encima. Es además lo que exige tratar estos colores como estado y no como
 * identidad.
 */

const SERIES = [
	{ key: "PRESENTE", label: "Presente", color: "#047857" },
	{ key: "TARDE", label: "Tarde", color: "#d97706" },
	{ key: "AUSENTE", label: "Ausente", color: "#e11d48" },
] as const;

/** Alto del área de barras, en unidades del `viewBox`. */
const PLOT = 120;
/** Hueco de superficie entre segmentos apilados: 2px, no un borde. */
const GAP = 2;

export function AttendanceTrend({ trend }: { trend: DashboardTrend }) {
	const tableId = useId();
	const [hovered, setHovered] = useState<string | null>(null);

	const days = trend.days;
	if (days.length === 0) return null;

	// Una sola escala para todos los días: el máximo de personas esperadas en
	// cualquiera de ellos. Con una escala por barra, dos días distintos se verían
	// iguales.
	const expected = days.map(
		(day) => day.counts.PRESENTE + day.counts.TARDE + day.counts.AUSENTE,
	);
	const max = Math.max(1, ...expected);

	const active = days.find((day) => day.date === hovered);

	return (
		<figure className="m-0 space-y-3">
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 className="font-medium">Tendencia de asistencia</h2>
				<p className="text-sm text-muted-foreground">
					Últimos {days.length} días, sobre quien se esperaba cada día.
				</p>
			</figcaption>

			{/* Leyenda: con tres series siempre está, y es lo que impide que la
			    identidad dependa sólo del color. */}
			<ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
				{SERIES.map((series) => (
					<li key={series.key} className="flex items-center gap-1.5">
						<span
							aria-hidden
							className="size-2.5 rounded-[2px]"
							style={{ backgroundColor: series.color }}
						/>
						<span className="text-muted-foreground">{series.label}</span>
					</li>
				))}
			</ul>

			<div className="relative">
				<div className="flex items-end gap-1.5">
					{days.map((day, index) => {
						const total = expected[index] ?? 0;
						const isActive = hovered === day.date;

						return (
							<button
								key={day.date}
								type="button"
								className="group flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-md px-0.5 py-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								onMouseEnter={() => setHovered(day.date)}
								onMouseLeave={() => setHovered(null)}
								onFocus={() => setHovered(day.date)}
								onBlur={() => setHovered(null)}
								aria-describedby={tableId}
							>
								<svg
									viewBox={`0 0 24 ${PLOT}`}
									className="h-32 w-full"
									preserveAspectRatio="none"
									role="presentation"
								>
									<title>{`${day.date}: ${total} esperados`}</title>
									{/* Base: una hairline sólida, un tono por encima de la
									    superficie. Nada de líneas discontinuas. */}
									<line
										x1="0"
										y1={PLOT - 0.5}
										x2="24"
										y2={PLOT - 0.5}
										stroke="currentColor"
										strokeWidth="1"
										className="text-border"
									/>
									{(() => {
										let cursor = PLOT;
										return SERIES.map((series, seriesIndex) => {
											const value = day.counts[series.key];
											if (value === 0) return null;

											const height = (value / max) * (PLOT - 4);
											const y = cursor - height;
											cursor = y - GAP;
											// Extremo redondeado sólo arriba del todo: la barra
											// nace de la línea base y termina en el dato.
											const top = seriesIndex === 0 || cursor <= 0;

											return (
												<rect
													key={series.key}
													x="4"
													y={y}
													width="16"
													height={Math.max(height, 1)}
													rx={top ? 3 : 0}
													fill={series.color}
													opacity={isActive || !hovered ? 1 : 0.45}
												/>
											);
										}).reverse();
									})()}
								</svg>
								<span className="w-full truncate text-center text-[11px] text-muted-foreground tabular-nums">
									{day.date.slice(8)}
								</span>
							</button>
						);
					})}
				</div>

				{/* La capa de detalle: aparece al pasar por encima o al tabular, y es
				    lo que evita tener que poner un número en cada segmento. */}
				{active && (
					<div className="mt-2 rounded-md border bg-card p-3 text-sm">
						<p className="font-medium">{formatShortDate(active.date)}</p>
						<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
							{SERIES.map((series) => (
								<div key={series.key} className="flex items-center gap-1.5">
									<span
										aria-hidden
										className="size-2 rounded-[2px]"
										style={{ backgroundColor: series.color }}
									/>
									<dt className="text-muted-foreground">{series.label}:</dt>
									<dd className="tabular-nums">{active.counts[series.key]}</dd>
								</div>
							))}
							<div className="flex items-center gap-1.5">
								<dt className="text-muted-foreground">No se esperaban:</dt>
								<dd className="tabular-nums">
									{active.counts.DESCANSO +
										active.counts.NO_LABORABLE +
										active.counts.VACACIONES}
								</dd>
							</div>
						</dl>
					</div>
				)}
			</div>

			{/* La misma serie como tabla, para lectores de pantalla: el color no es
			    la única vía a los datos. */}
			<table id={tableId} className="sr-only">
				<caption>Tendencia de asistencia por día</caption>
				<thead>
					<tr>
						<th>Día</th>
						{SERIES.map((series) => (
							<th key={series.key}>{series.label}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{days.map((day) => (
						<tr key={day.date}>
							<th scope="row">{formatShortDate(day.date)}</th>
							{SERIES.map((series) => (
								<td key={series.key}>{day.counts[series.key]}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}
