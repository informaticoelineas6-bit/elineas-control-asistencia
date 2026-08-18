import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Compass, RotateCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button.tsx";
import { defaultRouteFor } from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { friendlyError } from "#/modules/errors/messages.ts";

/**
 * Contención de errores (spec 05 §5), en sus tres capas.
 *
 * La regla que las une: **nunca una pantalla en blanco**. Un fallo de render, un
 * loader que revienta o una URL que no existe tienen que terminar en algo que la
 * persona pueda leer y de lo que pueda salir.
 *
 * El mensaje va en español (RN-05.10) y el código técnico se registra en la
 * consola y se deja plegado al pie, no en la cara de quien está intentando
 * fichar.
 */

function Shell({
	icon,
	title,
	children,
}: {
	icon: ReactNode;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-[60svh] items-center justify-center p-6">
			<div className="w-full max-w-md space-y-5 rounded-xl border p-8 text-center">
				<div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted">
					{icon}
				</div>
				<h1 className="text-lg font-semibold">{title}</h1>
				{children}
			</div>
		</div>
	);
}

/** Enlace de vuelta al destino por defecto del rol (spec 05 §5). */
function HomeLink() {
	const session = useQuery(sessionQueryOptions());
	const to = session.data ? defaultRouteFor(session.data.effectiveRole) : "/";

	return (
		<Button variant="outline" asChild>
			<Link to={to}>
				<Compass />
				Volver al inicio
			</Link>
		</Button>
	);
}

/**
 * Capas 1 y 2: frontera de error de aplicación y de ruta.
 *
 * Es el mismo componente para las dos porque la diferencia no está en lo que se
 * pinta sino en **dónde se monta**: en la ruta raíz tumba la página entera, y en
 * una ruta hija se queda dentro del shell y deja el aside en pie.
 */
export function ErrorScreen({
	error,
	reset,
}: {
	error: unknown;
	reset?: () => void;
}) {
	const { message, detail, retryable } = friendlyError(error);

	// El código técnico se registra; al usuario se le enseña el mensaje.
	console.error("[error-boundary]", error);

	return (
		<Shell
			icon={<TriangleAlert className="size-5 text-amber-600" />}
			title="Algo salió mal"
		>
			<p className="text-sm text-muted-foreground">{message}</p>

			<div className="flex flex-wrap justify-center gap-3">
				{retryable && reset && (
					<Button onClick={reset}>
						<RotateCw />
						Reintentar
					</Button>
				)}
				<Button variant="outline" onClick={() => window.location.reload()}>
					Recargar la página
				</Button>
				<HomeLink />
			</div>

			{detail && (
				<details className="text-left">
					<summary className="cursor-pointer text-xs text-muted-foreground">
						Detalle técnico
					</summary>
					<p className="mt-2 rounded-md bg-muted p-2 font-mono text-xs break-all">
						{detail}
					</p>
				</details>
			)}
		</Shell>
	);
}

/** Capa 3: ruta no encontrada. */
export function NotFoundScreen() {
	return (
		<Shell
			icon={<Compass className="size-5 text-muted-foreground" />}
			title="Esta página no existe"
		>
			<p className="text-sm text-muted-foreground">
				La dirección que abriste no corresponde a ninguna pantalla. Puede que el
				enlace esté viejo o que la sección todavía no exista.
			</p>
			<div className="flex justify-center">
				<HomeLink />
			</div>
		</Shell>
	);
}
