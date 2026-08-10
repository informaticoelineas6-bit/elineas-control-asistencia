import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { ROUTE_ROLES } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/bitacora" as const;

export const Route = createFileRoute("/_authed/bitacora")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Bitácora"
				description="Registro de auditoría global del sistema."
				roles={ROUTE_ROLES[PATH]}
				spec="18-auditoria"
			/>
		</RequireRole>
	),
});
