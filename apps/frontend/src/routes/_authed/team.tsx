import { createFileRoute } from "@tanstack/react-router";
import { AbsenceReviewPanel } from "#/modules/absences/absence-review-panel.tsx";
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
 * Creció como `/settings`, pieza a pieza: vacaciones (spec 11), incidencias
 * (spec 12) y ahora ausencias por clasificar (spec 13). Con eso, **las tres
 * bandejas de decisión de un jefe están en un solo sitio**, que es lo que el
 * legacy no tenía — allí las ausencias sólo se veían navegando día por día
 * (spec 13 §5).
 *
 * Siguen siendo **secciones apiladas y no pestañas**. Dos o tres pestañas
 * esconderían lo que espera por una decisión, y eso es justo lo contrario de
 * para qué existe esta página; el mismo criterio que `/profile`, que apila sus
 * tarjetas. El orden es por consecuencia: las ausencias van primero porque son
 * las únicas que mueven dinero (RN-13.4).
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

			<AbsenceReviewPanel />
			<IncidentReviewPanel />
			<VacationReviewPanel />
		</div>
	);
}
