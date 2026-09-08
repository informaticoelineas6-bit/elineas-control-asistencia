import type { AttendanceDay } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { endOfMonth, startOfMonth } from "date-fns";
import { CalendarClock, Clock, LogIn, LogOut } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import {
	Calendar,
	type CalendarDayMark,
	type CalendarTone,
} from "#/components/ui/calendar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { formatWeekdayDate, toISODate } from "#/lib/dates.ts";
import { attendanceHistoryQueryOptions } from "#/modules/attendance/api.ts";
import {
	ABSENCE_LABEL,
	formatWorked,
	STATUS_BADGE,
	STATUS_LABEL,
	STATUS_TONE,
	time,
} from "#/modules/attendance/day-presentation.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Historial propio (spec 09 §5).
 *
 * Dos vistas del mismo dato, que llega **ya agregado por día** desde el servidor: el
 * frontend no calcula estados (spec 15 §4). El calendario da la forma del mes de un
 * vistazo —dónde faltan días, dónde hubo tardanzas— y la tabla el detalle de cada
 * jornada.
 *
 * Es el mismo componente de calendario de la spec 07: aquí sólo se le pasan otras
 * marcas. Y las etiquetas, los tonos y los formatos vienen de
 * `day-presentation.ts`, compartidos con la vista de la semana del EmployeeShell
 * (spec 05 §3): dos tablas para los mismos seis estados acabarían diciendo cosas
 * distintas del mismo día.
 */

export function AttendanceHistory() {
	const [month, setMonth] = useState(() => startOfMonth(new Date()));
	const range = {
		from: toISODate(startOfMonth(month)),
		to: toISODate(endOfMonth(month)),
	};
	const history = useQuery(attendanceHistoryQueryOptions(range));

	const byDate = new Map((history.data ?? []).map((day) => [day.date, day]));

	const marks = (date: Date): CalendarDayMark | null => {
		const day = byDate.get(toISODate(date));
		if (!day) return null;

		// Un día que todavía puede completarse no se pinta en rojo: `AUSENTE` es
		// provisional hasta que la jornada termina.
		const tone: CalendarTone = day.pending
			? "neutral"
			: STATUS_TONE[day.status];

		return {
			tone,
			label: day.pending ? "En curso" : STATUS_LABEL[day.status],
			detail:
				day.firstIn || day.lastOut
					? `${time(day.firstIn)}–${time(day.lastOut)}`
					: undefined,
			dots: day.incomplete ? ["warning"] : undefined,
			description: [
				day.pending ? "Jornada en curso" : STATUS_LABEL[day.status],
				// Spec 13: la clasificación de la ausencia, con el mismo texto que el
				// badge de la tabla.
				day.absence ? ABSENCE_LABEL[day.absence.code] : null,
				day.isLate ? `${day.lateMinutes} min de tardanza` : null,
				day.incomplete ? "sin salida registrada" : null,
				day.workedMinutes !== null
					? `${formatWorked(day.workedMinutes)} trabajados`
					: null,
			]
				.filter(Boolean)
				.join(" · "),
		};
	};

	const withActivity = (history.data ?? []).filter(
		(day) => day.marks.length > 0 || day.status !== "AUSENTE" || !day.pending,
	);

	return (
		<div className="space-y-6">
			<InlineError error={history.error} />

			{history.isPending ? (
				<Skeleton className="h-80 w-full" />
			) : (
				<div className="flex flex-col gap-6 xl:flex-row xl:items-start">
					<Calendar
						readOnly
						size="lg"
						month={month}
						onMonthChange={setMonth}
						marks={marks}
						label="Mi asistencia"
						className="min-w-0"
						legend={[
							{ tone: "positive", label: "Presente" },
							{ tone: "warning", label: "Tarde" },
							{ tone: "danger", label: "Ausente" },
							{ tone: "info", label: "Descanso" },
							{ tone: "neutral", label: "No laborable o en curso" },
						]}
					/>

					<div className="min-w-0 flex-1 space-y-3">
						<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
							<CalendarClock className="size-4" />
							Detalle del mes
						</h2>

						{withActivity.length === 0 ? (
							<p className="rounded-md border border-dashed border-border/70 bg-muted/30 p-4 text-sm text-placeholder">
								Todavía no hay nada registrado en este mes.
							</p>
						) : (
							<div className="rounded-xl border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="pl-4">Día</TableHead>
											<TableHead>Estado</TableHead>
											<TableHead>Entrada</TableHead>
											<TableHead>Salida</TableHead>
											<TableHead className="pr-4 text-right">
												Trabajado
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{withActivity.map((day: AttendanceDay) => (
											<TableRow key={day.date}>
												<TableCell className="pl-4 whitespace-normal">
													<span className="text-sm">
														{formatWeekdayDate(day.date)}
													</span>
												</TableCell>
												<TableCell>
													<div className="flex flex-wrap items-center gap-1.5">
														<Badge variant={STATUS_BADGE[day.status]}>
															{day.pending
																? "En curso"
																: STATUS_LABEL[day.status]}
														</Badge>
														{day.isLate && (
															<span className="text-xs text-muted-foreground">
																{day.lateMinutes} min
															</span>
														)}
														{day.incomplete && (
															<Badge variant="warning">Sin salida</Badge>
														)}
														{/*
														 * Spec 13: `AJ`/`ANJ` sobre un día ausente. Va como
														 * badge aparte y no sustituyendo a "Ausente"
														 * porque es una **superposición**: el día sigue
														 * siendo una ausencia, y lo que añade es qué se
														 * decidió sobre ella.
														 */}
														{day.absence && (
															<Badge
																variant={
																	day.absence.code === "AJ"
																		? "secondary"
																		: "destructive"
																}
																title={
																	day.absence.notes ??
																	(day.absence.reviewed
																		? undefined
																		: "Tu jefe todavía no la ha clasificado")
																}
															>
																{ABSENCE_LABEL[day.absence.code]}
															</Badge>
														)}
													</div>
												</TableCell>
												<TableCell className="tabular-nums">
													<span className="flex items-center gap-1.5">
														<LogIn className="size-3.5 text-muted-foreground" />
														{time(day.firstIn)}
													</span>
												</TableCell>
												<TableCell className="tabular-nums">
													<span className="flex items-center gap-1.5">
														<LogOut className="size-3.5 text-muted-foreground" />
														{time(day.lastOut)}
													</span>
												</TableCell>
												<TableCell className="pr-4 text-right tabular-nums">
													<span className="flex items-center justify-end gap-1.5">
														<Clock className="size-3.5 text-muted-foreground" />
														{formatWorked(day.workedMinutes)}
													</span>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
