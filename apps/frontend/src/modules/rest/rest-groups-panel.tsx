import {
	type DepartmentSummary,
	describeRestDays,
	type RestGroup,
	type RestLimits,
	restDaysIssue,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import {
	CircleAlert,
	Loader2,
	Plus,
	Power,
	Trash2,
	TriangleAlert,
	UserPlus,
	Users,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
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
import { departmentMembersQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	restGroupsQueryOptions,
	useCreateRestGroup,
	useDeleteRestGroup,
	useSetRestGroupMembers,
	useUpdateRestGroup,
} from "#/modules/rest/api.ts";
import { WeekdayPicker } from "#/modules/rest/weekday-picker.tsx";

/**
 * Grupos de descanso de un departamento (spec 10 §7).
 *
 * Sólo tiene sentido con `rest_groups_enabled` en el departamento (RN-10.2), y eso
 * se dice arriba en vez de esconder el panel: un gestor que llega buscando los
 * grupos necesita saber que existen y que están apagados, no encontrarse una
 * pantalla vacía.
 *
 * Crear y editar es de `global_manager`; **asignar personas** es del jefe. El
 * componente recibe `canManageGroups` en vez de mirar el rol por su cuenta, para
 * que la misma pantalla sirva a los dos con las acciones que le tocan a cada uno —
 * y sigue siendo UX: el backend responde 403 igual (RN-03.3).
 */
export function RestGroupsPanel({
	department,
	limits,
	canManageGroups,
}: {
	department: DepartmentSummary;
	limits: RestLimits;
	canManageGroups: boolean;
}) {
	const groups = useQuery(restGroupsQueryOptions(department.id));
	const members = useQuery(departmentMembersQueryOptions(department.id));

	const create = useCreateRestGroup();
	const update = useUpdateRestGroup();
	const remove = useDeleteRestGroup();

	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<RestGroup | null>(null);
	const [assigning, setAssigning] = useState<RestGroup | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState<RestGroup | null>(
		null,
	);
	const [actionError, setActionError] = useState<Error | null>(null);

	const active = (groups.data ?? []).filter((group) => group.isActive);
	const retired = (groups.data ?? []).filter((group) => !group.isActive);

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="flex items-center gap-2 font-medium">
						<Users className="size-4" />
						Grupos de descanso
					</h3>
					<p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
						Para operaciones que rotan turnos: el grupo fija los días y las
						personas se asignan a un grupo. Mientras estén activados, la
						configuración individual de sus miembros no se aplica.
					</p>
				</div>
				{canManageGroups && (
					<Button
						type="button"
						size="sm"
						onClick={() => {
							setActionError(null);
							setCreating(true);
						}}
						disabled={!department.restGroupsEnabled}
					>
						<Plus />
						Nuevo grupo
					</Button>
				)}
			</div>

			{/*
			 * RN-01.6: apagar el interruptor no borra los grupos, sólo deja de usarlos.
			 * La advertencia va en los dos sentidos porque las dos direcciones sorprenden
			 * a alguien: apagado, los grupos que se ven aquí no hacen nada.
			 */}
			{!department.restGroupsEnabled && (
				<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
					<span>
						{department.name} tiene los grupos de descanso{" "}
						<strong>desactivados</strong>: manda la configuración individual de
						cada persona y estos grupos no se aplican. Se activan en{" "}
						<strong>Departamentos</strong>.
					</span>
				</p>
			)}

			<InlineError error={groups.error ?? actionError} />

			{groups.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : active.length === 0 && retired.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					Todavía no hay grupos en este departamento.
				</div>
			) : (
				<ul className="space-y-3">
					{[...active, ...retired].map((group) => (
						<li
							key={group.id}
							className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-4"
						>
							<div className="min-w-0">
								<p className="flex flex-wrap items-center gap-2 font-medium">
									{group.name}
									{!group.isActive && (
										<Badge variant="secondary">Retirado</Badge>
									)}
								</p>
								<p className="mt-0.5 text-sm text-muted-foreground">
									Descansa {describeRestDays(group.daysOfWeek)}.
								</p>
								<p className="mt-1 text-sm">
									{group.members.length === 0
										? "Sin nadie asignado."
										: group.members
												.map((member) => member.fullName)
												.join(" · ")}
								</p>
							</div>

							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={!group.isActive || !department.restGroupsEnabled}
									onClick={() => {
										setActionError(null);
										setAssigning(group);
									}}
								>
									<UserPlus />
									Asignar
								</Button>
								{canManageGroups && (
									<>
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() => {
												setActionError(null);
												setEditing(group);
											}}
										>
											Editar
										</Button>
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() => {
												setActionError(null);
												update.mutate(
													{ id: group.id, isActive: !group.isActive },
													{ onError: setActionError },
												);
											}}
										>
											<Power />
											{group.isActive ? "Retirar" : "Reactivar"}
										</Button>
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() => {
												setActionError(null);
												setConfirmingDelete(group);
											}}
										>
											<Trash2 />
											Eliminar
										</Button>
									</>
								)}
							</div>
						</li>
					))}
				</ul>
			)}

			{creating && (
				<GroupDialog
					title="Nuevo grupo de descanso"
					limits={limits}
					pending={create.isPending}
					error={create.error}
					onCancel={() => setCreating(false)}
					onSubmit={(values) =>
						create.mutate(
							{ departmentId: department.id, ...values },
							{ onSuccess: () => setCreating(false) },
						)
					}
				/>
			)}

			{editing && (
				<GroupDialog
					title={`Editar ${editing.name}`}
					initial={editing}
					limits={limits}
					pending={update.isPending}
					error={update.error}
					warnRetroactive={editing.members.length > 0}
					onCancel={() => setEditing(null)}
					onSubmit={(values) =>
						update.mutate(
							{ id: editing.id, ...values },
							{ onSuccess: () => setEditing(null) },
						)
					}
				/>
			)}

			{assigning && (
				<AssignDialog
					group={assigning}
					members={members.data ?? []}
					onClose={() => setAssigning(null)}
				/>
			)}

			<Dialog
				open={confirmingDelete !== null}
				onOpenChange={(open) => !open && setConfirmingDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Eliminar {confirmingDelete?.name ?? "el grupo"}
						</DialogTitle>
						<DialogDescription>
							Sólo se puede eliminar un grupo que nunca haya tenido a nadie. Si
							alguna vez tuvo miembros, forma parte de su historial de descansos
							y borrarlo cambiaría reportes ya cerrados: en ese caso, reasigna a
							su gente y retíralo.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmingDelete(null)}
						>
							Cancelar
						</Button>
						<Button
							type="button"
							disabled={remove.isPending}
							onClick={() => {
								if (!confirmingDelete) return;
								remove.mutate(
									{ id: confirmingDelete.id },
									{
										onSuccess: () => setConfirmingDelete(null),
										onError: (error) => {
											setActionError(error as Error);
											setConfirmingDelete(null);
										},
									},
								);
							}}
						>
							{remove.isPending && <Loader2 className="animate-spin" />}
							Eliminar
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}

