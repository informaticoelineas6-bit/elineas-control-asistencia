import {
	createDepartmentInputSchema,
	departmentMemberSchema,
	departmentSchema,
	departmentSummarySchema,
	listDepartmentsQuerySchema,
	pauseDepartmentInputSchema,
	updateDepartmentInputSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de departamentos (spec 01 §6).
 *
 * Roles mínimos que aplica el backend, según la matriz de la spec 01 §2:
 * - **lista**: cualquier usuario autenticado;
 * - **detalle y miembros**: `department_head` **con ámbito** sobre ese departamento;
 * - **crear, renombrar, pausar, reanudar, eliminar**: `global_manager`.
 *
 * El `path` con `:id` se escribe sólo aquí: el backend lo monta con esa misma
 * sintaxis y el frontend lo resuelve con `resolvePath` (ver `path.ts`).
 */
export const departmentsSpec = {
	list: {
		method: "GET",
		path: "/api/departments",
		query: listDepartmentsQuerySchema,
		response: z.array(departmentSummarySchema),
	},
	detail: {
		method: "GET",
		path: "/api/departments/:id",
		response: departmentSummarySchema,
	},
	members: {
		method: "GET",
		path: "/api/departments/:id/members",
		response: z.array(departmentMemberSchema),
	},
	create: {
		method: "POST",
		path: "/api/departments",
		body: createDepartmentInputSchema,
		response: departmentSchema,
	},
	update: {
		method: "PATCH",
		path: "/api/departments/:id",
		body: updateDepartmentInputSchema,
		response: departmentSchema,
	},
	pause: {
		method: "POST",
		path: "/api/departments/:id/pause",
		body: pauseDepartmentInputSchema,
		response: departmentSchema,
	},
	resume: {
		method: "POST",
		path: "/api/departments/:id/resume",
		response: departmentSchema,
	},
	remove: {
		method: "DELETE",
		path: "/api/departments/:id",
		response: z.object({ ok: z.literal(true) }),
	},
} as const;
