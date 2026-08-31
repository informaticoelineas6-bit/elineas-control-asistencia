import {
	compensationSchema,
	deactivateUserInputSchema,
	departmentResponsibilitiesSchema,
	listUsersQuerySchema,
	ownProfileSchema,
	updateCompensationInputSchema,
	updateDepartmentResponsibilitiesInputSchema,
	updateOwnProfileInputSchema,
	updateUserInputSchema,
	userProfileSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de usuarios y perfiles (spec 02 §7).
 *
 * **No hay `POST /users` ni reseteo de contraseña**: crear cuentas y gestionar
 * credenciales es del Identity Server (§5.1, RN-00.28). El alta es de dos pasos y
 * esta API sólo cubre el segundo.
 *
 * Roles mínimos, de la matriz §2:
 * - `me` / `updateMe`: cualquier autenticado, y sólo sobre sí mismo;
 * - `list`, `detail`: `department_head`, acotado a su ámbito;
 * - `incomplete`, `update`, `deactivate`, `reactivate`: `global_manager`;
 * - `compensation` y `updateCompensation`: `global_manager` (spec 02 §6);
 * - `responsibilities` y `updateResponsibilities`: `global_manager` (spec 03 §7);
 * - `remove`: `superadmin`.
 */
export const usersSpec = {
	me: {
		method: "GET",
		path: "/api/me",
		response: ownProfileSchema,
	},
	updateMe: {
		method: "PATCH",
		path: "/api/me",
		body: updateOwnProfileInputSchema,
		response: ownProfileSchema,
	},
	list: {
		method: "GET",
		path: "/api/users",
		query: listUsersQuerySchema,
		response: z.array(userProfileSchema),
	},
	/** Perfiles sin departamento: el alta que quedó a medias (RN-02.3). */
	incomplete: {
		method: "GET",
		path: "/api/users/incomplete",
		response: z.array(userProfileSchema),
	},
	detail: {
		method: "GET",
		path: "/api/users/:id",
		response: userProfileSchema,
	},
	update: {
		method: "PATCH",
		path: "/api/users/:id",
		body: updateUserInputSchema,
		response: userProfileSchema,
	},
	deactivate: {
		method: "POST",
		path: "/api/users/:id/deactivate",
		body: deactivateUserInputSchema,
		response: userProfileSchema,
	},
	reactivate: {
		method: "POST",
		path: "/api/users/:id/reactivate",
		response: userProfileSchema,
	},
	/** Borra el **perfil**, nunca la cuenta del IS (RN-02.8). */
	remove: {
		method: "DELETE",
		path: "/api/users/:id",
		response: z.object({ ok: z.literal(true) }),
	},
	/**
	 * El sueldo tiene endpoints aparte porque vive en su propia tabla (§6a). Que no
	 * comparta DTO con el perfil es la barrera: ningún otro endpoint puede
	 * devolverlo por descuido.
	 */
	compensation: {
		method: "GET",
		path: "/api/users/:id/compensation",
		response: compensationSchema,
	},
	updateCompensation: {
		method: "PUT",
		path: "/api/users/:id/compensation",
		body: updateCompensationInputSchema,
		response: compensationSchema,
	},
	/**
	 * Ámbito departamental (spec 03 §7). Es lo único de autorización que esta API
	 * escribe: los **roles** se otorgan en la consola del Identity Server y aquí no
	 * hay endpoint que los toque (RN-03.8).
	 */
	responsibilities: {
		method: "GET",
		path: "/api/users/:id/department-responsibilities",
		response: departmentResponsibilitiesSchema,
	},
	updateResponsibilities: {
		method: "PUT",
		path: "/api/users/:id/department-responsibilities",
		body: updateDepartmentResponsibilitiesInputSchema,
		response: departmentResponsibilitiesSchema,
	},
} as const;
