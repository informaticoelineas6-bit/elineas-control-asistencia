import { createFileRoute } from "@tanstack/react-router";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { DailyPanel } from "#/modules/dashboard/daily-panel.tsx";

const PATH = "/daily" as const;

export const Route = createFileRoute("/_authed/daily")({
	component: () => (
		<RequireRole path={PATH}>
			<DailyAttendancePage />
		</RequireRole>
	),
});

/**
 * "Asistencia del día" (spec 15 §5.2 y §5.3).
 *
 * Una sola ruta para los dos paneles que la spec describe —el de departamento y
 * el global—, porque **son la misma vista con distinto alcance** y ella misma
 * pide no hacer dos páginas. La etiqueta no dice "de mi departamento" ni
 * "global" por lo mismo: quien la abre ve su ámbito, y el ámbito no se elige
 * aquí.
 *
 * Va en el grupo *Gestión* junto a *Mi equipo*, y la diferencia entre las dos es
 * clara: aquí se **mira** un día de todo el ámbito; allí se **decide** sobre lo
 * que quedó pendiente.
 */
function DailyAttendancePage() {
	return (
		<div className="max-w-5xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Asistencia del día</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Cómo va hoy tu gente, persona a persona. Para clasificar una ausencia,
					en <span className="font-medium text-foreground">Mi equipo</span>.
				</p>
			</div>

			<DailyPanel />
		</div>
	);
}
