import type { DepartmentSummary } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { endOfMonth, startOfMonth } from "date-fns";
import { BedDouble, CircleAlert } from "lucide-react";
import { useState } from "react";
import { Calendar, type CalendarDayMark } from "#/components/ui/calendar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { toISODate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { departmentRestDaysQueryOptions } from "#/modules/rest/api.ts";

/**
 * Quién descansa cada día (spec 10 §7).
 *
 * El estado que de verdad busca un jefe aquí no es "quién descansa el martes":
 * es **cuántos** descansan a la vez. Con la separación mínima puesta y los
 * descansos elegidos uno a uno, el agujero aparece cuando media planta coincide un
 * jueves, y eso sólo se ve en la vista de mes.
 *
 * Los datos vienen resueltos del servidor —individual o por grupo, según el
 * departamento— para no repetir aquí la precedencia de RN-10.2.
 */
export function TeamRestCalendar({
	department,
}: {
	department: DepartmentSummary;
}) {
	const [month, setMonth] = useState(() => startOfMonth(new Date()));
	const range = {
		from: toISODate(startOfMonth(month)),
		to: toISODate(endOfMonth(month)),
	};
	const restDays = useQuery(
		departmentRestDaysQueryOptions(department.id, range),
	);

	const byDate = new Map(
		(restDays.data?.days ?? []).map((day) => [day.date, day.people]),
	);

	const marks = (date: Date): CalendarDayMark | null => {
		const people = byDate.get(toISODate(date));
		if (!people || people.length === 0) return null;

		const names = people.map((person) => person.fullName);
		return {
			tone: "info",
			label: people.length === 1 ? names[0] : `${people.length} descansan`,
			detail: people.length > 1 ? names.slice(0, 2).join(", ") : undefined,
			description: `Descansan: ${names.join(", ")}`,
		};
	};

	return (
		<section className="space-y-4">
			<div>
				<h3 className="flex items-center gap-2 font-medium">
					<BedDouble className="size-4" />
					Quién descansa cada día
				</h3>
				<p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
					Los descansos vigentes de {department.name}, resueltos día a día. Un
					cambio con fecha futura sólo aparece a partir de esa fecha.
				</p>
			</div>

			<InlineError error={restDays.error} />

			{restDays.isPending ? (
				<Skeleton className="h-80 w-full" />
			) : (
				<>
					<Calendar
						readOnly
						size="lg"
						month={month}
						onMonthChange={setMonth}
						marks={marks}
						label={`Descansos de ${department.name}`}
						legend={[
							{ tone: "info", label: "Alguien descansa" },
							{ tone: "neutral", label: "Nadie descansa" },
						]}
					/>

					{/*
					 * RN-10.10 en pantalla, no sólo en la campana de cada uno: el jefe es
					 * quien puede arreglarlo, y con los grupos activados es el único que
					 * puede.
					 */}
					{(restDays.data?.withoutRestDays.length ?? 0) > 0 && (
						<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
							<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
							<span>
								Sin descansos configurados, así que se les exige asistencia
								todos los días laborables:{" "}
								<strong>
									{restDays.data?.withoutRestDays
										.map((person) => person.fullName)
										.join(", ")}
								</strong>
								.
							</span>
						</p>
					)}
				</>
			)}
		</section>
	);
}
