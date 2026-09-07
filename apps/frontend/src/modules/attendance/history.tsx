import type { AttendanceDay, AttendanceDayStatus } from "@elineas/validations";
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
 * marcas.
 */

const STATUS_LABEL: Record<AttendanceDayStatus, string> = {
	PRESENTE: "Presente",
	TARDE: "Tarde",
	AUSENTE: "Ausente",
	DESCANSO: "Descanso",
	NO_LABORABLE: "No laborable",
	// Spec 11 RN-11.12: superposición sobre lo que le hubiera tocado al día.
	VACACIONES: "Vacaciones",
};

const STATUS_TONE: Record<AttendanceDayStatus, CalendarTone> = {
	PRESENTE: "positive",
	TARDE: "warning",
	AUSENTE: "danger",
	DESCANSO: "info",
	NO_LABORABLE: "neutral",
	// Mismo tono que DESCANSO a propósito: sólo hay cinco tonos en el calendario
	// (`CalendarTone`) y las dos son "día libre planeado, no un problema". La
	// etiqueta es la que distingue una cosa de la otra.
	VACACIONES: "info",
};

/**
 * Spec 13. Los códigos del reporte se enseñan **desarrollados**: `AJ` y `ANJ`
 * son el vocabulario de la reportería (spec 16), no el de quien lee su propio
 * historial en el móvil.
 */
const ABSENCE_LABEL: Record<"AJ" | "ANJ", string> = {
	AJ: "Justificada",
	ANJ: "No justificada",
};

const STATUS_BADGE: Record<
	AttendanceDayStatus,
	"default" | "secondary" | "warning" | "destructive" | "outline"
> = {
	PRESENTE: "secondary",
	TARDE: "warning",
	AUSENTE: "destructive",
	DESCANSO: "outline",
	NO_LABORABLE: "outline",
	VACACIONES: "secondary",
};

const time = (value: string | null) =>
	value
		? new Date(value).toLocaleTimeString("es-CU", {
				hour: "2-digit",
				minute: "2-digit",
			})
		: "—";

/** "8 h 15 min", que es como se lee una jornada. */
function formatWorked(minutes: number | null): string {
	if (minutes === null) return "—";
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest} min`;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

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
