import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { canAccess, type NavPath } from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";

/**
 * Guard de página: sólo pinta el contenido si el rol efectivo alcanza.
 *
 * Duplica lo que ya hace el filtrado del aside, y a propósito: alguien puede
 * llegar a una ruta escribiéndola en la barra de direcciones. Sigue siendo UX
 * (RN-03.3) — el backend responde 403 igualmente.
 */
export function RequireRole({
	path,
	children,
}: {
	path: NavPath;
	children: ReactNode;
}) {
	const session = useQuery(sessionQueryOptions());
	if (!session.data) return null;

	if (!canAccess(session.data.effectiveRole, path)) {
		return (
			<div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
				<ShieldAlert className="size-8 text-muted-foreground" />
				<h2 className="text-lg font-semibold">Sin acceso</h2>
				<p className="text-sm text-muted-foreground">
					Tu rol no tiene permiso para ver esta sección. Si crees que debería
					tenerlo, habla con quien administra los roles en el Identity Server.
				</p>
			</div>
		);
	}

	return <>{children}</>;
}
