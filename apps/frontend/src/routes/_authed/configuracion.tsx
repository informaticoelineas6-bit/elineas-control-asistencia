import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { ROUTE_ROLES } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/configuracion" as const;

export const Route = createFileRoute("/_authed/configuracion")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Configuración"
				description="Parámetros globales, horarios, sedes y geocerca."
				roles={ROUTE_ROLES[PATH]}
				spec="06-configuracion-global"
			/>
		</RequireRole>
	),
});
