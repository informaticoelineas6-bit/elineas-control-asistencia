import { z } from "zod";
import { appRoleSchema } from "./roles.ts";

/** Credenciales que el navegador manda a NUESTRO backend, nunca al IS (RN-00.35). */
export const loginInputSchema = z.object({
	email: z.email("Correo no válido"),
	password: z.string().min(1, "La contraseña es requerida"),
});

/** Identidad tal como la conoce el Identity Server. */
export const sessionUserSchema = z.object({
	/** `sub` del JWT: la clave de vínculo con nuestro perfil (RN-00.44/45). */
	identityUserId: z.string(),
	email: z.email(),
	name: z.string().nullable(),
});

/** Lo que este sistema sabe de la persona, más allá de su identidad. */
export const sessionProfileSchema = z.object({
	id: z.uuid(),
	fullName: z.string(),
	email: z.email(),
	departmentId: z.uuid().nullable(),
	phone: z.string().nullable(),
	isActive: z.boolean(),
	/**
	 * Un perfil sin departamento es un estado válido y transitorio (RN-02.3):
	 * la persona entra, ve "cuenta pendiente de configurar" y no puede marcar.
	 */
	isComplete: z.boolean(),
});

/**
 * Respuesta de `GET /api/me/permissions` (spec 03 §7). Es también la sonda de
 * sesión del frontend: si responde 200 hay sesión, si responde 401 no la hay.
 */
export const permissionsSchema = z.object({
	user: sessionUserSchema,
	profile: sessionProfileSchema,
	roles: z.array(appRoleSchema),
	/** Rol de mayor prioridad (RN-03.1). Nunca `null`: sin rol no hay sesión. */
	effectiveRole: appRoleSchema,
	/**
	 * Ámbito de un `department_head`: su departamento + los adicionales
	 * (RN-03.2). Vacío para `employee`; para gestión global no se usa.
	 */
	managedDepartmentIds: z.array(z.uuid()),
});

export type LoginInput = z.infer<typeof loginInputSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type Permissions = z.infer<typeof permissionsSchema>;
