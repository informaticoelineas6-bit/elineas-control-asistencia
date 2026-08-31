import {
	addDays,
	addMonths,
	eachDayOfInterval,
	endOfMonth,
	endOfWeek,
	format,
	getISOWeek,
	getMonth,
	getYear,
	isAfter,
	isBefore,
	isSameDay,
	isSameMonth,
	isToday,
	setMonth,
	setYear,
	startOfDay,
	startOfMonth,
	startOfWeek,
} from "date-fns";
import {
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	capitalize,
	ES_LOCALE,
	formatLongDate,
	formatMonthCaption,
	toISODate,
	WEEK_STARTS_ON,
} from "#/lib/dates.ts";
import { cn } from "#/lib/utils.ts";

/**
 * Calendario de la aplicación, construido sobre date-fns.
 *
 * Es el único calendario del proyecto: lo usan la configuración del calendario
 * laboral (spec 07 §6), la vista del horario propio y —cuando lleguen— el marcaje,
 * las vacaciones y los descansos. Vive en `components/ui` y no en un módulo porque
 * no sabe nada del dominio: no entiende qué significa un día marcado, sólo cómo
 * pintarlo.
 *
 * Lo que tiene que resolver, y por eso no es un `<input type="date">`:
 *
 * - **Tres formas de seleccionar**: un día, varios sueltos o un rango — este
 *   último con previsualización mientras se mueve el ratón.
 * - **Sitio para ver qué hay en cada día.** Una celda no es sólo un número:
 *   admite un tono de fondo, una etiqueta, un detalle y puntos de color. Sin ese
 *   espacio, un calendario laboral obliga a pinchar cada día para saber qué tiene.
 * - **Selección por lotes**: pulsar la cabecera de un día de la semana coge todos
 *   los de ese día del mes —todos los domingos, por ejemplo— y pulsar el número de
 *   semana coge la semana entera. Marcar 52 domingos a mano es lo que hace que
 *   nadie mantenga el calendario al día.
 * - **Teclado**: flechas para moverse, `Inicio`/`Fin` para los extremos de la
 *   semana, `PageUp`/`PageDown` para cambiar de mes, `Enter` para seleccionar. Una
 *   sola celda entra en el orden de tabulación (patrón de *tabindex* viajero), no
 *   las cuarenta y dos.
 *
 * Las fechas entran y salen como `Date` en hora **local**: el dominio habla
 * `yyyy-MM-dd` (spec 07 §2) y la conversión vive en `#/lib/dates.ts`.
 */

export type CalendarTone =
	| "neutral"
	| "positive"
	| "warning"
	| "danger"
	| "info";

export type CalendarDayMark = {
	/** Pinta el fondo de la celda. */
	tone?: CalendarTone;
	/** Línea corta bajo el número: "No laborable", "Feriado". */
	label?: string;
	/** Segunda línea, más apagada: "tolerancia 30 min". Sólo en tamaño `lg`. */
	detail?: string;
	/** Señales acumulables cuando no cabe texto. Se deduplican por tono. */
	dots?: readonly CalendarTone[];
	/** Lo que lee un lector de pantalla y lo que sale al pasar el ratón. */
	description?: string;
};

export type DateRange = { from: Date | null; to: Date | null };

export type CalendarMarks =
	| ReadonlyMap<string, CalendarDayMark>
	| ((date: Date) => CalendarDayMark | null | undefined);

