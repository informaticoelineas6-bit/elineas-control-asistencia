import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "#/components/ui/sidebar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { MaintenanceBanner } from "#/modules/admin/maintenance-banner.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { NotificationsLive } from "#/modules/notifications/live.tsx";
import { NotificationsBell } from "#/modules/notifications/notifications-bell.tsx";
import { AdminBottomBar } from "#/modules/shells/admin-bottom-bar.tsx";
import { EmployeeShell } from "#/modules/shells/employee-shell.tsx";
import { useShell } from "#/modules/shells/use-shell.ts";

export const Route = createFileRoute("/_authed")({ component: AuthedLayout });

/**
 * Layout de todo lo que exige sesión, y **el sitio donde se elige el shell**
 * (spec 05 §2).
 *
 * Dos envolturas sobre las mismas rutas y los mismos datos: el EmployeeShell del
 * operario con el móvil en la mano y el AdminShell del backoffice. No son dos
 * aplicaciones y aquí se ve por qué — el `<Outlet />` es el mismo, y lo único que
 * cambia es lo que lo rodea.
 *
 * El guard vive en el cliente porque las cookies de sesión son del origen del
 * backend y el SSR de esta app no las ve (ver `session.ts`). Es un guard de UX:
 * la autorización de verdad la hace el backend en cada petición (RN-03.3), y el
 * shell **no decide permisos** en ningún caso (RN-05.3).
 */
function AuthedLayout() {
	const navigate = useNavigate();
	const session = useQuery(sessionQueryOptions());
	const shell = useShell(session.data?.effectiveRole);

	useEffect(() => {
		if (!session.isPending && !session.data) {
			void navigate({ to: "/login", replace: true });
		}
	}, [session.isPending, session.data, navigate]);

	if (session.isPending || !session.data) {
		return (
			<div className="flex min-h-svh">
				<Skeleton className="hidden w-64 rounded-none md:block" />
				<div className="flex-1 space-y-4 p-6">
					<Skeleton className="h-8 w-56" />
					<Skeleton className="h-40 w-full" />
				</div>
			</div>
		);
	}

	if (shell === "employee") {
		return (
			<EmployeeShell session={session.data}>
				<MaintenanceBanner />

				{/*
				 * `flex-1` con `min-h-0`: el contenido es lo único que hace scroll, así
				 * que la barra inferior no se va nunca y *Marcar* está siempre a un
				 * toque (RN-05.6).
				 */}
				<main className="min-h-0 flex-1 p-4">
					<Outlet />
				</main>

				<NotificationsLive />
			</EmployeeShell>
		);
	}

	return (
		<SidebarProvider>
			<AppSidebar session={session.data} />
			<SidebarInset>
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger className="-ml-1" />
					<Separator orientation="vertical" className="mr-2 h-4" />
					<span className="text-sm font-medium">Control de Asistencia</span>
					<div className="ml-auto">
						<NotificationsBell />
					</div>
				</header>
				{/*
				 * Spec 19 §2.5 — El aviso de mantenimiento, para **todos** los usuarios
				 * conectados: es un criterio de aceptación de esa spec y llega por la
				 * configuración pública, no por un canal aparte.
				 */}
				<MaintenanceBanner />

				<div className="flex-1 p-6">
					<Outlet />
				</div>

				{/* RN-05.9 — Los destinos principales a un toque, sólo en móvil. */}
				<AdminBottomBar role={session.data.effectiveRole} />

				{/*
				 * La entrega en vivo (RN-14.4) y el aviso emergente (RN-14.5) se montan
				 * **una sola vez y aquí**: una conexión SSE por pestaña, no una por
				 * pantalla. Va dentro del layout autenticado porque necesita sesión.
				 */}
				<NotificationsLive />
			</SidebarInset>
		</SidebarProvider>
	);
}
