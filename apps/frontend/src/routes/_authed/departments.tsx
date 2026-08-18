import type { DepartmentSummary } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { useUpdateConfig } from "#/modules/config/api.ts";
import {
	departmentsQueryOptions,
	useResumeDepartment,
} from "#/modules/departments/api.ts";
import {
	DeleteDepartmentDialog,
	DepartmentFormDialog,
	MembersDialog,
	PauseDepartmentDialog,
	RestGroupsDialog,
} from "#/modules/departments/department-dialogs.tsx";
import {
	type DepartmentAction,
	DepartmentsTable,
} from "#/modules/departments/departments-table.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";

const PATH = "/departments" as const;

export const Route = createFileRoute("/_authed/departments")({
	component: () => (
		<RequireRole path={PATH}>
			<DepartmentsPage />
		</RequireRole>
	),
});

/** Acciones que abren diálogo, frente a las que se ejecutan directamente. */
type OpenDialog =
	| { kind: "create" }
	| { kind: "rename"; department: DepartmentSummary }
	| { kind: "pause"; department: DepartmentSummary }
	| { kind: "rest-groups"; department: DepartmentSummary }
	| { kind: "delete"; department: DepartmentSummary }
	| { kind: "members"; department: DepartmentSummary }
	| null;

/**
 * Gestión de departamentos (spec 01).
 *
 * El guard de rol es UX: el backend valida `global_manager` en cada mutación
 * (RN-03.3). Aquí sólo se evita ofrecer algo que iba a responder 403.
 */
function DepartmentsPage() {
	const departments = useQuery(
		departmentsQueryOptions({ includePaused: true }),
	);
	const [dialog, setDialog] = useState<OpenDialog>(null);
	const [actionError, setActionError] = useState<Error | null>(null);

	const resume = useResumeDepartment();
	const updateConfig = useUpdateConfig();

	// Las acciones directas se marcan por fila para deshabilitar su menú mientras
	// están en vuelo: sin eso, dos clics seguidos mandan dos peticiones.
	// Se mira una mutación a la vez, porque `variables` conserva las de la última
	// llamada aunque ya haya terminado: encadenarlas con `??` acabaría marcando la
	// fila equivocada.
	const busyId = resume.isPending
		? (resume.variables?.id ?? null)
		: updateConfig.isPending
			? (updateConfig.variables?.global_manager_department_id ?? null)
			: null;

	const onAction = (
		action: DepartmentAction,
		department: DepartmentSummary,
	) => {
		setActionError(null);

		switch (action) {
			case "rename":
			case "pause":
			case "rest-groups":
			case "delete":
			case "members":
				setDialog({ kind: action, department });
				return;
			case "resume":
				resume.mutate({ id: department.id }, { onError: setActionError });
				return;
			case "set-global-manager":
				updateConfig.mutate(
					{ global_manager_department_id: department.id },
					{ onError: setActionError },
				);
				return;
			case "clear-global-manager":
				updateConfig.mutate(
					{ global_manager_department_id: null },
					{ onError: setActionError },
				);
				return;
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold">Departamentos</h1>
					<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
						El ancla organizativa del sistema: de cada departamento cuelgan los
						perfiles, los horarios, los descansos y el alcance de los reportes.
					</p>
				</div>
				<Button onClick={() => setDialog({ kind: "create" })}>
					<Plus />
					Nuevo departamento
				</Button>
			</div>

			<InlineError error={actionError} />

			{departments.isPending && (
				<div className="space-y-2">
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
				</div>
			)}

			<InlineError error={departments.error} />

			{departments.data?.length === 0 && (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/30 p-12 text-center">
					<Building2 className="size-8 text-placeholder" />
					<div>
						<h2 className="font-medium">Todavía no hay departamentos</h2>
						<p className="mt-1 max-w-sm text-sm text-muted-foreground">
							Crea el primero para poder asignar personas. Hasta entonces, los
							perfiles quedan incompletos y nadie puede registrar asistencia.
						</p>
					</div>
					<Button
						variant="outline"
						onClick={() => setDialog({ kind: "create" })}
					>
						<Plus />
						Crear departamento
					</Button>
				</div>
			)}

			{departments.data && departments.data.length > 0 && (
				<DepartmentsTable
					departments={departments.data}
					onAction={onAction}
					busyId={busyId}
				/>
			)}

			{dialog?.kind === "create" && (
				<DepartmentFormDialog
					department={null}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "rename" && (
				<DepartmentFormDialog
					key={dialog.department.id}
					department={dialog.department}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "pause" && (
				<PauseDepartmentDialog
					key={dialog.department.id}
					department={dialog.department}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "rest-groups" && (
				<RestGroupsDialog
					key={dialog.department.id}
					department={dialog.department}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "delete" && (
				<DeleteDepartmentDialog
					key={dialog.department.id}
					department={dialog.department}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "members" && (
				<MembersDialog
					key={dialog.department.id}
					department={dialog.department}
					onClose={() => setDialog(null)}
				/>
			)}
		</div>
	);
}
