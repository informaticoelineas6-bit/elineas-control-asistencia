import { createFileRoute } from "@tanstack/react-router";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { IncidentReviewPanel } from "#/modules/incidents/incident-review-panel.tsx";
import { VacationReviewPanel } from "#/modules/vacations/vacation-review-panel.tsx";

const PATH = "/team" as const;

export const Route = createFileRoute("/_authed/team")({
	component: () => (
		<RequireRole path={PATH}>
			<TeamPage />
		</RequireRole>
	),
});

/**
 * "Mi equipo" (`department_head` y por encima): lo que un jefe gestiona de su
 * gente, más allá de los descansos ([10](../../../../../packages/specs/10-descansos.md),
 * que tiene su propia ruta, `/rest-days`, por la misma razón que ésta no la
 * absorbió).
 *
 * Creció como `/settings`, pieza a pieza: las vacaciones de la spec 11 y ahora
 * las incidencias de la spec 12. La justificación de ausencias (spec 13) se
 * añade aquí cuando exista.
 *
 * Siguen siendo **secciones apiladas y no pestañas**. Dos pestañas esconderían
 * la mitad de lo que espera por una decisión, y eso es justo lo contrario de
 * para qué existe esta página; el mismo criterio que `/profile`, que apila sus
 * tarjetas. Cuando haya tres o cuatro bandejas y ninguna quepa en pantalla,
 * entonces sí.
 */
function TeamPage() {
	return (
		<div className="max-w-5xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Mi equipo</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Lo que hace falta decidir sobre tu gente.
				</p>
			</div>

			<VacationReviewPanel />
			<IncidentReviewPanel />
		</div>
	);
}
