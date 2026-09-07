import {
	createVacationRequestInputSchema,
	listVacationRequestsQuerySchema,
	reviewVacationRequestInputSchema,
	vacationBalanceSchema,
	vacationRequestSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de vacaciones (spec 11 §6).
 *
 * Roles mínimos que aplica el backend, según la matriz de la §5:
 * - **saldo y solicitudes propias**: cualquier autenticado que marque
 *   (`roleCanMark`) — `global_manager` no acumula ni solicita (RN-03.4).
 * - **saldo y solicitudes de otro**: `department_head` con ámbito sobre el
 *   departamento de esa persona, o `global_manager`.
 * - **revisar**: igual ámbito, y nunca sobre la propia (RN-11.8).
 * - **cancelar**: quien la pidió, o rol administrativo si ya empezó (RN-11.10).
 *
 * `GET /vacations/requests` es un único endpoint con dos ámbitos, por
 * `?scope=`: `own` (default, cualquiera) y `managed` (bandeja de un jefe o
 * gestor, RN-03.2). Es la misma idea que `/users?departmentId=`, adaptada a que
 * aquí "las tuyas" es la vista por defecto también para quien gestiona.
 */
export const vacationsSpec = {
	balance: {
		method: "GET",
		path: "/api/me/vacations/balance",
		response: vacationBalanceSchema,
	},
	balanceOfUser: {
		method: "GET",
		path: "/api/users/:id/vacations/balance",
		response: vacationBalanceSchema,
	},
	list: {
		method: "GET",
		path: "/api/vacations/requests",
		query: listVacationRequestsQuerySchema,
		response: z.array(vacationRequestSchema),
	},
	request: {
		method: "POST",
		path: "/api/vacations/requests",
		body: createVacationRequestInputSchema,
		response: vacationRequestSchema,
	},
	cancel: {
		method: "POST",
		path: "/api/vacations/requests/:id/cancel",
		response: vacationRequestSchema,
	},
	review: {
		method: "POST",
		path: "/api/vacations/requests/:id/review",
		body: reviewVacationRequestInputSchema,
		response: vacationRequestSchema,
	},
} as const;
