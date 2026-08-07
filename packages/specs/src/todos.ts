import { createTodoSchema, todoSchema } from "@elineas/validations";
import { z } from "zod";

/**
 * Definición de contrato (spec) del recurso `todos`.
 *
 * Es la única fuente de verdad para path, método y esquemas de request/response
 * de este endpoint. El backend (Hono) la usa para validar y tipar sus handlers,
 * y el frontend la usa para construir llamadas fetch tipadas y parsear la
 * respuesta. Si el contrato cambia, ambos lados se actualizan desde este archivo.
 */
export const todosSpec = {
	list: {
		method: "GET",
		path: "/api/todos",
		response: z.array(todoSchema),
	},
	create: {
		method: "POST",
		path: "/api/todos",
		body: createTodoSchema,
		response: todoSchema,
	},
} as const;
