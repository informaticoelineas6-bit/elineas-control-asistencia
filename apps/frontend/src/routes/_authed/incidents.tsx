import { createFileRoute } from "@tanstack/react-router";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { MyIncidentsPanel } from "#/modules/incidents/my-incidents-panel.tsx";

const PATH = "/incidents" as const;

export const Route = createFileRoute("/_authed/incidents")({
	component: () => (
		<RequireRole path={PATH}>
			<IncidentsPage />
		</RequireRole>
	),
});

/**
 * "Incidencias" (spec 12 §6, lado del empleado).
 *
 * La spec 05 §3 llamaba a esta ruta `/issues` y la 12 nombra su API
 * `/incidents`: eran **dos palabras inglesas para la misma cosa**, y con la
 * tabla, el tipo, el servicio y el módulo llamándose *incident*, la ruta se
 * unifica en `/incidents`. La etiqueta sigue siendo *Incidencias*, que es lo que
 * lee una persona (spec 05 §7: la ruta nombra el recurso, la etiqueta habla de
 * la relación con él).
 *
 * Está en el grupo *Personal* y la ve **cualquier rol**, incluido el gestor
 * global que no marca: al contrario que en vacaciones, la spec no invoca RN-03.4
 * aquí (§7 dice "autenticado"), y una incidencia no consume nada ni cambia
 * ningún cálculo. La bandeja de revisión no está aquí: vive en `/team`, con el
 * resto de lo que un jefe decide sobre su gente.
 */
function IncidentsPage() {
	return (
		<div className="max-w-3xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Incidencias</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Reporta un problema con tu marcaje y sigue en qué queda.
				</p>
			</div>

			<MyIncidentsPanel />
		</div>
	);
}
