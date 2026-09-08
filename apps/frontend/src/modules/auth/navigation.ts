import { type AppRole, ROLES_THAT_DO_NOT_MARK } from "@elineas/validations";
import type { LucideIcon } from "lucide-react";
import {
	BadgeDollarSign,
	BedDouble,
	Building2,
	CalendarCheck,
	CalendarClock,
	ClipboardList,
	FileBarChart,
	FileWarning,
	LayoutDashboard,
	Satellite,
	ScrollText,
	Settings,
	ShieldAlert,
	Timer,
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
 * La lista vive en `@elineas/validations` (`ROLES_THAT_DO_NOT_MARK`) porque la
 * consultan también la validación del marcaje (spec 07 §4) y la vista del horario
 * propio: la regla se escribe una vez o acaba divergiendo entre el menú y el
 * servidor. Se expresa como **exclusión** y no acortando la lista de admitidos a
 * propósito (spec 04 §6): "todos menos el gestor global" es lo que dice la regla,
 * y enumerar a los demás haría que un rol nuevo entrara por descuido.
 */
const MARKS_EXCLUDED = ROLES_THAT_DO_NOT_MARK;

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
				to: "/clock-in",
				label: "Marcar",
				icon: Timer,
				roles: EMPLOYEE_AND_UP,
				excludedRoles: MARKS_EXCLUDED,
			},
			{
				to: "/attendance",
				label: "Mi asistencia",
				icon: CalendarClock,
				roles: EMPLOYEE_AND_UP,
				excludedRoles: MARKS_EXCLUDED,
			},
			/*
			 * Spec 12. Lo ve cualquier rol —la spec 12 §7 dice "autenticado" y no
			 * invoca RN-03.4 como sí hace la 11 con las vacaciones— y lleva badge
			 * con las propias sin revisar (§6, RN-05.8).
			 *
			 * La spec 05 §3 la llamaba `/issues`; se unificó en `/incidents`, que es
			 * como se llama el recurso en todo lo demás (ver `routes/_authed/incidents.tsx`).
			 */
			{
				to: "/incidents",
				label: "Incidencias",
				icon: FileWarning,
				roles: EMPLOYEE_AND_UP,
				badge: "incidents-own",
			},
			{
				to: "/profile",
				label: "Mi perfil",
				icon: UserRound,
				roles: EMPLOYEE_AND_UP,
			},
			/*
			 * Spec 08 §6. La ve cualquier rol a propósito, incluido el gestor global
			 * que no marca: quien la usa de verdad es el jefe en planta con el teléfono
			 * de otro en la mano, resolviendo un "dice que estoy fuera y estoy dentro".
			 */
			{
				to: "/gps",
				label: "Diagnóstico GPS",
				icon: Satellite,
				roles: EMPLOYEE_AND_UP,
			},
		],
	},
	{
		label: "Gestión",
		items: [
			/*
			 * Spec 15 §5.2 y §5.3, que son la misma vista: quien la abre ve su
			 * ámbito. Va antes de *Mi equipo* porque el orden es el del trabajo —
			 * primero se mira cómo va el día, luego se decide sobre lo pendiente.
			 */
			{
				to: "/daily",
				label: "Asistencia del día",
				icon: CalendarCheck,
				roles: HEAD_AND_UP,
			},
			{
				to: "/team",
				label: "Mi equipo",
				icon: ClipboardList,
				roles: HEAD_AND_UP,
				/*
				 * RN-05.8: lo que espera por una decisión suya. Suma las dos bandejas
				 * de esa página que tienen conteo —incidencias por revisar (spec 12 §7)
				 * y ausencias sin clasificar (spec 13 §5)—, porque el badge de un ítem
				 * de menú responde "¿tengo algo que hacer ahí?", no "¿de qué tipo?".
				 */
				badge: "team-pending",
			},
			/*
			 * Spec 10 §4. Empieza en `department_head` y no en `global_manager`
			 * porque **asignar personas a un grupo de descanso es su operación**:
			 * los grupos los define un gestor, pero quien organiza el turno de su
			 * gente es el jefe. Los descansos propios no están aquí, están en Mi
			 * perfil (spec 05 §3).
			 */
			{
				to: "/rest-days",
				label: "Descansos",
				icon: BedDouble,
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
			/*
			 * Spec 19. Va **al final y sólo para `superadmin`**: es la pantalla que
			 * menos debería hacer falta (RN-19.10 — si algo de ahí se usa a menudo,
			 * falta una funcionalidad en el producto).
			 */
			{
				to: "/admin",
				label: "Superadmin",
				icon: ShieldAlert,
				roles: SUPERADMIN,
			},
		],
	},
] as const;

/**
 * Rutas que **no son ítems de menú** pero sí tienen regla de acceso.
 *
 * `/my-week` es el gemelo móvil de *Mi asistencia* (spec 05 §3): vive en la barra
 * inferior del EmployeeShell y no en el aside, porque en escritorio la vista que
 * sirve es `/attendance` —con su calendario y su tabla— y tener las dos en el
 * menú sería ofrecer dos veces el mismo dato.
 *
 * Están **aquí y no fuera de la tabla** porque RN-05.7 exige que el filtrado del
 * menú y el guard de página salgan del mismo sitio: una ruta sin entrada en
 * `ROUTE_ACCESS` sería una ruta que el guard no sabe proteger.
 */
