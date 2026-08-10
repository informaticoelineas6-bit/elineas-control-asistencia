import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { ROUTE_ROLES } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/mi-equipo" as const;

export const Route = createFileRoute("/_authed/mi-equipo")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Mi equipo"
				description="Los departamentos que gestionas: incidencias, ausencias y vacaciones de tu ámbito."
				roles={ROUTE_ROLES[PATH]}
				spec="12-incidencias"
			/>
		</RequireRole>
	),
});
