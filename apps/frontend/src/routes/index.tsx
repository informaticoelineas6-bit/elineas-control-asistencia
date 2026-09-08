import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { defaultRouteFor } from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { useShell } from "#/modules/shells/use-shell.ts";

export const Route = createFileRoute("/")({ component: IndexPage });

/**
 * Raíz: al panel si hay sesión, al login si no.
 *
 * La comprobación es en cliente porque las cookies de sesión son del origen del
 * backend (ver `modules/auth/session.ts`).
 */
function IndexPage() {
	const navigate = useNavigate();
	const session = useQuery(sessionQueryOptions());
	const shell = useShell(session.data?.effectiveRole);

	useEffect(() => {
		if (session.isPending) return;
		if (!session.data) {
			void navigate({ to: "/login", replace: true });
			return;
		}
		void navigate({
			// RN-05.4 — El destino por defecto del rol **y del shell**.
			to: session.data.profile.isComplete
				? defaultRouteFor(session.data.effectiveRole, shell)
				: "/pending-account",
			replace: true,
		});
	}, [session.isPending, session.data, navigate, shell]);

	return (
		<div className="min-h-svh space-y-4 p-6">
			<Skeleton className="h-8 w-56" />
			<Skeleton className="h-40 w-full max-w-2xl" />
		</div>
	);
}
