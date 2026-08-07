import { z } from "zod";

/**
 * Esquema de una tarea (todo) tal como se persiste y se devuelve al cliente.
 */
export const todoSchema = z.object({
	id: z.number(),
	title: z.string(),
	createdAt: z.union([z.string(), z.date()]).nullable(),
});

/**
 * Esquema de entrada para crear una tarea. Se usa tanto en el backend
 * (validación de la petición) como en el frontend (validación de formularios).
 */
export const createTodoSchema = z.object({
	title: z.string().min(1, "El título es requerido"),
});

export type Todo = z.infer<typeof todoSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
