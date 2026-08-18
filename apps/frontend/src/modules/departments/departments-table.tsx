import type { DepartmentSummary } from "@elineas/validations";
import {
	CalendarClock,
	Ellipsis,
	Pencil,
	Play,
	Shield,
	ShieldOff,
	Trash2,
	Users,
} from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { PauseIcon } from "#/modules/departments/pause-icon.tsx";

/**
 * Tabla de gestión de departamentos (spec 01 §7): nombre, nº de miembros, estado
 * de pausa y grupos de descanso, con las acciones en un desplegable por fila.
 *
 * Esta pantalla hace **sólo** el CRUD de departamentos. En el legacy
 * (`DepartmentsManagement.tsx`) mezclaba tres cosas —departamentos, grupos de
 * descanso y responsabilidades multi-departamento— y se decidió separarlas en tres
 * vistas: los grupos de descanso viven en la spec 10 y las responsabilidades en la
 * 02/03.
 */

export type DepartmentAction =
	| "rename"
	| "members"
	| "rest-groups"
	| "pause"
	| "resume"
	| "delete"
	| "set-global-manager"
	| "clear-global-manager";

export function DepartmentsTable({
	departments,
	onAction,
	busyId,
}: {
	departments: DepartmentSummary[];
	onAction: (action: DepartmentAction, department: DepartmentSummary) => void;
	busyId: string | null;
}) {
	return (
		<div className="rounded-xl border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="pl-4">Departamento</TableHead>
						<TableHead>Miembros</TableHead>
						<TableHead>Descansos</TableHead>
						<TableHead className="w-12 pr-4 text-right">Acciones</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{departments.map((department) => (
						<TableRow key={department.id} data-paused={department.isPaused}>
							<TableCell className="max-w-md pl-4 whitespace-normal">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{department.name}</span>
									{/* RN-01.7: un departamento en pausa se distingue en todos
									    los listados, con su motivo a la vista. */}
									{department.isPaused && (
										<Badge variant="warning">
											<PauseIcon />
											En pausa
										</Badge>
									)}
									{department.isGlobalManagerDepartment && (
										<Badge variant="secondary">
											<Shield />
											Gestores globales
										</Badge>
									)}
								</div>
								{department.isPaused && department.pauseReason && (
									<p className="mt-1 text-xs text-muted-foreground">
										{department.pauseReason}
									</p>
								)}
							</TableCell>

							<TableCell>
								<span className="tabular-nums">
									{department.activeMemberCount}
								</span>
								{department.memberCount !== department.activeMemberCount && (
									<span className="text-muted-foreground">
										{" "}
										de {department.memberCount}
									</span>
								)}
							</TableCell>

							<TableCell className="text-muted-foreground">
								{department.restGroupsEnabled ? "Por grupos" : "Individuales"}
							</TableCell>

							<TableCell className="pr-4 text-right">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={busyId === department.id}
											aria-label={`Acciones de ${department.name}`}
										>
											<Ellipsis />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-56">
										<DropdownMenuLabel>{department.name}</DropdownMenuLabel>
										<DropdownMenuSeparator />

										<DropdownMenuItem
											onSelect={() => onAction("members", department)}
										>
											<Users />
											Ver miembros
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() => onAction("rename", department)}
										>
											<Pencil />
											Renombrar
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() => onAction("rest-groups", department)}
										>
											<CalendarClock />
											{department.restGroupsEnabled
												? "Desactivar grupos de descanso"
												: "Activar grupos de descanso"}
										</DropdownMenuItem>

										<DropdownMenuSeparator />

										{department.isPaused ? (
											<DropdownMenuItem
												onSelect={() => onAction("resume", department)}
											>
												<Play />
												Reanudar
											</DropdownMenuItem>
										) : (
											<DropdownMenuItem
												onSelect={() => onAction("pause", department)}
											>
												<PauseIcon />
												Pausar
											</DropdownMenuItem>
										)}

										{/* RN-03.6: a este departamento se mueven los perfiles con
										    rol global_manager al iniciar sesión. */}
										{department.isGlobalManagerDepartment ? (
											<DropdownMenuItem
												onSelect={() =>
													onAction("clear-global-manager", department)
												}
											>
												<ShieldOff />
												Quitar como depto. de gestores
											</DropdownMenuItem>
										) : (
											<DropdownMenuItem
												onSelect={() =>
													onAction("set-global-manager", department)
												}
											>
												<Shield />
												Usar como depto. de gestores
											</DropdownMenuItem>
										)}

										<DropdownMenuSeparator />

										<DropdownMenuItem
											variant="destructive"
											onSelect={() => onAction("delete", department)}
										>
											<Trash2 />
											Eliminar
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
