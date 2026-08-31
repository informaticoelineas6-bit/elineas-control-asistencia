import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Timer } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { AttendanceHistory } from "#/modules/attendance/history.tsx";
import { canAccess } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";

const PATH = "/attendance" as const;

export const Route = createFileRoute("/_authed/attendance")({
	component: () => (
		<RequireRole path={PATH}>
			<AttendancePage />
		</RequireRole>
	),
});

/**
 * Mi asistencia (spec 09 §5, "Historial"): el mes en curso, día por día.
 *
 * Los datos llegan **agregados desde el servidor** (spec 15 §4): aquí no se calcula
 * ningún estado. La vista de "Mi semana" del móvil (spec 05 §3) reutilizará estos
 * mismos componentes cuando llegue el EmployeeShell.
 */
function AttendancePage() {
	const session = useQuery(sessionQueryOptions());
	const canClockIn = canAccess(session.data?.effectiveRole, "/clock-in");

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold">Mi asistencia</h1>
					<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
						Tu historial, día por día. Un día sin salida queda incompleto a
						propósito: no se inventa una hora. Si algo no cuadra, se corrige por
						incidencia.
					</p>
				</div>
				{canClockIn && (
					<Button asChild variant="outline">
						<Link to="/clock-in">
							<Timer />
							Ir a marcar
						</Link>
					</Button>
				)}
			</div>

			<AttendanceHistory />
		</div>
	);
}
