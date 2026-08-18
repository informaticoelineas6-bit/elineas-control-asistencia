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

/**
 * Ámbito de un perfil (RN-03.2): su propio departamento más los **adicionales**
 * que gestiona.
 *
 * Los adicionales son lo único de autorización que vive en nuestra base — el IS
 * dice qué rol tiene alguien, no qué departamentos gestiona (RN-00.43)—, así que
 * son también lo único que esta API puede otorgar o quitar. Los roles, no
 * (RN-03.8).
 */
export const departmentScopeSchema = z.object({
	id: z.uuid(),
	name: z.string(),
});

export const departmentResponsibilitiesSchema = z.object({
	profileId: z.uuid(),
	/** El del propio perfil. Entra en el ámbito sin estar en la tabla. */
	ownDepartment: departmentScopeSchema.nullable(),
	/** Los adicionales, que son los que esta API escribe. */
	additionalDepartments: z.array(departmentScopeSchema),
	/** La unión de los dos anteriores: el ámbito efectivo (RN-03.2). */
	managedDepartmentIds: z.array(z.uuid()),
});

/**
 * `PUT` de reemplazo, no de añadido: el cuerpo describe el conjunto completo de
 * departamentos adicionales. Es lo que hace que quitar uno sea posible sin un
 * `DELETE` por fila, y lo que deja una única entrada de bitácora por cambio.
 */
export const updateDepartmentResponsibilitiesInputSchema = z.object({
	departmentIds: z
		.array(z.uuid("El identificador de departamento no es válido."))
		.max(100, "Demasiados departamentos en una sola operación"),
});

export type DepartmentScope = z.infer<typeof departmentScopeSchema>;
export type DepartmentResponsibilities = z.infer<
	typeof departmentResponsibilitiesSchema
>;
export type UpdateDepartmentResponsibilitiesInput = z.infer<
	typeof updateDepartmentResponsibilitiesInputSchema
>;