type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type CalendarBaseProps = {
	/** Mes visible controlado. Sin él, el componente lo lleva por su cuenta. */
	month?: Date;
	defaultMonth?: Date;
	onMonthChange?: (month: Date) => void;
	/** Cuántos meses se pintan seguidos. Útil para elegir un rango largo. */
	numberOfMonths?: number;
	weekStartsOn?: WeekStart;
	/** Límites navegables y seleccionables. */
	fromDate?: Date;
	toDate?: Date;
	disabled?: (date: Date) => boolean;
	marks?: CalendarMarks;
	showOutsideDays?: boolean;
	showWeekNumbers?: boolean;
	/** `sm` sólo el número; `md` deja una línea de etiqueta; `lg`, dos. */
	size?: "sm" | "md" | "lg";
	captionLayout?: "buttons" | "dropdowns";
	/** Años arriba y abajo del actual que ofrece el desplegable de año. */
	yearRange?: number;
	onWeekdayClick?: (weekday: number, dates: Date[]) => void;
	onWeekClick?: (dates: Date[], weekNumber: number) => void;
	legend?: readonly { tone: CalendarTone; label: string }[];
	footer?: ReactNode;
	/** Se ve, no se toca. Para mostrar un calendario a quien no lo edita. */
	readOnly?: boolean;
	className?: string;
	/** Nombre de la tabla del mes para lectores de pantalla. */
	label?: string;
};

type SingleProps = {
	mode?: "single";
	selected?: Date | null;
	onSelect?: (date: Date) => void;
};

type MultipleProps = {
	mode: "multiple";
	selected?: readonly Date[];
	/** Devuelve la selección completa y, aparte, el día que se acaba de tocar. */
	onSelect?: (dates: Date[], toggled: Date) => void;
};

type RangeProps = {
	mode: "range";
	selected?: DateRange | null;
	onSelect?: (range: DateRange) => void;
};

export type CalendarProps = CalendarBaseProps &
	(SingleProps | MultipleProps | RangeProps);

/**
 * Tonos. El neutro sale de los tokens del tema; los tres con significado usan
 * verde, ámbar y rojo directamente, que es lo que la gente lee sin leyenda — el
 * tema de la aplicación es violeta y no sirve para decir "no laborable".
 */
const TONE_CELL: Record<CalendarTone, string> = {
	neutral: "bg-muted/50 border-border",
	positive: "bg-emerald-500/10 border-emerald-500/40 dark:bg-emerald-500/15",
	warning: "bg-amber-500/10 border-amber-500/40 dark:bg-amber-500/15",
	danger: "bg-rose-500/10 border-rose-500/40 dark:bg-rose-500/15",
	info: "bg-sky-500/10 border-sky-500/40 dark:bg-sky-500/15",
};

const TONE_TEXT: Record<CalendarTone, string> = {
	neutral: "text-muted-foreground",
	positive: "text-emerald-700 dark:text-emerald-400",
	warning: "text-amber-700 dark:text-amber-400",
	danger: "text-rose-700 dark:text-rose-400",
	info: "text-sky-700 dark:text-sky-400",
};

const TONE_DOT: Record<CalendarTone, string> = {
	neutral: "bg-muted-foreground/60",
	positive: "bg-emerald-500",
	warning: "bg-amber-500",
	danger: "bg-rose-500",
	info: "bg-sky-500",
};

const SIZE_CELL: Record<NonNullable<CalendarBaseProps["size"]>, string> = {
	sm: "h-9 px-1 py-1",
	md: "h-14 px-1.5 py-1",
	lg: "h-20 px-2 py-1.5",
};

function resolveMark(
	marks: CalendarMarks | undefined,
	date: Date,
): CalendarDayMark | null {
	if (!marks) return null;
	if (typeof marks === "function") return marks(date) ?? null;
	return marks.get(toISODate(date)) ?? null;
}

/** Las semanas que se pintan de un mes, ya troceadas de siete en siete. */
function monthWeeks(month: Date, weekStartsOn: WeekStart): Date[][] {
	const start = startOfWeek(startOfMonth(month), { weekStartsOn });
	const end = endOfWeek(endOfMonth(month), { weekStartsOn });
	const days = eachDayOfInterval({ start, end });

	const weeks: Date[][] = [];
	for (let index = 0; index < days.length; index += 7) {
		weeks.push(days.slice(index, index + 7));
	}
	return weeks;
}

