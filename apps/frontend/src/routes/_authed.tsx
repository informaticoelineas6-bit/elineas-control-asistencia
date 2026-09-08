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

export const Route = createFileRoute("/_authed")({ component: AuthedLayout });

/**
 * Layout de todo lo que exige sesión: aside colapsable + contenido.
 *
 * El guard vive en el cliente porque las cookies de sesión son del origen del
 * backend y el SSR de esta app no las ve (ver `session.ts`). Es un guard de UX:
 * la autorización de verdad la hace el backend en cada petición (RN-03.3).
 */
function AuthedLayout() {
	const navigate = useNavigate();
	const session = useQuery(sessionQueryOptions());

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
