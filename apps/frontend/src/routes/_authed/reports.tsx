import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { rolesWithAccess } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/reports" as const;

export const Route = createFileRoute("/_authed/reports")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Reportes"
				description="Reporte mensual de asistencia. Departamental para un jefe, global para gestión."
				roles={rolesWithAccess(PATH)}
				spec="16-reporteria-mensual"
			/>
		</RequireRole>
	),
});
