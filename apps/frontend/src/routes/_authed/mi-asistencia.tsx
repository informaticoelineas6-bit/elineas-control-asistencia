import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { ROUTE_ROLES } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/mi-asistencia" as const;

export const Route = createFileRoute("/_authed/mi-asistencia")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Mi asistencia"
				description="Tus marcajes, tu historial y tus descansos."
				roles={ROUTE_ROLES[PATH]}
				spec="09-marcaje-asistencia"
			/>
		</RequireRole>
	),
});
