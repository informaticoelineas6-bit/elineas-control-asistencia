import type { AppRole } from "@elineas/validations";
import {
	BadgeDollarSign,
	CalendarClock,
	ClipboardList,
	FileBarChart,
	LayoutDashboard,
	ScrollText,
	Settings,
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
 * `global_manager` no marca asistencia (RN-03.4), así que lo propio de fichaje
 * no se le ofrece. `superadmin` sí, porque hereda todo lo anterior (spec 03 §2).
 */
const MARKS = [
	"employee",
	"department_head",
	"superadmin",
] as const satisfies readonly AppRole[];

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
				to: "/mi-asistencia",
				label: "Mi asistencia",
				icon: CalendarClock,
				roles: MARKS,
			},
		],
	},
	{
		label: "Gestión",
		items: [
			{
				to: "/mi-equipo",
				label: "Mi equipo",
				icon: ClipboardList,
				roles: HEAD_AND_UP,
			},
			{
				to: "/reportes",
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
				to: "/usuarios",
				label: "Usuarios",
				icon: Users,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/nomina",
				label: "Nómina",
				icon: BadgeDollarSign,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/configuracion",
				label: "Configuración",
				icon: Settings,
				roles: MANAGER_AND_UP,
			},
			{
				to: "/bitacora",
				label: "Bitácora",
				icon: ScrollText,
				roles: SUPERADMIN,
			},
		],
	},
] as const;

export type NavPath = (typeof NAV_SECTIONS)[number]["items"][number]["to"];

/** Roles admitidos por cada ruta, para el guard de la propia página. */
export const ROUTE_ROLES = Object.fromEntries(
	NAV_SECTIONS.flatMap((section) =>
		section.items.map((item) => [item.to, item.roles as readonly AppRole[]]),
	),
) as Record<NavPath, readonly AppRole[]>;

export function canAccess(
	role: AppRole | null | undefined,
	path: NavPath,
): boolean {
	return role != null && ROUTE_ROLES[path].includes(role);
}

export const ROLE_LABELS: Record<AppRole, string> = {
	employee: "Empleado",
	department_head: "Jefe de departamento",
	global_manager: "Gestor global",
	superadmin: "Superadministrador",
};
