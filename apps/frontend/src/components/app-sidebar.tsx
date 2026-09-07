import type { Permissions } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Clock, LogOut } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "#/components/ui/sidebar.tsx";
import { pendingAbsencesCountQueryOptions } from "#/modules/absences/api.ts";
import {
	badgeOf,
	canAccess,
	NAV_SECTIONS,
	type NavBadge,
	ROLE_LABELS,
} from "#/modules/auth/navigation.ts";
import { useLogout } from "#/modules/auth/session.ts";
import { pendingIncidentsCountQueryOptions } from "#/modules/incidents/api.ts";
import { ThemeToggle } from "#/modules/theme/theme-toggle.tsx";

/**
 * Aside colapsable del panel.
 *
 * `collapsible="icon"` deja una franja de iconos en lugar de esconder el aside
 * entero: en pantallas pequeñas el propio componente lo convierte en un panel
 * deslizante. El estado de colapso lo persiste shadcn en la cookie
 * `sidebar_state`.
 *
 * Los enlaces se filtran por el **rol efectivo** (RN-03.1) con `canAccess`, la
 * misma función que usa el guard de página: RN-05.7 lo pide explícitamente —"el
 * filtrado y el guard salen de la misma tabla"— y con la comprobación duplicada
 * a mano se perdía la lista de exclusión, así que a un `global_manager` se le
 * ofrecían *Marcar* y *Mi asistencia* para que el guard lo echara acto seguido.
 * Sigue siendo UX: la barrera real está en el backend (RN-03.3).
 *
 * Los badges son RN-05.8: los pendientes que esperan por una acción de quien
 * mira. Se resuelven aquí y no en la tabla de navegación porque hacen falta
 * hooks, y `navigation.ts` tiene que seguir siendo datos puros para que el guard
 * pueda leerla.
 */
export function AppSidebar({ session }: { session: Permissions }) {
	const logout = useLogout();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { effectiveRole, user, profile } = session;

	const sections = NAV_SECTIONS.map((section) => ({
		label: section.label,
		items: section.items.filter((item) => canAccess(effectiveRole, item.to)),
	})).filter((section) => section.items.length > 0);

	const shown = new Set(
		sections.flatMap((section) =>
			section.items.map((item) => badgeOf(item)).filter(Boolean),
		),
	);

	// `enabled` por badge visible: sin esto, un empleado pediría el conteo de
	// gestión y recibiría un 403 en cada carga del shell.
	const ownPending = useQuery({
		...pendingIncidentsCountQueryOptions("own"),
		enabled: shown.has("incidents-own"),
	});
	const managedIncidents = useQuery({
		...pendingIncidentsCountQueryOptions("managed"),
		enabled: shown.has("team-pending"),
	});
	const pendingAbsences = useQuery({
		...pendingAbsencesCountQueryOptions(),
		enabled: shown.has("team-pending"),
	});

	const counts: Record<NavBadge, number> = {
		"incidents-own": ownPending.data?.count ?? 0,
		// Las dos bandejas con conteo de `/team`, sumadas: el badge dice si hay algo
		// que decidir, y abrir la página ya separa de qué se trata.
		"team-pending":
			(managedIncidents.data?.count ?? 0) + (pendingAbsences.data?.count ?? 0),
	};

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" asChild>
							<Link to="/dashboard">
								<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
									<Clock className="size-4" />
								</div>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-semibold">
										Control de Asistencia
									</span>
									<span className="truncate text-xs text-muted-foreground">
										Elineas
									</span>
								</div>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent>
				{sections.map((section) => (
					<SidebarGroup key={section.label}>
						<SidebarGroupLabel>{section.label}</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{section.items.map((item) => {
									const badge = badgeOf(item);
									const count = badge ? counts[badge] : 0;

									return (
										<SidebarMenuItem key={item.to}>
											<SidebarMenuButton
												asChild
												tooltip={item.label}
												isActive={pathname === item.to}
											>
												<Link to={item.to}>
													<item.icon />
													<span>{item.label}</span>
												</Link>
											</SidebarMenuButton>
											{count > 0 && (
												<SidebarMenuBadge aria-label={`${count} pendientes`}>
													{count}
												</SidebarMenuBadge>
											)}
										</SidebarMenuItem>
									);
								})}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<div className="flex items-center gap-2 overflow-hidden rounded-md p-2 text-sm group-data-[collapsible=icon]:hidden">
							<div className="grid flex-1 leading-tight">
								<span className="truncate font-medium">
									{profile.fullName || user.email}
								</span>
								<span className="truncate text-xs text-muted-foreground">
									{ROLE_LABELS[effectiveRole]}
								</span>
							</div>
						</div>
					</SidebarMenuItem>
					<ThemeToggle />
					<SidebarMenuItem>
						<SidebarMenuButton
							tooltip="Cerrar sesión"
							onClick={() => logout.mutate()}
							disabled={logout.isPending}
						>
							<LogOut />
							<span>Cerrar sesión</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}

/** Botón de salida para pantallas donde no se pinta el aside. */
export function SignOutButton() {
	const logout = useLogout();
	return (
		<Button
			variant="outline"
			onClick={() => logout.mutate()}
			disabled={logout.isPending}
		>
			<LogOut className="size-4" />
			Cerrar sesión
		</Button>
	);
}
