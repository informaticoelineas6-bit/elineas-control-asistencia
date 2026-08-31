import type { AppConfigValues, DepartmentSummary } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Building2, PauseCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { departmentScheduleQueryOptions } from "#/modules/schedules/api.ts";
import { ScheduleForm } from "#/modules/schedules/schedule-form.tsx";
import { WorkCalendarEditor } from "#/modules/schedules/work-calendar-editor.tsx";

/**
 * Pestaña *Horarios y calendario* de Configuración (spec 07 §6).
 *
 * El horario y el calendario son **por departamento** (RN-07.1), así que lo primero
 * de la pantalla es elegir uno: sin ese selector habría que ir a la pantalla de
 * departamentos y volver por cada cambio.
 *
 * Las dos piezas van juntas y en este orden porque la pregunta que responden es la
 * misma en dos escalas: el horario dice *a qué hora* y el calendario, *qué días*.
 */
export function SchedulesTab({
	departments,
	config,
}: {
	departments: DepartmentSummary[];
	config: AppConfigValues;
}) {
	const [departmentId, setDepartmentId] = useState(
		() => departments.at(0)?.id ?? "",
	);
	const department = departments.find((each) => each.id === departmentId);

	const schedule = useQuery({
		...departmentScheduleQueryOptions(departmentId),
		enabled: departmentId !== "",
	});

	if (departments.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/30 p-12 text-center">
				<Building2 className="size-8 text-placeholder" />
				<div>
					<h2 className="font-medium">Todavía no hay departamentos</h2>
					<p className="mt-1 max-w-sm text-sm text-muted-foreground">
						El horario y el calendario laboral son de un departamento. Crea el
						primero en <strong>Departamentos</strong> y vuelve aquí.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-end gap-4 rounded-xl border p-4">
				<div className="min-w-64 space-y-2">
					<Label htmlFor="schedule-department">Departamento</Label>
					<Select value={departmentId} onValueChange={setDepartmentId}>
						<SelectTrigger id="schedule-department" className="w-full">
							<SelectValue placeholder="Elige un departamento" />
						</SelectTrigger>
						<SelectContent>
							{departments.map((each) => (
								<SelectItem key={each.id} value={each.id}>
									{each.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{department && (
					<div className="flex flex-wrap items-center gap-2 pb-1 text-sm text-muted-foreground">
						<span>
							{department.activeMemberCount === 1
								? "1 miembro activo"
								: `${department.activeMemberCount} miembros activos`}
						</span>
						{/* RN-07.9: con el departamento en pausa, el horario da igual —
						    ningún miembro puede marcar hasta que se reanude. */}
						{department.isPaused && (
							<Badge variant="warning">
								<PauseCircle />
								En pausa
							</Badge>
						)}
					</div>
				)}
			</div>

			{department?.isPaused && (
				<p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					Este departamento está en pausa: mientras lo esté, sus miembros no
					pueden marcar aunque el horario sea correcto.
				</p>
			)}

			<InlineError error={schedule.error} />

			{department && schedule.isPending && <Skeleton className="h-96 w-full" />}

			{department && !schedule.isPending && (
				<>
					<ScheduleForm
						key={department.id}
						department={department}
						schedule={schedule.data ?? null}
						config={config}
					/>
					<WorkCalendarEditor
						key={`calendar-${department.id}`}
						department={department}
						config={config}
					/>
				</>
			)}
		</div>
	);
}
