import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { UserCog } from "lucide-react";
import { SignOutButton } from "#/components/app-sidebar.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";

export const Route = createFileRoute("/pending-account")({
	component: PendingAccountPage,
});

/**
 * Cuenta pendiente de configurar (RN-00.46 / RN-02.3).
 *
 * Consecuencia directa del alta en dos pasos: la cuenta y el rol se crean en el
 * Identity Server, y el perfil de negocio —empezando por el departamento— se
 * completa aquí. Entre ambos pasos la persona entra pero no puede marcar, y
 * tiene que enterarse de por qué en vez de encontrarse una pantalla vacía.
 */
function PendingAccountPage() {
	const session = useQuery(sessionQueryOptions());

	return (
		<main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
			<div className="w-full max-w-md space-y-6 rounded-xl border bg-background p-8 text-center">
				<div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted">
					<UserCog className="size-5" />
				</div>

				<div className="space-y-2">
					<h1 className="text-xl font-semibold">
						Tu cuenta está pendiente de configurar
					</h1>
					<p className="text-sm text-muted-foreground">
						Ya te reconocemos
						{session.data ? ` (${session.data.user.email})` : ""}, pero todavía
						no tienes departamento asignado. Hasta que un gestor lo complete no
						puedes registrar asistencia.
					</p>
					<p className="text-sm text-muted-foreground">
						Avísale a quien gestiona la asistencia de tu área; es un cambio de
						un minuto.
					</p>
				</div>

				<div className="flex justify-center gap-3">
					<Link
						to="/dashboard"
						className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-accent/60"
					>
						Reintentar
					</Link>
					<SignOutButton />
				</div>
			</div>
		</main>
	);
}
