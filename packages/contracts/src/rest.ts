import {
	createRestGroupInputSchema,
	departmentRestDaysSchema,
	restDaysRangeQuerySchema,
	restGroupSchema,
	restScheduleQuerySchema,
	restScheduleViewSchema,
	updateRestGroupInputSchema,
	updateRestGroupMembersInputSchema,
	updateRestScheduleInputSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de descansos (spec 10 §6).
 *
 * Roles mínimos que aplica el backend, según la matriz de la §4:
 * - **`/me/rest-schedule`**: cualquier autenticado, y sólo sobre lo suyo. El
 *   `PUT` sólo tiene efecto en modo individual (RN-10.2).
 * - **`/users/:id/rest-schedule`**: `department_head` **con ámbito** sobre el
 *   departamento de esa persona.
 * - **grupos**: crear, editar y retirar es de `global_manager` —los días de un
 *   grupo son una regla de empresa—; **asignar personas** es de
 *   `department_head` con ámbito, que es quien organiza los turnos de su gente.
 *
 * Dos desviaciones de la tabla de la §6, las dos por forma:
 *
 * 1. **La creación es `POST /api/departments/:id/rest-groups`**, no
 *    `POST /rest-groups/:id`. Un grupo pertenece a un departamento y no tiene id
 *    antes de existir; el `:id` de la spec era el del departamento, y ponerlo
 *    donde ya está en el `GET` evita dos formas de decir lo mismo.
 * 2. **Se añade `GET /api/departments/:id/rest-days`**, que la §6 no lista, para
 *    el calendario de equipo que sí pide la §7: resolverlo en el cliente
 *    obligaría a pedir los descansos persona a persona y a repetir allí la
 *    precedencia de RN-10.2.
 */
export const restSpec = {
	mine: {
		method: "GET",
		path: "/api/me/rest-schedule",
		query: restScheduleQuerySchema,
		response: restScheduleViewSchema,
	},
	updateMine: {
		method: "PUT",
		path: "/api/me/rest-schedule",
		body: updateRestScheduleInputSchema,
		response: restScheduleViewSchema,
	},
	ofUser: {
		method: "GET",
		path: "/api/users/:id/rest-schedule",
		query: restScheduleQuerySchema,
		response: restScheduleViewSchema,
	},
	updateOfUser: {
		method: "PUT",
		path: "/api/users/:id/rest-schedule",
		body: updateRestScheduleInputSchema,
		response: restScheduleViewSchema,
	},
	groups: {
		method: "GET",
		path: "/api/departments/:id/rest-groups",
		response: z.array(restGroupSchema),
	},
	createGroup: {
		method: "POST",
		path: "/api/departments/:id/rest-groups",
		body: createRestGroupInputSchema,
		response: restGroupSchema,
	},
	updateGroup: {
		method: "PATCH",
		path: "/api/rest-groups/:id",
		body: updateRestGroupInputSchema,
		response: restGroupSchema,
	},
	removeGroup: {
		method: "DELETE",
		path: "/api/rest-groups/:id",
		response: z.object({ ok: z.literal(true) }),
	},
	/** Reemplazo con fecha: devuelve **todos** los grupos del departamento, porque
	 * mover a alguien de grupo cambia dos listas a la vez. */
	setMembers: {
		method: "PUT",
		path: "/api/rest-groups/:id/members",
		body: updateRestGroupMembersInputSchema,
		response: z.array(restGroupSchema),
	},
	departmentRestDays: {
		method: "GET",
		path: "/api/departments/:id/rest-days",
		query: restDaysRangeQuerySchema,
		response: departmentRestDaysSchema,
	},
} as const;
