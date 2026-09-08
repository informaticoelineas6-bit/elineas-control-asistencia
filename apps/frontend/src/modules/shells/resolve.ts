import type { AppRole } from "@elineas/validations";

/**
 * La regla de resolución de shell (spec 05 §2), en una función pura.
 *
 * ```
 * viewport < 768px  Y  rol no administrativo  →  EmployeeShell
 * en cualquier otro caso                      →  AdminShell
 * ```
 *
 * Está aislada del hook y de React a propósito: es una regla con cuatro casos y
 * un override, y probarla no debería necesitar un navegador. La parte que sí
 * necesita entorno —medir el viewport, leer la URL— vive en `use-shell.ts`.
 *
 * **RN-05.3 — el shell nunca decide permisos.** Ninguna de estas líneas mira lo
 * que alguien puede hacer: sólo decide qué envoltura de navegación se pinta. Cada
 * ruta sigue protegida por su guard y cada endpoint por su rol.
 */

export type Shell = "employee" | "admin";

/**
 * "Rol administrativo" a estos efectos. **`department_head` no está**, y es
 * deliberado en la spec: también marca, así que en el móvil ve el shell de
 * empleado; en escritorio ve el de admin, como cualquiera.
 */
const ADMINISTRATIVE: readonly AppRole[] = ["global_manager", "superadmin"];

export const isAdministrativeRole = (role: AppRole): boolean =>
	ADMINISTRATIVE.includes(role);

/**
 * El override de RN-05.2, tal como puede venir en `?ui=`.
 *
 * `auto` es el tercer valor y hace falta: sin él, quien fuerza un shell en una
 * pestaña no tiene forma de volver al comportamiento normal sin cerrarla.
 */
export type ShellOverride = Shell | "auto";

export function parseShellOverride(
	raw: string | null | undefined,
): ShellOverride | null {
	if (raw === "employee" || raw === "admin" || raw === "auto") return raw;
	return null;
}

export function resolveShell(input: {
	role: AppRole | null | undefined;
	isMobile: boolean;
	override?: ShellOverride | null;
}): Shell {
	// RN-05.2 — El override manda sobre el viewport y sobre el rol, porque su
	// razón de ser es reproducir lo que ve otra persona. Lo que **no** hace es
	// otorgar nada: un `employee` con `?ui=admin` ve el armazón y cada ruta lo
	// sigue echando.
	if (input.override === "employee" || input.override === "admin") {
		return input.override;
	}

	// Sin rol todavía no hay a quién decidirle nada; el AdminShell es el que sabe
	// pintar la carga y el que se sirve en escritorio, que es el caso mayoritario
	// del primer render.
	if (!input.role) return "admin";

	return input.isMobile && !isAdministrativeRole(input.role)
		? "employee"
		: "admin";
}
