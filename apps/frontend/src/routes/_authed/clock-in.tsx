import { createFileRoute } from "@tanstack/react-router";
import { ClockInPanel } from "#/modules/attendance/clock-in-panel.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/clock-in" as const;

export const Route = createFileRoute("/_authed/clock-in")({
	component: () => (
		<RequireRole path={PATH}>
			<ClockInPage />
		</RequireRole>
	),
});

/**
 * Marcar (spec 09 §5).
 *
 * Es el destino por defecto del **EmployeeShell** de la spec 05 §3, que todavía no
 * existe: hoy la pantalla vive dentro del shell de administración, pero está hecha
 * en una columna estrecha y con el botón grande, para que al llegar la barra
 * inferior no haya que rehacerla.
 */
function ClockInPage() {
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Marcar</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Tu entrada y tu salida, con la ubicación que valida el servidor.
				</p>
			</div>

			<ClockInPanel />
		</div>
	);
}
