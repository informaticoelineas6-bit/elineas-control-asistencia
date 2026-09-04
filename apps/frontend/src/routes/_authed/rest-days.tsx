import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
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
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { myRestScheduleQueryOptions } from "#/modules/rest/api.ts";
import { RestGroupsPanel } from "#/modules/rest/rest-groups-panel.tsx";
import { TeamRestCalendar } from "#/modules/rest/team-rest-calendar.tsx";

const PATH = "/rest-days" as const;

export const Route = createFileRoute("/_authed/rest-days")({
	component: () => (
		<RequireRole path={PATH}>
			<RestDaysPage />
		</RequireRole>
	),
});

/**
 * Descansos del equipo (spec 10 §7).
 *
 * Es una ruta propia y no una pestaña de Configuración por la matriz de la §4:
 * **asignar personas a un grupo es de `department_head`**, y Configuración
 * empieza en `global_manager`. Meterlo allí habría dejado al jefe sin la única
 * operación de descansos que le corresponde.
 *
 * Los descansos **propios** no están aquí: viven en *Mi perfil*, donde la spec 05
 * §3 los coloca y donde los busca quien sólo tiene los suyos.
 */
function RestDaysPage() {
	const session = useQuery(sessionQueryOptions());
	const departments = useQuery(
		departmentsQueryOptions({ includePaused: true }),
	);
	// Los límites vigentes (separación mínima y número por semana) salen del mismo
	// endpoint que usa el selector del empleado: son globales, ya acotados al
	// departamento de quien pregunta, y así el aviso en vivo del formulario de un
	// grupo dice lo mismo que el del formulario individual.
	const mine = useQuery(myRestScheduleQueryOptions());

	const role = session.data?.effectiveRole;
	const managed = session.data?.managedDepartmentIds ?? [];
	const isManager = role === "global_manager" || role === "superadmin";

	const visible = (departments.data ?? []).filter(
		(department) => isManager || managed.includes(department.id),
	);

	const [departmentId, setDepartmentId] = useState("");
	const selected =
		visible.find((department) => department.id === departmentId) ??
		visible.at(0) ??
		null;

	const loading = departments.isPending || session.isPending || mine.isPending;

	return (
		<div className="max-w-6xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Descansos</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Qué días no trabaja cada persona. Un día de descanso no se puede
					marcar y no cuenta como ausencia.
				</p>
			</div>

			<InlineError error={departments.error ?? mine.error} />

			{loading ? (
				<div className="space-y-4">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-64 w-full" />
				</div>
			) : visible.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/30 p-12 text-center">
					<Building2 className="size-8 text-placeholder" />
					<div>
						<h2 className="font-medium">No gestionas ningún departamento</h2>
						<p className="mt-1 max-w-sm text-sm text-muted-foreground">
							Los descansos se organizan por departamento. Tus propios días de
							descanso están en <strong>Mi perfil</strong>.
						</p>
					</div>
				</div>
			) : (
				selected && (
					<>
						<div className="flex flex-wrap items-end gap-4 rounded-xl border p-4">
							<div className="min-w-64 space-y-2">
								<Label htmlFor="rest-department">Departamento</Label>
								<Select value={selected.id} onValueChange={setDepartmentId}>
									<SelectTrigger id="rest-department" className="w-full">
										<SelectValue placeholder="Elige un departamento" />
									</SelectTrigger>
									<SelectContent>
										{visible.map((department) => (
											<SelectItem key={department.id} value={department.id}>
												{department.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="flex flex-wrap items-center gap-2 pb-1 text-sm text-muted-foreground">
								<span>
									{selected.activeMemberCount === 1
										? "1 miembro activo"
										: `${selected.activeMemberCount} miembros activos`}
								</span>
								<Badge
									variant={selected.restGroupsEnabled ? "secondary" : "outline"}
								>
									{selected.restGroupsEnabled
										? "Descansos por grupos"
										: "Descansos individuales"}
								</Badge>
							</div>
						</div>

						<div className="space-y-8">
							<TeamRestCalendar key={selected.id} department={selected} />
							{mine.data && (
								<RestGroupsPanel
									key={`groups-${selected.id}`}
									department={selected}
									limits={mine.data.limits}
									canManageGroups={isManager}
								/>
							)}
						</div>
					</>
				)
			)}
		</div>
	);
}