function weekdayNames(
	weekStartsOn: WeekStart,
): { key: number; label: string; longLabel: string }[] {
	const reference = startOfWeek(new Date(), { weekStartsOn });
	return Array.from({ length: 7 }, (_, index) => {
		const day = addDays(reference, index);
		return {
			key: day.getDay(),
			label: capitalize(format(day, "EEEEEE", { locale: ES_LOCALE })),
			longLabel: format(day, "EEEE", { locale: ES_LOCALE }),
		};
	});
}

const sameDayAs = (list: readonly Date[], date: Date) =>
	list.some((each) => isSameDay(each, date));

export function Calendar({
	month,
	defaultMonth,
	onMonthChange,
	numberOfMonths = 1,
	weekStartsOn = WEEK_STARTS_ON,
	fromDate,
	toDate,
	disabled,
	marks,
	showOutsideDays = true,
	showWeekNumbers = false,
	size = "md",
	captionLayout = "buttons",
	yearRange = 5,
	onWeekdayClick,
	onWeekClick,
	legend,
	footer,
	readOnly = false,
	className,
	label = "Calendario",
	...selection
}: CalendarProps) {
	const initialMonth =
		defaultMonth ??
		(selection.mode === "range"
			? selection.selected?.from
			: selection.mode === "multiple"
				? selection.selected?.at(0)
				: selection.selected) ??
		new Date();

	const [uncontrolledMonth, setUncontrolledMonth] = useState(() =>
		startOfMonth(initialMonth),
	);
	const visibleMonth = month ? startOfMonth(month) : uncontrolledMonth;

	const [focused, setFocused] = useState<Date | null>(null);
	const [hovered, setHovered] = useState<Date | null>(null);
	const gridRef = useRef<HTMLDivElement>(null);
	const shouldRestoreFocus = useRef(false);

	// El foco se mueve con las flechas, así que tras cada salto hay que llevarlo a
	// la celda nueva: sin esto la primera flecha funciona y la segunda se pierde,
	// porque el botón que tenía el foco ya no está donde estaba.
	useEffect(() => {
		if (!focused || !shouldRestoreFocus.current) return;
		shouldRestoreFocus.current = false;
		gridRef.current
			?.querySelector<HTMLButtonElement>(`[data-day="${toISODate(focused)}"]`)
			?.focus();
	}, [focused]);

	const goToMonth = (next: Date) => {
		const normalized = startOfMonth(next);
		if (!month) setUncontrolledMonth(normalized);
		onMonthChange?.(normalized);
	};

	const outOfBounds = (date: Date) =>
		(fromDate ? isBefore(startOfDay(date), startOfDay(fromDate)) : false) ||
		(toDate ? isAfter(startOfDay(date), startOfDay(toDate)) : false);

	const isDisabled = (date: Date) =>
		readOnly || outOfBounds(date) || (disabled?.(date) ?? false);

	const range = selection.mode === "range" ? selection.selected : null;

	/** Extremos y relleno del rango, contando la previsualización del ratón. */
	const rangeState = (date: Date): "start" | "end" | "middle" | null => {
		if (selection.mode !== "range" || !range?.from) return null;

		const from = range.from;
		const to = range.to ?? hovered ?? null;
		const [start, end] =
			to && isBefore(to, from) ? [to, from] : [from, to ?? from];

		if (isSameDay(date, start)) return "start";
		if (isSameDay(date, end)) return "end";
		if (isAfter(date, start) && isBefore(date, end)) return "middle";
		return null;
	};

	const isSelected = (date: Date): boolean => {
		if (selection.mode === "multiple") {
			return sameDayAs(selection.selected ?? [], date);
		}
		if (selection.mode === "range") return rangeState(date) !== null;
		return selection.selected ? isSameDay(selection.selected, date) : false;
	};

	const select = (date: Date) => {
		if (isDisabled(date)) return;

		if (selection.mode === "multiple") {
			const current = selection.selected ?? [];
			const next = sameDayAs(current, date)
				? current.filter((each) => !isSameDay(each, date))
				: [...current, date];
			selection.onSelect?.(next, date);
			return;
		}

		if (selection.mode === "range") {
			const current = selection.selected;
			// Sin inicio, o con el rango ya cerrado, se empieza uno nuevo: es lo que
			// espera quien vuelve a pinchar después de elegir un rango entero.
			if (!current?.from || current.to) {
				selection.onSelect?.({ from: date, to: null });
				return;
			}
			selection.onSelect?.(
				isBefore(date, current.from)
					? { from: date, to: current.from }
					: { from: current.from, to: date },
			);
			return;
		}

		selection.onSelect?.(date);
	};

	const moveFocus = (from: Date, days: number) => {
		const next = addDays(from, days);
		if (outOfBounds(next)) return;

		shouldRestoreFocus.current = true;
		setFocused(next);
		if (!isSameMonth(next, visibleMonth) && numberOfMonths === 1) {
			goToMonth(next);
		}
	};

	const onDayKeyDown = (event: React.KeyboardEvent, date: Date) => {
		const jump: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			ArrowUp: -7,
			ArrowDown: 7,
		};

		if (event.key in jump) {
			event.preventDefault();
			moveFocus(date, jump[event.key] ?? 0);
			return;
		}
		if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			shouldRestoreFocus.current = true;
			setFocused(
				event.key === "Home"
					? startOfWeek(date, { weekStartsOn })
					: endOfWeek(date, { weekStartsOn }),
			);
			return;
		}
		if (event.key === "PageUp" || event.key === "PageDown") {
			event.preventDefault();
			const next = addMonths(date, event.key === "PageUp" ? -1 : 1);
			if (outOfBounds(next)) return;
			shouldRestoreFocus.current = true;
			setFocused(next);
			goToMonth(next);
		}
	};

	const months = Array.from({ length: numberOfMonths }, (_, index) =>
		addMonths(visibleMonth, index),
	);
	const weekdays = weekdayNames(weekStartsOn);

	/**
	 * La única celda que entra en el orden de tabulación: el resto se alcanza con
	 * las flechas, no con cuarenta y dos tabulaciones.
	 */
	const tabbableDay = (() => {
		if (focused && months.some((each) => isSameMonth(focused, each))) {
			return focused;
		}
		const days = months.flatMap((each) =>
			eachDayOfInterval({ start: startOfMonth(each), end: endOfMonth(each) }),
		);
		return (
			days.find((day) => isSelected(day)) ??
			days.find((day) => isToday(day)) ??
			days[0]
		);
	})();

	const canGoBack = !fromDate || isAfter(visibleMonth, startOfMonth(fromDate));
	const canGoForward =
		!toDate ||
		isBefore(
			startOfMonth(months[months.length - 1] ?? visibleMonth),
			startOfMonth(toDate),
		);

	const years = (() => {
		const current = getYear(visibleMonth);
		const first = fromDate ? getYear(fromDate) : current - yearRange;
		const last = toDate ? getYear(toDate) : current + yearRange;
		return Array.from(
			{ length: Math.max(1, last - first + 1) },
			(_, index) => first + index,
		);
	})();

	return (
		<div className={cn("w-fit max-w-full space-y-3", className)}>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Año anterior"
						disabled={!canGoBack}
						onClick={() => goToMonth(addMonths(visibleMonth, -12))}
					>
						<ChevronsLeft />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Mes anterior"
						disabled={!canGoBack}
						onClick={() => goToMonth(addMonths(visibleMonth, -1))}
					>
						<ChevronLeft />
					</Button>
				</div>

				{captionLayout === "dropdowns" ? (
					<div className="flex items-center gap-2">
						<select
							aria-label="Mes"
							className="h-8 rounded-md border bg-background px-2 text-sm"
							value={getMonth(visibleMonth)}
							onChange={(event) =>
								goToMonth(setMonth(visibleMonth, Number(event.target.value)))
							}
						>
							{Array.from({ length: 12 }, (_, index) => {
								const monthName = capitalize(
									format(setMonth(visibleMonth, index), "LLLL", {
										locale: ES_LOCALE,
									}),
								);
								return (
									<option key={monthName} value={index}>
										{monthName}
									</option>
								);
							})}
						</select>
						<select
							aria-label="Año"
							className="h-8 rounded-md border bg-background px-2 text-sm"
							value={getYear(visibleMonth)}
							onChange={(event) =>
								goToMonth(setYear(visibleMonth, Number(event.target.value)))
							}
						>
							{years.map((year) => (
								<option key={year} value={year}>
									{year}
								</option>
							))}
						</select>
					</div>
				) : (
					<div aria-live="polite" className="text-sm font-medium tabular-nums">
						{months.map((each) => formatMonthCaption(each)).join(" · ")}
					</div>
				)}

				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => goToMonth(new Date())}
					>
						Hoy
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Mes siguiente"
						disabled={!canGoForward}
						onClick={() => goToMonth(addMonths(visibleMonth, 1))}
					>
						<ChevronRight />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Año siguiente"
						disabled={!canGoForward}
						onClick={() => goToMonth(addMonths(visibleMonth, 12))}
					>
						<ChevronsRight />
					</Button>
				</div>
			</div>

			<div
				ref={gridRef}
				className={cn(
					"flex flex-col gap-4",
					numberOfMonths > 1 && "sm:flex-row sm:gap-6",
				)}
			>
				{months.map((each) => {
					const weeks = monthWeeks(each, weekStartsOn);
					const monthDays = eachDayOfInterval({
						start: startOfMonth(each),
						end: endOfMonth(each),
					});

					return (
						<div key={each.toISOString()} className="min-w-0 space-y-1">
							{numberOfMonths > 1 && (
								<div className="px-1 text-sm font-medium">
									{formatMonthCaption(each)}
								</div>
							)}

							{/*
							 * Una tabla de verdad, no una rejilla de divs: los encabezados de
							 * columna y de fila son nativos, así que un lector de pantalla
							 * anuncia el día de la semana y el número de semana sin que haya
							 * que describírselos. El estado de cada día lo lleva su botón
							 * (`aria-pressed`, `aria-current`), que es lo enfocable.
							 */}
							<table
								aria-label={`${label}: ${formatMonthCaption(each)}`}
								className="w-full table-fixed border-separate border-spacing-1"
							>
								<thead>
									<tr>
										{showWeekNumbers && (
											<th
												scope="col"
												className="w-9 pb-1 text-center text-[0.65rem] font-medium text-placeholder"
											>
												<span className="sr-only">Semana</span>
												<span aria-hidden="true">sem</span>
											</th>
										)}
										{weekdays.map((weekday) => {
											const daysOfWeekday = monthDays.filter(
												(day) => day.getDay() === weekday.key,
											);

											return (
												<th
													key={weekday.key}
													scope="col"
													className="pb-1 text-center text-xs font-medium text-muted-foreground"
												>
													{!readOnly && onWeekdayClick ? (
														<button
															type="button"
															className="w-full rounded-md py-0.5 hover:bg-accent/60 hover:text-accent-foreground"
															title={`Seleccionar todos los ${weekday.longLabel} del mes`}
															onClick={() =>
																onWeekdayClick(weekday.key, daysOfWeekday)
															}
														>
															{weekday.label}
														</button>
													) : (
														weekday.label
													)}
												</th>
											);
										})}
									</tr>
								</thead>
								<tbody>
									{weeks.map((week) => (
										<tr key={week[0]?.toISOString()}>
											{showWeekNumbers && (
												<th scope="row" className="align-middle font-normal">
													{!readOnly && onWeekClick ? (
														<button
															type="button"
															className="w-full rounded-md py-1 text-[0.65rem] text-placeholder tabular-nums hover:bg-accent/60 hover:text-accent-foreground"
															title="Seleccionar la semana completa"
															onClick={() =>
																onWeekClick(
																	week.filter((day) => isSameMonth(day, each)),
																	getISOWeek(week[0] ?? each),
																)
															}
														>
															{getISOWeek(week[0] ?? each)}
														</button>
													) : (
														<span className="text-[0.65rem] text-placeholder tabular-nums">
															{getISOWeek(week[0] ?? each)}
														</span>
													)}
												</th>
											)}

											{week.map((day) => {
												const outside = !isSameMonth(day, each);
												if (outside && !showOutsideDays) {
													return <td key={day.toISOString()} />;
												}

												const mark = resolveMark(marks, day);
												const selected = isSelected(day);
												const position = rangeState(day);
												const dayDisabled = isDisabled(day);
												const today = isToday(day);
												// Los puntos se deduplican por tono: dos señales del
												// mismo color no aportan nada, y así la clave de React
												// es el tono y no la posición en el array.
												const dots = mark?.dots ? [...new Set(mark.dots)] : [];
												const description = mark?.description;

												return (
													<td key={day.toISOString()} className="p-0 align-top">
														<button
															type="button"
															data-day={toISODate(day)}
															disabled={dayDisabled}
															tabIndex={
																tabbableDay && isSameDay(day, tabbableDay)
																	? 0
																	: -1
															}
															aria-label={
																description
																	? `${formatLongDate(day)}. ${description}`
																	: formatLongDate(day)
															}
															aria-pressed={selected}
															aria-current={today ? "date" : undefined}
															title={description}
															onClick={() => select(day)}
															onKeyDown={(event) => onDayKeyDown(event, day)}
															onFocus={() => setFocused(day)}
															onMouseEnter={() => setHovered(day)}
															onMouseLeave={() => setHovered(null)}
															className={cn(
																"flex w-full flex-col items-start gap-0.5 overflow-hidden rounded-md border border-transparent text-left transition-colors",
																SIZE_CELL[size],
																mark?.tone && TONE_CELL[mark.tone],
																!dayDisabled &&
																	!selected &&
																	"hover:border-border hover:bg-accent/50",
																outside && "opacity-40",
																dayDisabled && "cursor-not-allowed opacity-35",
																// El rango se pinta como una banda: los extremos
																// con el color pleno y el relleno insinuado, que
																// es lo que deja ver de un vistazo dónde empieza
																// y dónde acaba.
																position === "middle" && "bg-primary/15",
																(position === "start" || position === "end") &&
																	"border-primary/50 bg-primary/25",
																selected &&
																	!position &&
																	"border-primary bg-primary/15 ring-1 ring-primary/40",
																"focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
															)}
														>
															<span className="flex w-full items-start justify-between gap-1">
																<span
																	className={cn(
																		"text-sm tabular-nums",
																		today && "font-bold text-primary",
																		selected && "font-semibold",
																	)}
																>
																	{format(day, "d")}
																</span>
																{dots.length > 0 && (
																	<span className="flex items-center gap-0.5 pt-1.5">
																		{dots.map((tone) => (
																			<span
																				key={tone}
																				className={cn(
																					"size-1.5 rounded-full",
																					TONE_DOT[tone],
																				)}
																			/>
																		))}
																	</span>
																)}
															</span>

															{size !== "sm" && mark?.label ? (
																<span
																	className={cn(
																		"line-clamp-1 w-full text-[0.65rem] leading-tight font-medium",
																		TONE_TEXT[mark.tone ?? "neutral"],
																	)}
																>
																	{mark.label}
																</span>
															) : null}

															{size === "lg" && mark?.detail ? (
																<span className="line-clamp-1 w-full text-[0.65rem] leading-tight text-placeholder">
																	{mark.detail}
																</span>
															) : null}
														</button>
													</td>
												);
											})}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					);
				})}
			</div>

			{legend && legend.length > 0 && (
				<ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
					{legend.map((item) => (
						<li key={item.label} className="flex items-center gap-1.5">
							<span
								className={cn(
									"size-2.5 rounded-sm border",
									TONE_CELL[item.tone],
								)}
							/>
							{item.label}
						</li>
					))}
				</ul>
			)}

			{footer}
		</div>
	);
}
