import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { rolesWithAccess } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/logs" as const;

export const Route = createFileRoute("/_authed/logs")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Logs"
				description="Registro de auditoría global del sistema."
				roles={rolesWithAccess(PATH)}
				spec="18-auditoria"
			/>
		</RequireRole>
	),
});
