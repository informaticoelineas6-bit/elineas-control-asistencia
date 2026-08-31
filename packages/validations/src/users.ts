import { z } from "zod";
import { currencySchema, DEFAULT_CURRENCY } from "./currency.ts";
import { optionalPhoneSchema } from "./phone.ts";

/**
 * Esquemas de usuarios y perfiles (spec 02).
 *
 * El **perfil de negocio** es lo único que vive en este sistema: departamento,
 * teléfono, estado operativo. La identidad —credenciales, sesión, roles— es del
 * Identity Server (RN-00.27/29), y esta aplicación no da de alta a nadie
 * (RN-00.28): el perfil se crea solo, en el primer ingreso (RN-02.1).
 *
 * **El sueldo no aparece en ninguno de estos esquemas.** Vive en su propia tabla
 * y tiene sus propios endpoints (§6a), justamente para que no pueda colarse en un
 * DTO compartido — que es cómo el legacy acabó exponiéndolo (hallazgo H-3).
 */

/** Estado operativo de una cuenta en **este** sistema, no en el IS. */
export const profileStatusSchema = z.enum([
	/** Sin departamento: entra, pero no puede marcar (RN-02.3). */
	"incomplete",
	"active",
	/** Baja de este sistema; su cuenta del IS sigue existiendo (RN-02.4). */
	"inactive",
]);

/**
 * Perfil tal como lo ve quien lo gestiona. `departmentName` viaja resuelto porque
 * toda pantalla que lista perfiles necesita el nombre, y pedirlo aparte obligaría
 * a cruzar dos consultas en el cliente.
 *
 * **El `identity_user_id` no sale por la API.** Es la clave interna de vínculo con
 * el Identity Server (RN-00.44) y ninguna pantalla la usa: enseñar un uuid opaco no
 * ayuda a nadie, y mandarlo en cada listado es exponer sin motivo por dónde se une
 * este sistema con el de identidad.
 */
export const userProfileSchema = z.object({
	id: z.uuid(),
	email: z.email(),
	fullName: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	phone: z.string().nullable(),
	status: profileStatusSchema,
	isActive: z.boolean(),
	isComplete: z.boolean(),
	deactivatedAt: z.iso.datetime().nullable(),
	deactivationReason: z.string().nullable(),
	/** Fin de la relación laboral. Independiente de `isActive` (RN-02.6). */
	contractCancelledAt: z.iso.datetime().nullable(),
	lastConnectionAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
});

/**
 * Perfil propio (`GET /api/me`). No trae los datos de la baja —quien está dentro
 * está activo— ni el sueldo: la matriz de la spec 02 §2 no se lo concede a
 * `employee` ni a `department_head`, y no se hace una excepción por ser el suyo.
 */
export const ownProfileSchema = z.object({
	id: z.uuid(),
	email: z.email(),
	fullName: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	phone: z.string().nullable(),
	isComplete: z.boolean(),
	contractCancelledAt: z.iso.datetime().nullable(),
	lastConnectionAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
});

/** Lo único que cada persona cambia de sí misma: cómo contactarla. */
export const updateOwnProfileInputSchema = z.object({
	/** Misma validación que el Identity Server (ver `phone.ts`). */
	phone: optionalPhoneSchema,
});

/**
 * Lo que un `global_manager` cambia de otro. El nombre y el correo **no están**:
 * son de la identidad y se sincronizan desde el IS (RN-00.45); cambiarlos aquí
 * crearía dos verdades.
 */
export const updateUserInputSchema = z
	.object({
		departmentId: z.uuid().nullable().optional(),
		phone: optionalPhoneSchema.optional(),
		contractCancelledAt: z.iso.datetime().nullable().optional(),
	})
	.refine(
		(patch) => Object.values(patch).some((value) => value !== undefined),
		{ message: "No hay nada que actualizar" },
	);

/** RN-02.5: el motivo es obligatorio al desactivar. */
export const deactivateUserInputSchema = z.object({
	reason: z
		.string()
		.trim()
		.min(1, "El motivo de la desactivación es obligatorio")
		.max(500, "El motivo no puede pasar de 500 caracteres"),
});

export const listUsersQuerySchema = z.object({
	departmentId: z.uuid().optional(),
	/** Por defecto no se listan las bajas: son historial, no operación. */
	includeInactive: z.stringbool().default(false),
	/** Busca por nombre o correo. */
	search: z.string().trim().max(120).optional(),
});

/**
 * Compensación (spec 02 §6a). Endpoints propios y separados, para que el sueldo no
 * viaje nunca en el mismo DTO que el perfil.
 *
 * Se representa como cadena, no como número: es `numeric` en Postgres y pasar por
 * un `double` de JavaScript le quita exactitud a un dato de dinero.
 */
export const compensationSchema = z.object({
	profileId: z.uuid(),
	monthlySalary: z.string().nullable(),
	/** El importe nunca viaja sin su moneda. */
	currency: currencySchema,
	updatedAt: z.iso.datetime().nullable(),
});

export const updateCompensationInputSchema = z.object({
	monthlySalary: z
		.string()
		.trim()
		.regex(/^\d{1,10}(\.\d{1,2})?$/, "Importe no válido (por ejemplo: 3500.00)")
		.nullable(),
	currency: currencySchema.default(DEFAULT_CURRENCY),
});

export type ProfileStatus = z.infer<typeof profileStatusSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type OwnProfile = z.infer<typeof ownProfileSchema>;
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileInputSchema>;
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
export type DeactivateUserInput = z.infer<typeof deactivateUserInputSchema>;
export type Compensation = z.infer<typeof compensationSchema>;
export type UpdateCompensationInput = z.infer<
	typeof updateCompensationInputSchema
>;
