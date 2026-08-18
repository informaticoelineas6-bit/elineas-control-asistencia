import type { Permissions } from "@elineas/validations";
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
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "#/components/ui/sidebar.tsx";
import { NAV_SECTIONS, ROLE_LABELS } from "#/modules/auth/navigation.ts";
import { useLogout } from "#/modules/auth/session.ts";
import { ThemeToggle } from "#/modules/theme/theme-toggle.tsx";

/**
 * Aside colapsable del panel.
 *
 * `collapsible="icon"` deja una franja de iconos en lugar de esconder el aside
 * entero: en pantallas pequeñas el propio componente lo convierte en un panel
 * deslizante. El estado de colapso lo persiste shadcn en la cookie
 * `sidebar_state`.
 *
 * Los enlaces se filtran por el **rol efectivo** (RN-03.1). Es UX: la barrera
 * real está en el backend (RN-03.3).
 */
export function AppSidebar({ session }: { session: Permissions }) {
	const logout = useLogout();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { effectiveRole, user, profile } = session;

	const sections = NAV_SECTIONS.map((section) => ({
		label: section.label,
		items: section.items.filter((item) =>
			(item.roles as readonly string[]).includes(effectiveRole),
		),
	})).filter((section) => section.items.length > 0);

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
								{section.items.map((item) => (
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
									</SidebarMenuItem>
								))}
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
