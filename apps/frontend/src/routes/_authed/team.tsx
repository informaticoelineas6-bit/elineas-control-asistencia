import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { rolesWithAccess } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/team" as const;

export const Route = createFileRoute("/_authed/team")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Mi equipo"
				description="Los departamentos que gestionas: incidencias, ausencias y vacaciones de tu ámbito."
				roles={rolesWithAccess(PATH)}
				spec="12-incidencias"
			/>
		</RequireRole>
	),
});
