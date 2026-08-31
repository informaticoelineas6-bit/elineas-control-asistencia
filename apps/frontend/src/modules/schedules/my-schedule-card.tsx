import {
	describeMarkWindow,
	describeMidnightCrossing,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { endOfMonth, startOfMonth } from "date-fns";
import { CalendarClock, CircleAlert, Clock, Info, Moon } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Calendar, type CalendarDayMark } from "#/components/ui/calendar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { formatWeekdayDate, toISODate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { myScheduleQueryOptions } from "#/modules/schedules/api.ts";

/**
 * "Mi horario" (spec 07 §5, `GET /me/schedule`), en el perfil propio.
 *
 * Es el único sitio donde un empleado ve la ventana que se le exige y los días no
 * laborables de su departamento — no tiene ámbito sobre el calendario del
 * departamento, así que estos datos le llegan por su propio endpoint.
 *
 * La frase de la ventana se calcula con la misma función que usa el servidor para
 * aceptar o rechazar un marcaje: lo que se lee aquí es lo que se va a exigir, no
 * una descripción escrita a mano que puede quedarse vieja.
 */
export function MyScheduleCard() {
	const [month, setMonth] = useState(() => startOfMonth(new Date()));
	const range = {
		from: toISODate(startOfMonth(month)),
		to: toISODate(endOfMonth(month)),
	};
	const mine = useQuery(myScheduleQueryOptions(range));

	if (mine.isPending) {
		return (
			<section className="rounded-xl border p-4">
				<Skeleton className="h-64 w-full" />
			</section>
		);
	}

	if (mine.error) {
		return (
			<section className="rounded-xl border p-4">
				<InlineError error={mine.error} />
			</section>
		);
	}

	if (!mine.data) return null;

	const { department, schedule, today, entries, timezone, canMark } = mine.data;

	const marks = (date: Date): CalendarDayMark | null => {
		const iso = toISODate(date);
		const entry = entries.find((row) => row.date === iso);
		if (!entry) return null;

		return {
			tone: entry.isWorkday ? "positive" : "danger",
			label: entry.note || (entry.isWorkday ? "Laborable" : "No laborable"),
			detail:
				entry.lateToleranceMinutes !== null
					? `tolerancia ${entry.lateToleranceMinutes} min`
					: undefined,
			description: `${entry.isWorkday ? "Laborable" : "No laborable"}${
				entry.note ? ` · ${entry.note}` : ""
			}`,
		};
	};

	return (
		<section className="space-y-4 rounded-xl border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
						<CalendarClock className="size-4" />
						Mi horario
					</h2>
					<p className="mt-1 text-sm">
						{department
							? `El de ${department.name}. Las horas están en ${timezone}.`
							: "Sin departamento asignado no hay horario que aplicar."}
					</p>
				</div>
				{!canMark && (
					<Badge variant="secondary">Tu rol no registra asistencia</Badge>
				)}
			</div>

			{department && !schedule && (
				<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
					Tu departamento todavía no tiene horario configurado, así que no se
					puede registrar asistencia. Un gestor tiene que definirlo.
				</p>
			)}

			{schedule && (
				<div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
					<p className="flex items-start gap-2">
						<Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<span>
							{describeMarkWindow(schedule, "IN")}{" "}
							{describeMarkWindow(schedule, "OUT")}
						</span>
					</p>
					{describeMidnightCrossing(schedule) && (
						<p className="flex items-start gap-2 text-muted-foreground">
							<Moon className="mt-0.5 size-4 shrink-0" />
							{describeMidnightCrossing(schedule)}
						</p>
					)}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2 text-sm">
				<span className="text-muted-foreground">
					{formatWeekdayDate(today.date)}:
				</span>
				{today.isWorkday ? (
					<Badge variant="secondary">Día laborable</Badge>
				) : (
					<Badge variant="warning">No laborable</Badge>
				)}
				<span className="text-muted-foreground">
					Tolerancia de {today.lateToleranceMinutes} min
					{today.toleranceSource === "calendar" ? " (propia del día)" : ""}
				</span>
				{today.note && (
					<span className="text-muted-foreground">· {today.note}</span>
				)}
			</div>

			{department && (
				<>
					<Calendar
						readOnly
						size="md"
						month={month}
						onMonthChange={setMonth}
						marks={marks}
						label="Calendario laboral de mi departamento"
						legend={[
							{ tone: "positive", label: "Laborable marcado" },
							{ tone: "danger", label: "No laborable" },
							{ tone: "neutral", label: "Sin marca: laborable" },
						]}
					/>
					<p className="flex items-start gap-2 text-xs text-muted-foreground">
						<Info className="mt-0.5 size-3.5 shrink-0" />
						Los días sin marcar son laborables. Los cambios del calendario los
						hace un gestor; si algo no cuadra con lo que trabajaste, repórtalo
						como incidencia.
					</p>
				</>
			)}
		</section>
	);
}
