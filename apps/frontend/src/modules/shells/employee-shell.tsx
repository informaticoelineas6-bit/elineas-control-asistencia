import type { Permissions } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
	canAccess,
	EMPLOYEE_NAV,
	type NavBadge,
} from "#/modules/auth/navigation.ts";
import { pendingIncidentsCountQueryOptions } from "#/modules/incidents/api.ts";
import { NotificationsBell } from "#/modules/notifications/notifications-bell.tsx";

/**
 * EmployeeShell (spec 05 §3): la envoltura del operario con el móvil en la mano.
 *
 * Cuatro destinos en una barra inferior y nada más. Las decisiones que lo hacen
 * usable de verdad son de tamaño y de posición, y responden a RN-05.6 —"con una
 * sola mano y sin scroll para la acción principal"—:
 *
 * - **La barra va abajo**, donde llega el pulgar. Un menú arriba en un teléfono
 *   de seis pulgadas obliga a recolocar la mano para cada toque.
 * - **Cada destino tiene 56 px de alto y su etiqueta debajo del icono.** Un
 *   icono solo se adivina; en planta, con guantes y con prisa, adivinar cuesta
 *   toques.
 * - **Respeta el área segura** (`env(safe-area-inset-bottom)`): sin eso, en un
 *   iPhone el último destino queda debajo de la barra del sistema.
 * - **El contenido es la única parte que hace scroll.** La barra no se va nunca,
 *   así que *Marcar* está siempre a un toque — que es la razón de ser del shell.
 *
 * **No decide permisos** (RN-05.3): filtra con `canAccess`, la misma función que
 * el guard de página y el aside (RN-05.7). Un `global_manager` que fuerce este
 * shell con `?ui=employee` verá la barra sin *Marcar*, porque no marca.
 */
export function EmployeeShell({
	session,
	children,
}: {
	session: Permissions;
	children: ReactNode;
}) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const destinations = EMPLOYEE_NAV.filter((item) =>
		canAccess(session.effectiveRole, item.to),
	);

	return (
		<div className="flex min-h-svh flex-col bg-background">
			<header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
				<span className="truncate text-sm font-medium">
					{session.profile?.fullName ?? "Control de Asistencia"}
				</span>
				<div className="ml-auto">
					<NotificationsBell />
				</div>
			</header>

			{children}

			<nav
				aria-label="Navegación principal"
				className="sticky bottom-0 z-20 mt-auto grid grid-flow-col border-t bg-background pb-[env(safe-area-inset-bottom)]"
			>
				{destinations.map((item) => (
					<BottomLink
						key={item.to}
						to={item.to}
						label={item.label}
						icon={item.icon}
						badge={"badge" in item ? (item.badge as NavBadge) : undefined}
						active={pathname === item.to}
					/>
				))}
			</nav>
		</div>
	);
}

function BottomLink({
	to,
	label,
	icon: Icon,
	badge,
	active,
}: {
	to: string;
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	badge?: NavBadge;
	active: boolean;
}) {
	return (
		<Link
			to={to}
			aria-current={active ? "page" : undefined}
			data-active={active}
			className="relative flex h-14 flex-col items-center justify-center gap-0.5 text-muted-foreground transition-colors data-[active=true]:text-primary"
		>
			<span className="relative">
				<Icon className="size-5" />
				{badge && <BottomBadge badge={badge} />}
			</span>
			<span className="text-[11px] leading-none font-medium">{label}</span>
		</Link>
	);
}

/**
 * RN-05.5 — Los badges se actualizan sin recargar. No hay nada que hacer para
 * conseguirlo: es el mismo conteo que el aside, y toda mutación de incidencias lo
 * invalida.
 */
function BottomBadge({ badge }: { badge: NavBadge }) {
	const incidents = useQuery({
		...pendingIncidentsCountQueryOptions("own"),
		enabled: badge === "incidents-own",
	});
	const count = incidents.data?.count ?? 0;
	if (count === 0) return null;

	return (
		<span className="absolute -top-1.5 -right-2 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-white tabular-nums">
			{count > 9 ? "9+" : count}
		</span>
	);
}