/** Crear y editar comparten formulario: el cuerpo es el mismo. */
function GroupDialog({
	title,
	initial,
	limits,
	pending,
	error,
	warnRetroactive = false,
	onCancel,
	onSubmit,
}: {
	title: string;
	initial?: RestGroup;
	limits: RestLimits;
	pending: boolean;
	error: unknown;
	warnRetroactive?: boolean;
	onCancel: () => void;
	onSubmit: (values: { name: string; daysOfWeek: number[] }) => void;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [daysOfWeek, setDaysOfWeek] = useState<number[]>(
		initial?.daysOfWeek ?? [],
	);

	const issue = restDaysIssue(daysOfWeek, limits);
	const valid = name.trim().length > 0 && !issue;

	return (
		<Dialog open onOpenChange={(open) => !open && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						Los días del grupo son los descansos de todos sus miembros.
					</DialogDescription>
				</DialogHeader>

				<form
					id="rest-group-form"
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!valid) return;
						onSubmit({ name: name.trim(), daysOfWeek });
					}}
				>
					<div className="space-y-2">
						<Label htmlFor="rest-group-name">Nombre</Label>
						<Input
							id="rest-group-name"
							value={name}
							maxLength={60}
							placeholder="Grupo A"
							onChange={(event) => setName(event.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label>Días de descanso</Label>
						<WeekdayPicker
							value={daysOfWeek}
							onChange={setDaysOfWeek}
							disabled={pending}
						/>
					</div>

					{/*
					 * `rest_groups` no lleva vigencia (la §2 de la spec no se la da), así que
					 * cambiar los días de un grupo alcanza también a las fechas ya
					 * reportadas de sus miembros. Rotar turnos se hace creando otro grupo y
					 * reasignando, que es la operación que el historial sí fecha bien.
					 */}
					{warnRetroactive && (
						<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
							<TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
							Cambiar los días de un grupo con gente dentro cambia también sus
							días pasados, así que puede alterar reportes ya cerrados. Para
							rotar un turno, crea otro grupo y reasigna a las personas: así
							cada tramo queda fechado.
						</p>
					)}

					{issue && (
						<p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
							{issue}
						</p>
					)}

					<InlineError error={error} />
				</form>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancelar
					</Button>
					<Button
						type="submit"
						form="rest-group-form"
						disabled={!valid || pending}
					>
						{pending && <Loader2 className="animate-spin" />}
						Guardar
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Asignación de personas al grupo.
 *
 * Es un **reemplazo con fecha**: la lista describe quiénes son los miembros a
 * partir de esa fecha, y quien se destilda sale del grupo **ese día**, sin que se
 * le toque el pasado (RN-10.1). Por eso el campo de fecha está aquí y no escondido
 * en un menú: es lo que decide desde cuándo cuenta la rotación.
 */
function AssignDialog({
	group,
	members,
	onClose,
}: {
	group: RestGroup;
	members: readonly { id: string; fullName: string; isActive: boolean }[];
	onClose: () => void;
}) {
	const save = useSetRestGroupMembers();
	const [selected, setSelected] = useState<string[]>(() =>
		group.members.map((member) => member.userId),
	);
	const [effectiveFrom, setEffectiveFrom] = useState("");

	const eligible = members.filter((member) => member.isActive);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Asignar a {group.name}</DialogTitle>
					<DialogDescription>
						Descansa {describeRestDays(group.daysOfWeek)}. Quien quede sin
						marcar sale del grupo en la fecha indicada; sus días anteriores no
						cambian.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
						{eligible.length === 0 ? (
							<p className="p-2 text-sm text-muted-foreground">
								Este departamento no tiene personas activas.
							</p>
						) : (
							eligible.map((member) => (
								<label
									key={member.id}
									className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
								>
									<input
										type="checkbox"
										className="size-4 accent-primary"
										checked={selected.includes(member.id)}
										onChange={(event) =>
											setSelected((current) =>
												event.target.checked
													? [...current, member.id]
													: current.filter((id) => id !== member.id),
											)
										}
									/>
									{member.fullName}
								</label>
							))
						)}
					</div>

					<div className="max-w-56 space-y-2">
						<Label htmlFor="assign-effective-from">Desde cuándo</Label>
						<Input
							id="assign-effective-from"
							type="date"
							value={effectiveFrom}
							onChange={(event) => setEffectiveFrom(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">Vacío = desde hoy.</p>
					</div>

					<InlineError error={save.error} />
				</div>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Cancelar
					</Button>
					<Button
						type="button"
						disabled={save.isPending}
						onClick={() =>
							save.mutate(
								{
									id: group.id,
									userIds: selected,
									...(effectiveFrom ? { effectiveFrom } : {}),
								},
								{ onSuccess: onClose },
							)
						}
					>
						{save.isPending && <Loader2 className="animate-spin" />}
						Guardar asignación
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
