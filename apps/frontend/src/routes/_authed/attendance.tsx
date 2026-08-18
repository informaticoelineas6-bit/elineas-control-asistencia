import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { rolesWithAccess } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/attendance" as const;

export const Route = createFileRoute("/_authed/attendance")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Mi asistencia"
				description="Tus marcajes, tu historial y tus descansos."
				roles={rolesWithAccess(PATH)}
				spec="09-marcaje-asistencia"
			/>
		</RequireRole>
	),
});
