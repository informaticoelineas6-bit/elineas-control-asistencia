import type {
	AppConfigValues,
	DepartmentSummary,
	WorkCalendarEntry,
	WorkCalendarEntryInput,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import {
	eachDayOfInterval,
	endOfMonth,
	isSameMonth,
	startOfMonth,
} from "date-fns";
import {
	CalendarRange,
	CalendarX2,
	Check,
	Eraser,
	Loader2,
	Timer,
} from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	Calendar,
	type CalendarDayMark,
	type DateRange,
} from "#/components/ui/calendar.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { fromISODate, toISODate, WEEK_STARTS_ON } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	useUpdateWorkCalendar,
	workCalendarQueryOptions,
} from "#/modules/schedules/api.ts";

/**
 * Calendario laboral de un departamento (spec 07 §6): vista de mes, marcar y
 * desmarcar días, edición masiva por rango y tolerancia propia por fecha.
 *
 * Tres decisiones de diseño que vienen de las reglas, no del gusto:
 *
 * - **Tres estados por día, no dos.** "Sin fila" no es lo mismo que "laborable":
 *   sin fila la fecha es laborable con la tolerancia global (RN-07.7, RN-07.8), y
 *   por eso existe *Quitar marca* además de *Laborable*. Marcar los 365 días de un
 *   año como laborables funcionaría, pero convertiría el calendario en una tabla
 *   que hay que mantener entera.
 * - **Los cambios se acumulan y se guardan de una vez.** Igual que el formulario de
 *   configuración: se ve cuántos días llevas tocados, se puede descartar, y el
 *   servidor recibe un solo lote — una transacción y una entrada de bitácora
 *   (spec 07 §5).
 * - **Selección por lotes de verdad.** Pulsar la cabecera de un día de la semana
 *   selecciona todos los de ese día del mes; el rango admite además filtrar por
 *   día de la semana. Marcar los domingos de un año a mano es lo que hace que
 *   nadie mantenga esto al día.
 */

/** `null` en el borrador = quitar la fila y volver al valor por defecto. */
type DraftValue = Omit<WorkCalendarEntryInput, "date"> | null;

type DayState = Omit<WorkCalendarEntryInput, "date"> | null;

const sameState = (a: DayState, b: DayState) =>
	a === null || b === null
		? a === b
		: a.isWorkday === b.isWorkday &&
			a.lateToleranceMinutes === b.lateToleranceMinutes &&
			(a.note ?? null) === (b.note ?? null);

const toState = (entry: WorkCalendarEntry): DayState => ({
	isWorkday: entry.isWorkday,
	lateToleranceMinutes: entry.lateToleranceMinutes,
	note: entry.note,
});

const WEEKDAY_LABELS = [
	{ key: 1, label: "Lun" },
	{ key: 2, label: "Mar" },
	{ key: 3, label: "Mié" },
	{ key: 4, label: "Jue" },
	{ key: 5, label: "Vie" },
	{ key: 6, label: "Sáb" },
	{ key: 0, label: "Dom" },
];