const EXTRA_ROUTES = {
	/** Mismo acceso que `/attendance`: quien marca. El gestor global no marca. */
	"/my-week": {
		allowedRoles: EMPLOYEE_AND_UP,
		excludedRoles: MARKS_EXCLUDED,
	},
} as const satisfies Record<
	string,
	{ allowedRoles: readonly AppRole[]; excludedRoles: readonly AppRole[] }
>;

export type NavPath =
	| (typeof NAV_SECTIONS)[number]["items"][number]["to"]
	| keyof typeof EXTRA_ROUTES;

/**
 * La forma de un ítem del menú, y la lista plana de todos.
 *
 * `NAV_SECTIONS` es una tupla `as const` para que `NavPath` salga de ella, y esa
 * misma precisión hace que recorrerla desde fuera sea incómodo —el tipo de
 * `flatMap` sobre una tupla de tuplas no colapsa—. Esto es la vista plana con la
 * forma declarada, para quien sólo necesita "todos los ítems".
 */
export type NavItem = {
	to: NavPath;
	label: string;
	icon: LucideIcon;
	roles: readonly AppRole[];
	excludedRoles?: readonly AppRole[];
	badge?: NavBadge;
};

export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap(
	(section) => section.items as readonly NavItem[],
);

/**
 * Contadores que un ítem del menú puede mostrar como badge (RN-05.8).
 *
 * Es un identificador y no un número: la tabla de navegación describe **qué**
 * contar, y el aside —que es quien puede usar hooks— resuelve cuánto. Así esta
 * tabla sigue siendo datos puros y se puede leer desde el guard sin arrastrar
 * consultas.
 */
export type NavBadge = "incidents-own" | "team-pending";

export function badgeOf(
	item: (typeof NAV_SECTIONS)[number]["items"][number],
): NavBadge | null {
	return "badge" in item ? (item.badge as NavBadge) : null;
}

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

const MENU_ROUTE_ACCESS = Object.fromEntries(
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

export const ROUTE_ACCESS: Record<NavPath, RouteAccess> = {
	...MENU_ROUTE_ACCESS,
	...EXTRA_ROUTES,
};

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
 * Los cuatro destinos de la barra inferior del EmployeeShell (spec 05 §3).
 *
 * Se filtran igual que los del aside, con `canAccess`: el shell no decide
 * permisos (RN-05.3), sólo deja de ofrecer lo que el guard rechazaría.
 *
 * *Notificaciones* no está aquí y no es un olvido: es la campana de la cabecera,
 * que en este shell también está siempre visible. RN-05.5 pide que los badges de
 * la barra se actualicen sin recargar, y el que le toca a la barra es el de
 * incidencias — el de notificaciones lo lleva la campana.
 */
export const EMPLOYEE_NAV = [
	{ to: "/clock-in", label: "Marcar", icon: Timer },
	{ to: "/my-week", label: "Mi semana", icon: CalendarCheck },
	{
		to: "/incidents",
		label: "Incidencias",
		icon: FileWarning,
		badge: "incidents-own",
	},
	{ to: "/profile", label: "Perfil", icon: UserRound },
] as const satisfies readonly {
	to: NavPath;
	label: string;
	icon: LucideIcon;
	badge?: NavBadge;
}[];

/**
 * Los destinos de la barra inferior de respaldo del AdminShell en móvil
 * (RN-05.9).
 *
 * Es una lista corta y **explícita**, no "los primeros de cada grupo": lo que un
 * gestor abre desde el teléfono no es lo primero del menú, es el estado del día y
 * lo que espera por él. El aside sigue estando —convertido en panel deslizante—
 * para todo lo demás.
 */
export const ADMIN_QUICK_NAV = [
	"/dashboard",
	"/daily",
	"/team",
	"/users",
] as const satisfies readonly NavPath[];

/**
 * Destino por defecto: adonde va tras iniciar sesión y adonde apunta el "volver
 * al inicio" de las pantallas de error y del 404.
 *
 * **RN-05.4 — en el EmployeeShell es *Marcar***, que es la razón de ser de ese
 * shell: quien lo usa tiene el teléfono en la mano y la nave delante. En el
 * AdminShell es *Inicio*, que es el primer ítem de su menú y lo que un jefe o un
 * gestor abren para ver cómo va el día.
 *
 * Depende del shell y no sólo del rol porque **la misma persona quiere cosas
 * distintas según desde dónde entre**: un jefe de departamento en el teléfono va
 * a marcar; el mismo jefe en su escritorio va a mirar a su equipo.
 */
export function defaultRouteFor(
	role: AppRole,
	shell: "employee" | "admin" = "admin",
): NavPath {
	return shell === "employee" && canAccess(role, "/clock-in")
		? "/clock-in"
		: "/dashboard";
}

export const ROLE_LABELS: Record<AppRole, string> = {
	employee: "Empleado",
	department_head: "Jefe de departamento",
	global_manager: "Gestor global",
	superadmin: "Superadministrador",
};
