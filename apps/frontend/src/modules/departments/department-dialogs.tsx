import type { DepartmentSummary } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	departmentMembersQueryOptions,
	useCreateDepartment,
	useDeleteDepartment,
	usePauseDepartment,
	useUpdateDepartment,
} from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Diálogos de la gestión de departamentos (spec 01 §7).
 *
 * Cada uno se monta sólo mientras está abierto, así que su estado interno arranca
 * limpio en cada apertura y no hay que sincronizarlo con efectos.
 *
 * Los errores se pintan **dentro del diálogo**, con el mensaje que manda el
 * backend: "ya existe un departamento con ese nombre" o "hay 3 personas
 * asignadas" sólo tienen sentido junto al formulario que los provocó.
 */

type DialogProps = { onClose: () => void };

/** Crear o renombrar: el mismo formulario, un solo campo (RN-01.1). */
export function DepartmentFormDialog({
	department,
	onClose,
}: DialogProps & { department: DepartmentSummary | null }) {
	const [name, setName] = useState(department?.name ?? "");
	const create = useCreateDepartment();
	const update = useUpdateDepartment();
	const mutation = department ? update : create;

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (department) {
			update.mutate({ id: department.id, name }, { onSuccess: onClose });
		} else {
			create.mutate({ name }, { onSuccess: onClose });
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>
							{department ? "Renombrar departamento" : "Nuevo departamento"}
						</DialogTitle>
						<DialogDescription>
							{department
								? "El nombre es lo único que cambia; los miembros y su historial se quedan como están."
								: "De este departamento colgarán perfiles, horarios y descansos."}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-2">
						<Label htmlFor="department-name">Nombre</Label>
						<Input
							id="department-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Expedición"
							maxLength={80}
							required
							autoFocus
						/>
					</div>

					<InlineError error={mutation.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button
							type="submit"
							disabled={mutation.isPending || name.trim().length === 0}
						>
							{mutation.isPending && <Loader2 className="animate-spin" />}
							{department ? "Guardar" : "Crear"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** RN-01.3: el motivo es obligatorio, y es lo que verá el empleado al intentar marcar. */
export function PauseDepartmentDialog({
	department,
	onClose,
}: DialogProps & { department: DepartmentSummary }) {
	const [reason, setReason] = useState("");
	const pause = usePauseDepartment();

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		pause.mutate({ id: department.id, reason }, { onSuccess: onClose });
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Pausar {department.name}</DialogTitle>
						<DialogDescription>
							Sus {department.activeMemberCount} miembros activos no podrán
							registrar asistencia y verán el motivo al intentarlo. Vacaciones,
							incidencias y consultas de historial siguen funcionando con
							normalidad.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-2">
						<Label htmlFor="pause-reason">Motivo</Label>
						<Textarea
							id="pause-reason"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="Cierre temporal por inventario anual"
							maxLength={500}
							rows={3}
							required
						/>
						<p className="text-xs text-muted-foreground">
							Se avisa a los miembros y queda registrado en la bitácora.
						</p>
					</div>

					<InlineError error={pause.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button
							type="submit"
							disabled={pause.isPending || reason.trim().length === 0}
						>
							{pause.isPending && <Loader2 className="animate-spin" />}
							Pausar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * RN-01.6: apagar los grupos de descanso **no borra** los grupos existentes.
 * Advertirlo aquí es parte de la regla, no un detalle de cortesía.
 */
export function RestGroupsDialog({
	department,
	onClose,
}: DialogProps & { department: DepartmentSummary }) {
	const update = useUpdateDepartment();
	const enabling = !department.restGroupsEnabled;

	const onConfirm = () => {
		update.mutate(
			{ id: department.id, restGroupsEnabled: enabling },
			{ onSuccess: onClose },
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{enabling ? "Activar" : "Desactivar"} grupos de descanso
					</DialogTitle>
					<DialogDescription>
						{enabling
							? `Los descansos de ${department.name} pasarán a gestionarse por grupos en vez de persona a persona.`
							: `Los descansos de ${department.name} volverán a gestionarse persona a persona. Los grupos que ya existan no se borran: simplemente dejan de usarse para resolver los descansos, y vuelven a aplicarse si reactivas esta opción.`}
					</DialogDescription>
				</DialogHeader>

				<InlineError error={update.error} />

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancelar
					</Button>
					<Button onClick={onConfirm} disabled={update.isPending}>
						{update.isPending && <Loader2 className="animate-spin" />}
						{enabling ? "Activar" : "Desactivar"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * RN-01.2: si hay gente asignada, el backend rechaza el borrado y no toca nada.
 * El diálogo lo anticipa cuando puede, pero **la barrera es el servidor**: los
 * conteos que ve el navegador pueden estar viejos.
 */
export function DeleteDepartmentDialog({
	department,
	onClose,
}: DialogProps & { department: DepartmentSummary }) {
	const remove = useDeleteDepartment();
	const blocked = department.memberCount > 0;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Eliminar {department.name}</DialogTitle>
					<DialogDescription>
						{blocked
							? `No se puede eliminar: hay ${department.memberCount} ${department.memberCount === 1 ? "persona" : "personas"} asignadas, contando las desactivadas. Reasígnalas a otro departamento y vuelve a intentarlo.`
							: "Esta acción no se puede deshacer. Queda registrada en la bitácora."}
					</DialogDescription>
				</DialogHeader>

				<InlineError error={remove.error} />

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						{blocked ? "Entendido" : "Cancelar"}
					</Button>
					{!blocked && (
						<Button
							variant="destructive"
							disabled={remove.isPending}
							onClick={() =>
								remove.mutate({ id: department.id }, { onSuccess: onClose })
							}
						>
							{remove.isPending && <Loader2 className="animate-spin" />}
							Eliminar
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Miembros del departamento. Sin datos salariales: no salen por esta API. */
export function MembersDialog({
	department,
	onClose,
}: DialogProps & { department: DepartmentSummary }) {
	const members = useQuery(departmentMembersQueryOptions(department.id));

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[80svh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Miembros de {department.name}</DialogTitle>
					<DialogDescription>
						{department.memberCount === 0
							? "Todavía no hay nadie asignado."
							: `${department.activeMemberCount} de ${department.memberCount} activos.`}
					</DialogDescription>
				</DialogHeader>

				{members.isPending && (
					<div className="space-y-2">
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				)}

				{members.error && <InlineError error={members.error} />}

				{members.data && members.data.length > 0 && (
					<ul className="divide-y rounded-md border">
						{members.data.map((member) => (
							<li
								key={member.id}
								className="flex items-center justify-between gap-3 p-3 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium">{member.fullName}</p>
									<p className="truncate text-xs text-muted-foreground">
										{member.email}
									</p>
								</div>
								{!member.isActive && (
									<Badge variant="outline">Desactivado</Badge>
								)}
							</li>
						))}
					</ul>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cerrar
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
