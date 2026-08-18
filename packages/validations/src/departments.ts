import { z } from "zod";

/**
 * Esquemas de departamentos (spec 01).
 *
 * El departamento es el ancla organizativa del sistema: de él cuelgan perfiles,
 * horarios, grupos de descanso, responsabilidades y el alcance de los reportes.
 *
 * **No hay jerarquía** (decisión 2 de la spec 01): la organización es plana, como
 * en el legacy. Si algún día hace falta un padre, es una migración, no un campo
 * que se deje preparado "por si acaso".
 */

/** RN-01.1: el nombre es único y no puede quedar vacío. */
export const departmentNameSchema = z
	.string()
	.trim()
	.min(1, "El nombre del departamento es obligatorio")
	.max(80, "El nombre no puede pasar de 80 caracteres");

export const departmentSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	/**
	 * Si es `true`, los descansos se gestionan por grupos y no individualmente
	 * (spec 10). Apagarlo **no borra** los grupos existentes (RN-01.6).
	 */
	restGroupsEnabled: z.boolean(),
	/** Bloquea el marcaje de todos sus miembros (RN-01.4). */
	isPaused: z.boolean(),
	/** Obligatorio mientras `isPaused` sea `true` (RN-01.3). */
	pauseReason: z.string().nullable(),
	pausedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * Departamento con sus conteos, que es la forma en la que lo pide la UI: la
 * tabla de gestión muestra nº de miembros, y el borrado depende de que no haya
 * ninguno (RN-01.2).
 */
export const departmentSummarySchema = departmentSchema.extend({
	memberCount: z.number().int().nonnegative(),
	activeMemberCount: z.number().int().nonnegative(),
	/**
	 * `true` si es el departamento al que se fuerzan los `global_manager`
	 * (RN-03.6). No se puede eliminar mientras lo sea.
	 */
	isGlobalManagerDepartment: z.boolean(),
});

/**
 * Miembro de un departamento. **Sin `monthlySalary` a propósito**: el dato
 * salarial no sale por ningún endpoint accesible a `department_head` (spec 02
 * §6, criterio de aceptación explícito).
 */
export const departmentMemberSchema = z.object({
	id: z.uuid(),
	fullName: z.string(),
	email: z.email(),
	phone: z.string().nullable(),
	isActive: z.boolean(),
});

export const createDepartmentInputSchema = z.object({
	name: departmentNameSchema,
});

export const updateDepartmentInputSchema = z
	.object({
		name: departmentNameSchema.optional(),
		restGroupsEnabled: z.boolean().optional(),
	})
	.refine(
		(patch) => Object.values(patch).some((value) => value !== undefined),
		{
			message: "No hay nada que actualizar",
		},
	);

/** RN-01.3: al pausar, el motivo es obligatorio. */
export const pauseDepartmentInputSchema = z.object({
	reason: z
		.string()
		.trim()
		.min(1, "El motivo de la pausa es obligatorio")
		.max(500, "El motivo no puede pasar de 500 caracteres"),
});

/**
 * `?includePaused=`. Por defecto **sí** se incluyen: la pantalla de gestión
 * tiene que verlos para poder reanudarlos, distinguidos con su badge (RN-01.7).
 * Quien necesite sólo los operativos —un selector de alta— lo pide explícito.
 */
export const listDepartmentsQuerySchema = z.object({
	includePaused: z.stringbool().default(true),
});

export type Department = z.infer<typeof departmentSchema>;
export type DepartmentSummary = z.infer<typeof departmentSummarySchema>;
export type DepartmentMember = z.infer<typeof departmentMemberSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentInputSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentInputSchema>;
export type PauseDepartmentInput = z.infer<typeof pauseDepartmentInputSchema>;
