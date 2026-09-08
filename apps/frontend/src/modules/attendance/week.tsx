import type { AttendanceDay } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { addDays, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight, LogIn, LogOut } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { capitalize, toISODate, WEEK_STARTS_ON } from "#/lib/dates.ts";
import { attendanceHistoryQueryOptions } from "#/modules/attendance/api.ts";
import {
	ABSENCE_LABEL,
	formatWorked,
	STATUS_BADGE,
	STATUS_LABEL,
	time,
} from "#/modules/attendance/day-presentation.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Mi semana (spec 05 §3), la vista de historial del EmployeeShell.
 *
 * **Reutiliza los datos, no el diseño**, y ahí está la decisión. Es la misma
 * consulta que *Mi asistencia* —el mismo endpoint ya agregado por el servidor
 * (spec 15 §4)— pero un calendario de seis semanas y una tabla de cinco columnas
 * en una pantalla de 375 px es exactamente lo que este shell existe para evitar
 * (RN-05.6). Aquí son siete tarjetas en una columna: se lee con el pulgar y sin
 * pellizcar.
 *
 * Las etiquetas y los formatos sí se comparten (`day-presentation.ts`): el mismo
 * día tiene que llamarse igual en las dos pantallas.
 *
 * La semana empieza el lunes (`WEEK_STARTS_ON`), como en todo el resto de la
 * aplicación.
 */
export function MyWeek() {
	const [monday, setMonday] = useState(() =>
		startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }),
	);

	const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
	const range = {
		from: toISODate(monday),
		to: toISODate(addDays(monday, 6)),
	};
	const history = useQuery(attendanceHistoryQueryOptions(range));
	const byDate = new Map((history.data ?? []).map((day) => [day.date, day]));

	const today = toISODate(new Date());
	const isCurrentWeek = range.from <= today && today <= range.to;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label="Semana anterior"
					onClick={() => setMonday((current) => addDays(current, -7))}
				>
					<ChevronLeft />
				</Button>

				<p className="text-center text-sm font-medium">
					{isCurrentWeek ? (
						"Esta semana"
					) : (
						<>
							{capitalize(
								monday.toLocaleDateString("es-CU", {
									day: "numeric",
									month: "short",
								}),
							)}{" "}
							—{" "}
							{addDays(monday, 6).toLocaleDateString("es-CU", {
								day: "numeric",
								month: "short",
							})}
						</>
					)}
				</p>

				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label="Semana siguiente"
					// No se navega al futuro: no hay nada que ver, y ofrecerlo hace que
					// alguien piense que su semana que viene ya está decidida.
					disabled={isCurrentWeek}
					onClick={() => setMonday((current) => addDays(current, 7))}
				>
					<ChevronRight />
				</Button>
			</div>

			<InlineError error={history.error} />

			{history.isPending ? (
				<div className="space-y-2">
					{days.map((day) => (
						<Skeleton key={day.toISOString()} className="h-20 w-full" />
					))}
				</div>
			) : (
				<ul className="space-y-2">
					{days.map((day) => (
						<DayCard
							key={day.toISOString()}
							date={day}
							day={byDate.get(toISODate(day)) ?? null}
							isToday={toISODate(day) === today}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function DayCard({
	date,
	day,
	isToday,
}: {
	date: Date;
	day: AttendanceDay | null;
	isToday: boolean;
}) {
	const weekday = capitalize(
		date.toLocaleDateString("es-CU", { weekday: "long" }),
	);
	const dayNumber = date.getDate();

	return (
		<li
			data-today={isToday}
			className="rounded-xl border p-4 data-[today=true]:border-primary/60 data-[today=true]:bg-primary/5"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium">
						{weekday} {dayNumber}
						{isToday && (
							<span className="ml-2 text-xs font-normal text-primary">hoy</span>
						)}
					</p>

					{day ? (
						<p className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
							<span className="flex items-center gap-1">
								<LogIn className="size-3.5" />
								{time(day.firstIn)}
							</span>
							<span className="flex items-center gap-1">
								<LogOut className="size-3.5" />
								{time(day.lastOut)}
							</span>
							{day.workedMinutes !== null && (
								<span>{formatWorked(day.workedMinutes)}</span>
							)}
						</p>
					) : (
						<p className="mt-1 text-sm text-placeholder">Sin datos</p>
					)}

					{day?.incomplete && (
						<p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
							Sin salida registrada. No se inventa una hora: si hace falta, se
							corrige por incidencia.
						</p>
					)}
				</div>

				{day && (
					<div className="flex shrink-0 flex-col items-end gap-1">
						{/*
						 * Una jornada en curso no se pinta como ausencia: `AUSENTE` es
						 * provisional hasta que el día termina (spec 15 RN-15.4).
						 */}
						<Badge variant={day.pending ? "outline" : STATUS_BADGE[day.status]}>
							{day.pending ? "En curso" : STATUS_LABEL[day.status]}
						</Badge>
						{day.absence && (
							<Badge variant="outline" className="font-normal">
								{ABSENCE_LABEL[day.absence.code]}
							</Badge>
						)}
						{day.isLate && (
							<span className="text-xs text-amber-700 dark:text-amber-400">
								{day.lateMinutes} min tarde
							</span>
						)}
					</div>
				)}
			</div>
		</li>
	);
}
