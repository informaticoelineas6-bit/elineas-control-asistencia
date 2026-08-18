import type { AppRole } from "@elineas/validations";
import {
	BadgeDollarSign,
	Building2,
	CalendarClock,
	ClipboardList,
	FileBarChart,
	LayoutDashboard,
	ScrollText,
	Settings,
	UserRound,
	Users,
} from "lucide-react";

/**
 * Qué ve cada rol en el aside.
 *
 * Traducción directa de la matriz de ámbito de la spec 03 §5. Ojo:
 * **esto es UX, no seguridad** (RN-03.3). Que un enlace no aparezca no protege
 * nada; cada endpoint del backend valida rol y ámbito por su cuenta. Ocultarlo
 * sólo evita ofrecerle a alguien algo que va a recibir con un 403.
 */

const EMPLOYEE_AND_UP = [
	"employee",
	"department_head",
	"global_manager",
	"superadmin",
] as const satisfies readonly AppRole[];

/**
 * `global_manager` no marca asistencia (RN-03.4).
 *
 * Se expresa como **exclusión** y no acortando la lista de admitidos a propósito
 * (spec 04 §6): "todos menos el gestor global" es lo que dice la regla, y
 * enumerar a los demás haría que un rol nuevo entrara por descuido. `superadmin`
 * sí marca, porque hereda todo lo anterior (spec 03 §2).
 */
const MARKS_EXCLUDED = ["global_manager"] as const satisfies readonly AppRole[];

const HEAD_AND_UP = [
	"department_head",
	"global_manager",
	"superadmin",
] as const satisfies readonly AppRole[];

const MANAGER_AND_UP = [
	"global_manager",
	"superadmin",
] as const satisfies readonly AppRole[];

const SUPERADMIN = ["superadmin"] as const satisfies readonly AppRole[];

export const NAV_SECTIONS = [
	{
		label: "Personal",
		items: [
			{
				to: "/dashboard",
				label: "Inicio",
				icon: LayoutDashboard,
				roles: EMPLOYEE_AND_UP,
			},
			{
				to: "/attendance",
				label: "Mi asistencia",
				icon: CalendarClock,
				roles: EMPLOYEE_AND_UP,
				excludedRoles: MARKS_EXCLUDED,
			},
			{
				to: "/profile",
				label: "Mi perfil",
				icon: UserRound,
				roles: EMPLOYEE_AND_UP,
			},
		],
	},
	{
		label: "Gestión",
		items: [
			{
				to: "/team",
				label: "Mi equipo",
				icon: ClipboardList,
				roles: HEAD_AND_UP,
			},
			{
				to: "/reports",
				label: "Reportes",
				icon: FileBarChart,
				roles: HEAD_AND_UP,
			},
		],
	},
	{
		label: "Administración",
		items: [
			{
				to: "/users",
				label: "Usuarios",
				icon: Users,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/departments",
				label: "Departamentos",
				icon: Building2,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/payroll",
				label: "Nómina",
				icon: BadgeDollarSign,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/settings",
				label: "Configuración",
				icon: Settings,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/logs",
				label: "Logs",
				icon: ScrollText,
				roles: SUPERADMIN,
			},
		],
	},
] as const;

export type NavPath = (typeof NAV_SECTIONS)[number]["items"][number]["to"];

/**
 * Acceso por ruta, con las **dos listas** del guard del legacy (spec 04 §6):
 *
 * - `allowedRoles` — quién entra.
 * - `excludedRoles` — quién queda fuera **aunque su prioridad alcance**. Sin esta
 *   segunda lista, "todos menos el gestor global" habría que escribirlo
 *   enumerando a los demás, y un rol nuevo entraría por descuido.
 *
 * Se deriva del propio menú para que filtrado y guard no puedan discrepar: si un
 * enlace no se ofrece, su ruta tampoco se abre escribiéndola a mano.
 */
export type RouteAccess = {
	allowedRoles: readonly AppRole[];
	excludedRoles: readonly AppRole[];
};

export const ROUTE_ACCESS = Object.fromEntries(
	NAV_SECTIONS.flatMap((section) =>
		section.items.map((item) => [
			item.to,
			{
				allowedRoles: item.roles as readonly AppRole[],
				excludedRoles: ("excludedRoles" in item
					? item.excludedRoles
					: []) as readonly AppRole[],
			},
		]),
	),
) as Record<NavPath, RouteAccess>;

export function canAccess(
	role: AppRole | null | undefined,
	path: NavPath,
): boolean {
	if (role == null) return false;
	const { allowedRoles, excludedRoles } = ROUTE_ACCESS[path];
	return allowedRoles.includes(role) && !excludedRoles.includes(role);
}

/** Los roles que de verdad ven una ruta, para explicarlo en pantalla. */
export function rolesWithAccess(path: NavPath): readonly AppRole[] {
	const { allowedRoles, excludedRoles } = ROUTE_ACCESS[path];
	return allowedRoles.filter((role) => !excludedRoles.includes(role));
}

/**
 * Destino por defecto de cada rol: adonde va tras iniciar sesión y adonde
 * apunta el "volver al inicio" de las pantallas de error y del 404.
 *
 * Hoy es el panel para todos. Cuando exista la pantalla de marcaje
 * ([09](../../../../../packages/specs/09-marcaje-asistencia.md)), RN-05.4 la
 * convierte en el destino de quien marca, y los gestores globales —que no
 * marcan— se quedan en el panel.
 */
export function defaultRouteFor(_role: AppRole): NavPath {
	return "/dashboard";
}

export const ROLE_LABELS: Record<AppRole, string> = {
	employee: "Empleado",
	department_head: "Jefe de departamento",
	global_manager: "Gestor global",
	superadmin: "Superadministrador",
};
