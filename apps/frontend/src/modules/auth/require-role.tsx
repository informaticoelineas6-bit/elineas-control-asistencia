import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
	canAccess,
	defaultRouteFor,
	type NavPath,
} from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";

/**
 * Guard de página (spec 04 §6): equivalente al `ProtectedRoute` del legacy.
 *
 * Quien no tiene acceso **es redirigido** al destino por defecto de su rol, no se
 * queda mirando una pantalla de "sin acceso". Es lo que pide la spec y es lo
 * correcto: el caso real de esto es un `global_manager` abriendo `/marcar`, y
 * dejarlo en una pantalla muerta con un rol legítimo parece una avería.
 *
 * Las dos listas —`allowedRoles` y `excludedRoles`— viven en `navigation.ts`, de
 * donde salen también los enlaces del aside: filtrado y guard no pueden discrepar
 * porque son la misma tabla.
 *
 * **Por qué no `beforeLoad`.** La spec propone resolverlo ahí, pero las cookies
 * de sesión pertenecen al origen del backend y el SSR de esta app no las ve (ver
 * `session.ts`): un `beforeLoad` que consultara la sesión recibiría "no
 * autenticado" en cada render de servidor y redirigiría al login a todo el mundo.
 * Mientras frontend y backend estén en orígenes distintos —decisión abierta
 * §C.9.1 de la spec 00— el guard se resuelve en cliente, igual que el del layout.
 *
 * Y sigue siendo **UX, no seguridad** (RN-03.3): el backend responde 403 igual.
 */
export function RequireRole({
	path,
	children,
}: {
	path: NavPath;
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const session = useQuery(sessionQueryOptions());
	const role = session.data?.effectiveRole;
	const allowed = canAccess(role, path);

	useEffect(() => {
		if (!role || allowed) return;

		const fallback = defaultRouteFor(role);
		// Un rol sin acceso ni siquiera a su propio destino por defecto sería un
		// error de configuración del menú; mandarlo allí igualmente lo dejaría
		// rebotando entre dos rutas.
		if (fallback === path) return;

		void navigate({ to: fallback, replace: true });
	}, [role, allowed, path, navigate]);

	// "Cargando" no es "sin permiso": pintar el rechazo mientras llega la sesión
	// haría parpadear la pantalla en cada recarga (spec 04 §5).
	if (session.isPending) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-8 w-56" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	// Sin sesión no se decide nada aquí: el layout `_authed` ya está mandando al
	// login. Y sin acceso, tampoco: se está navegando fuera.
	if (!role || !allowed) return null;

	return <>{children}</>;
}
