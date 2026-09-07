import { createFileRoute } from "@tanstack/react-router";
import { RequireRole } from "#/modules/auth/require-role.tsx";
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
 * Empieza con **una sola pieza**, las vacaciones de la spec 11 — igual que
 * `/settings` empezó con una sola pestaña en la spec 06 y fue creciendo—: las
 * incidencias (spec 12) y la justificación de ausencias (spec 13) se añaden
 * aquí cuando existan, no antes. Por eso no hay pestañas todavía: una pestaña
 * sola no es una pestaña, es la página.
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
		</div>
	);
}
