import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { rolesWithAccess } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/payroll" as const;

export const Route = createFileRoute("/_authed/payroll")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Nómina"
				description="Ajustes de nómina derivados de la asistencia."
				roles={rolesWithAccess(PATH)}
				spec="17-nomina"
			/>
		</RequireRole>
	),
});
