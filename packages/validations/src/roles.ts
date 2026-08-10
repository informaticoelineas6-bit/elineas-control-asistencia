import { z } from "zod";

/**
 * Los cuatro roles del sistema (spec 03 §2).
 *
 * Los roles los otorga y almacena el Identity Server de Elineas; aquí sólo se
 * declara el vocabulario y su **prioridad**, que es lógica de este sistema: el
 * IS devuelve una lista plana, sin jerarquía (spec 03 §3).
 */
export const appRoleSchema = z.enum([
	"employee",
	"department_head",
	"global_manager",
	"superadmin",
]);

export type AppRole = z.infer<typeof appRoleSchema>;

/** Prioridad ascendente: gana el número más alto (RN-03.1). */
export const ROLE_PRIORITY: Record<AppRole, number> = {
	employee: 1,
	department_head: 2,
	global_manager: 3,
	superadmin: 4,
};

/**
 * Rol efectivo: el de mayor prioridad de los que el IS devuelve (RN-03.1).
 * Devuelve `null` si la lista viene vacía — ese usuario no tiene acceso a este
 * sistema (RN-03.5).
 */
export function getHighestRole(roles: readonly AppRole[]): AppRole | null {
	let highest: AppRole | null = null;
	for (const role of roles) {
		if (highest === null || ROLE_PRIORITY[role] > ROLE_PRIORITY[highest]) {
			highest = role;
		}
	}
	return highest;
}

/** `true` si `role` alcanza al menos la prioridad de `minimum`. */
export function roleAtLeast(role: AppRole | null, minimum: AppRole): boolean {
	return role !== null && ROLE_PRIORITY[role] >= ROLE_PRIORITY[minimum];
}
