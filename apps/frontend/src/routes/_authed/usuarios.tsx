import { createFileRoute } from "@tanstack/react-router";
import { SectionPlaceholder } from "#/components/section-placeholder.tsx";
import { ROUTE_ROLES } from "#/modules/auth/navigation.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/usuarios" as const;

export const Route = createFileRoute("/_authed/usuarios")({
	component: () => (
		<RequireRole path={PATH}>
			<SectionPlaceholder
				title="Usuarios"
				description="Perfiles de negocio: departamento, teléfono y estado de la cuenta."
				roles={ROUTE_ROLES[PATH]}
				spec="02-usuarios-y-perfiles"
			/>
		</RequireRole>
	),
});