export function WorkCalendarEditor({
	department,
	config,
}: {
	department: DepartmentSummary;
	config: AppConfigValues;
}) {
	const [month, setMonth] = useState(() => startOfMonth(new Date()));
	const [selected, setSelected] = useState<Date[]>([]);
	const [draft, setDraft] = useState<Map<string, DraftValue>>(new Map());
	const [tolerance, setTolerance] = useState("");
	const [note, setNote] = useState("");
	const [rangeOpen, setRangeOpen] = useState(false);
	const [range, setRange] = useState<DateRange>({ from: null, to: null });
	const [weekdayFilter, setWeekdayFilter] = useState<number[]>([]);

	const save = useUpdateWorkCalendar();

	const from = toISODate(startOfMonth(month));
	const to = toISODate(endOfMonth(month));
	const calendar = useQuery(
		workCalendarQueryOptions(department.id, { from, to }),
	);

	/**
	 * El estado guardado sólo se conoce para el rango cargado —el mes visible—, y la
	 * selección puede abarcar otros meses (el rango del diálogo no se limita a uno).
	 * Distinguir "sé que no hay fila" de "no lo sé" es lo que evita que quitar la
	 * marca de un día de otro mes se descarte silenciosamente por parecer un no-op.
	 */
	const isLoaded = (iso: string) => iso >= from && iso <= to;

	const serverState = (iso: string): DayState => {
		const entry = calendar.data?.find((row) => row.date === iso);
		return entry ? toState(entry) : null;
	};

	const stateOf = (iso: string): { value: DayState; pending: boolean } =>
		draft.has(iso)
			? { value: draft.get(iso) ?? null, pending: true }
			: { value: serverState(iso), pending: false };

	/**
	 * Aplica un cambio a las fechas indicadas. Si el resultado coincide con lo que
	 * ya hay guardado, la fecha **sale** del borrador: así el contador de cambios
	 * dice la verdad y no se manda al servidor un lote que no cambia nada.
	 */
	const apply = (dates: Date[], change: (current: DayState) => DraftValue) => {
		setDraft((previous) => {
			const next = new Map(previous);
			for (const date of dates) {
				const iso = toISODate(date);
				const current = next.has(iso)
					? (next.get(iso) ?? null)
					: serverState(iso);
				const value = change(current);

				if (isLoaded(iso) && sameState(value, serverState(iso))) {
					next.delete(iso);
				} else {
					next.set(iso, value);
				}
			}
			return next;
		});
	};

	const markAs = (isWorkday: boolean) =>
		apply(selected, (current) => ({
			isWorkday,
			lateToleranceMinutes: current?.lateToleranceMinutes ?? null,
			note: current?.note ?? null,
		}));

	const clearMarks = () => apply(selected, () => null);

	const applyTolerance = () => {
		const raw = tolerance.trim();
		const minutes = raw === "" ? null : Number(raw);
		if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) return;

		apply(selected, (current) => ({
			isWorkday: current?.isWorkday ?? true,
			lateToleranceMinutes: minutes,
			note: current?.note ?? null,
		}));
		setTolerance("");
	};

	const applyNote = () => {
		const text = note.trim();
		apply(selected, (current) => ({
			isWorkday: current?.isWorkday ?? true,
			lateToleranceMinutes: current?.lateToleranceMinutes ?? null,
			note: text === "" ? null : text,
		}));
		setNote("");
	};

	/** El rango **añade**; alternar ahí borraría lo que el usuario acaba de elegir. */
	const addAll = (dates: Date[]) => {
		setSelected((current) => {
			const isoSelected = new Set(current.map(toISODate));
			return [
				...current,
				...dates.filter((date) => !isoSelected.has(toISODate(date))),
			];
		});
	};

	const toggleAll = (dates: Date[]) => {
		setSelected((current) => {
			const isoSelected = new Set(current.map(toISODate));
			const every = dates.every((date) => isoSelected.has(toISODate(date)));
			if (every) {
				const removing = new Set(dates.map(toISODate));
				return current.filter((date) => !removing.has(toISODate(date)));
			}
			const missing = dates.filter((date) => !isoSelected.has(toISODate(date)));
			return [...current, ...missing];
		});
	};

	const marks = (date: Date): CalendarDayMark | null => {
		const { value, pending } = stateOf(toISODate(date));
		const dots: CalendarDayMark["dots"] = pending ? ["info"] : undefined;

		if (!value) {
			return pending
				? {
						dots,
						label: "Sin marca",
						description: "Se quitará la marca: laborable por defecto",
					}
				: null;
		}

		const tone = value.isWorkday ? "positive" : "danger";
		const own = value.lateToleranceMinutes;

		return {
			tone,
			dots,
			label: value.note || (value.isWorkday ? "Laborable" : "No laborable"),
			detail:
				own !== null && own !== undefined ? `tolerancia ${own} min` : undefined,
			description: `${value.isWorkday ? "Laborable" : "No laborable"}${
				value.note ? ` · ${value.note}` : ""
			} · tolerancia ${own ?? config.late_tolerance_minutes} min${
				own === null || own === undefined ? " (global)" : ""
			}${pending ? " · sin guardar" : ""}`,
		};
	};

	const pendingEntries = [...draft.entries()].filter(
		(pair): pair is [string, Omit<WorkCalendarEntryInput, "date">] =>
			pair[1] !== null,
	);
	const pendingClears = [...draft.entries()]
		.filter((pair) => pair[1] === null)
		.map(([date]) => date);
	const pendingCount = draft.size;
	const tooMany = pendingEntries.length > 400 || pendingClears.length > 400;

	const monthDays = eachDayOfInterval({
		start: startOfMonth(month),
		end: endOfMonth(month),
	});
	const monthEntries = (calendar.data ?? []).filter((entry) =>
		isSameMonth(fromISODate(entry.date), month),
	);
	const nonWorkdays = monthEntries.filter((entry) => !entry.isWorkday).length;
	const withOwnTolerance = monthEntries.filter(
		(entry) => entry.lateToleranceMinutes !== null,
	).length;

	const rangeDays = (() => {
		if (!range.from) return [];
		const days = eachDayOfInterval({
			start: range.from,
			end: range.to ?? range.from,
		});
		return weekdayFilter.length === 0
			? days
			: days.filter((day) => weekdayFilter.includes(day.getDay()));
	})();

	const onSave = () => {
		if (pendingCount === 0 || tooMany) return;

		save.mutate(
			{
				departmentId: department.id,
				entries: pendingEntries.map(([date, value]) => ({ date, ...value })),
				clearDates: pendingClears,
			},
			{ onSuccess: () => setDraft(new Map()) },
		);
	};

	return (
		<section className="space-y-4 rounded-xl border p-5">
			<div>
				<h3 className="flex items-center gap-2 font-medium">
					<CalendarRange className="size-4" />
					Calendario laboral
				</h3>
				<p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
					Qué fechas son laborables para {department.name}, con su tolerancia
					propia. Un día sin marcar es laborable con la tolerancia global (
					{config.late_tolerance_minutes} min). En un día no laborable el
					marcaje se rechaza.
				</p>
			</div>

			<InlineError error={calendar.error} />

			{calendar.isPending ? (
				<Skeleton className="h-80 w-full" />
			) : (
				<div className="flex flex-col gap-6 xl:flex-row xl:items-start">
					<Calendar
						mode="multiple"
						size="lg"
						month={month}
						onMonthChange={setMonth}
						selected={selected}
						onSelect={setSelected}
						marks={marks}
						showWeekNumbers
						onWeekdayClick={(_weekday, dates) => toggleAll(dates)}
						onWeekClick={(dates) => toggleAll(dates)}
						label={`Calendario laboral de ${department.name}`}
						className="min-w-0 flex-1"
						legend={[
							{ tone: "positive", label: "Laborable marcado" },
							{ tone: "danger", label: "No laborable" },
							{ tone: "neutral", label: "Sin marca: laborable por defecto" },
							{ tone: "info", label: "Cambio sin guardar" },
						]}
					/>

					<div className="w-full shrink-0 space-y-4 xl:w-80">
						<div className="rounded-lg border p-4">
							<p className="text-sm font-medium">
								{selected.length === 0
									? "Ningún día seleccionado"
									: selected.length === 1
										? "1 día seleccionado"
										: `${selected.length} días seleccionados`}
							</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Pulsa los días, la cabecera de un día de la semana o el número
								de semana. Luego aplica una acción.
							</p>

							<div className="mt-3 flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={selected.length === 0}
									onClick={() => markAs(true)}
								>
									<Check />
									Laborable
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={selected.length === 0}
									onClick={() => markAs(false)}
								>
									<CalendarX2 />
									No laborable
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={selected.length === 0}
									onClick={clearMarks}
								>
									<Eraser />
									Quitar marca
								</Button>
							</div>

							<div className="mt-4 space-y-3">
								<div className="space-y-1.5">
									<Label htmlFor="calendar-tolerance" className="text-xs">
										Tolerancia propia (minutos)
									</Label>
									<div className="flex gap-2">
										<Input
											id="calendar-tolerance"
											type="number"
											min={0}
											max={240}
											placeholder={`Global: ${config.late_tolerance_minutes}`}
											value={tolerance}
											onChange={(event) => setTolerance(event.target.value)}
										/>
										<Button
											type="button"
											size="sm"
											variant="secondary"
											disabled={selected.length === 0}
											onClick={applyTolerance}
										>
											<Timer />
											Aplicar
										</Button>
									</div>
									<p className="text-[0.7rem] text-muted-foreground">
										Vacío = usar la global. Gana sobre ella en esas fechas.
									</p>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="calendar-note" className="text-xs">
										Nota
									</Label>
									<div className="flex gap-2">
										<Input
											id="calendar-note"
											maxLength={120}
											placeholder="Feriado: 1 de mayo"
											value={note}
											onChange={(event) => setNote(event.target.value)}
										/>
										<Button
											type="button"
											size="sm"
											variant="secondary"
											disabled={selected.length === 0}
											onClick={applyNote}
										>
											Aplicar
										</Button>
									</div>
								</div>
							</div>

							<div className="mt-4 flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => toggleAll(monthDays)}
								>
									Seleccionar el mes
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => setRangeOpen(true)}
								>
									<CalendarRange />
									Por rango…
								</Button>
								{selected.length > 0 && (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() => setSelected([])}
									>
										Limpiar selección
									</Button>
								)}
							</div>
						</div>

						<div className="rounded-lg border border-dashed border-border/70 bg-muted/30 p-4 text-xs text-muted-foreground">
							<p className="font-medium text-foreground">
								Este mes, ya guardado
							</p>
							<p className="mt-1">
								{nonWorkdays === 0
									? "Ningún día no laborable."
									: nonWorkdays === 1
										? "1 día no laborable."
										: `${nonWorkdays} días no laborables.`}{" "}
								{withOwnTolerance > 0 &&
									`${withOwnTolerance} con tolerancia propia.`}
							</p>
						</div>

						<InlineError error={save.error} />

						{tooMany && (
							<p className="text-sm text-amber-700 dark:text-amber-400">
								Demasiadas fechas en un solo guardado (el máximo es 400). Guarda
								por partes.
							</p>
						)}

						<div className="flex flex-wrap items-center gap-3">
							<Button
								type="button"
								disabled={pendingCount === 0 || tooMany || save.isPending}
								onClick={onSave}
							>
								{save.isPending && <Loader2 className="animate-spin" />}
								Guardar calendario
							</Button>
							{pendingCount > 0 && (
								<Button
									type="button"
									variant="outline"
									onClick={() => setDraft(new Map())}
								>
									Descartar
								</Button>
							)}
						</div>
						<p className="text-sm text-muted-foreground">
							{pendingCount === 0
								? "Sin cambios pendientes."
								: pendingCount === 1
									? "1 día con cambios sin guardar."
									: `${pendingCount} días con cambios sin guardar.`}
						</p>
					</div>
				</div>
			)}

			<Dialog
				open={rangeOpen}
				onOpenChange={(open) => {
					setRangeOpen(open);
					if (!open) {
						setRange({ from: null, to: null });
						setWeekdayFilter([]);
					}
				}}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Seleccionar por rango</DialogTitle>
						<DialogDescription>
							Elige el primer y el último día. Si marcas días de la semana, sólo
							entran esos — es la forma de coger todos los domingos de un
							trimestre de una vez.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<Calendar
							mode="range"
							size="sm"
							numberOfMonths={2}
							weekStartsOn={WEEK_STARTS_ON}
							selected={range}
							onSelect={setRange}
							label="Rango de fechas"
						/>

						<div className="flex flex-wrap gap-1.5">
							{WEEKDAY_LABELS.map((weekday) => {
								const active = weekdayFilter.includes(weekday.key);
								return (
									<button
										key={weekday.key}
										type="button"
										aria-pressed={active}
										onClick={() =>
											setWeekdayFilter((current) =>
												active
													? current.filter((each) => each !== weekday.key)
													: [...current, weekday.key],
											)
										}
										className={`rounded-md border px-2.5 py-1 text-xs ${
											active
												? "border-primary bg-primary/15 font-medium"
												: "border-input hover:bg-accent/60"
										}`}
									>
										{weekday.label}
									</button>
								);
							})}
						</div>

						<p className="text-sm text-muted-foreground">
							{rangeDays.length === 0
								? "Todavía no hay días en el rango."
								: rangeDays.length === 1
									? "1 día entra en la selección."
									: `${rangeDays.length} días entran en la selección.`}
						</p>
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setRangeOpen(false)}
						>
							Cancelar
						</Button>
						<Button
							type="button"
							disabled={rangeDays.length === 0}
							onClick={() => {
								addAll(rangeDays);
								setRangeOpen(false);
								setRange({ from: null, to: null });
								setWeekdayFilter([]);
							}}
						>
							Añadir a la selección
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
