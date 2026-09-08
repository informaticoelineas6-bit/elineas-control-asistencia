import type { AppRole } from "@elineas/validations";
import { Link, useRouterState } from "@tanstack/react-router";
import {
	ADMIN_QUICK_NAV,
	canAccess,
	NAV_ITEMS,
} from "#/modules/auth/navigation.ts";

/**
 * RN-05.9 — La barra inferior de respaldo del AdminShell en móvil.
 *
 * La otra mitad de esa regla —"la barra lateral pasa a ser un panel
 * desplegable"— ya la cumple el propio aside: en pantallas pequeñas se convierte
 * en un panel deslizante. Lo que faltaba es esto: **los destinos principales a un
 * toque**, sin abrir el panel.
 *
 * Es una lista corta y explícita (`ADMIN_QUICK_NAV`) y no "los primeros de cada
 * grupo", porque lo que un gestor abre desde el teléfono no es lo primero del
 * menú: es cómo va el día y qué espera por él.
 *
 * Sólo se pinta en móvil, y el layout la esconde por CSS en cuanto hay ancho: así
 * no depende de una segunda medición del viewport que pudiera discrepar de la del
 * shell.
 */
export function AdminBottomBar({ role }: { role: AppRole }) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	const items = ADMIN_QUICK_NAV.map((path) =>
		NAV_ITEMS.find((item) => item.to === path),
	).filter(
		(item): item is NonNullable<typeof item> =>
			item !== undefined && canAccess(role, item.to),
	);

	if (items.length < 2) return null;

	return (
		<nav
			aria-label="Accesos rápidos"
			className="sticky bottom-0 z-20 grid grid-flow-col border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
		>
			{items.map((item) => {
				const Icon = item.icon;
				const active = pathname === item.to;
				return (
					<Link
						key={item.to}
						to={item.to}
						aria-current={active ? "page" : undefined}
						data-active={active}
						className="flex h-14 flex-col items-center justify-center gap-0.5 text-muted-foreground transition-colors data-[active=true]:text-primary"
					>
						<Icon className="size-5" />
						<span className="text-[11px] leading-none font-medium">
							{item.label}
						</span>
					</Link>
				);
			})}
		</nav>
	);
}
