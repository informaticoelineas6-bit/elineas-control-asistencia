import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { ROUTE_ROLES } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/nomina" as const;

export const Route = createFileRoute("/_authed/nomina")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Nómina"
				description="Ajustes de nómina derivados de la asistencia."
				roles={ROUTE_ROLES[PATH]}
				spec="17-nomina"
			/>
		</RequireRole>
	),
});
