import { todosSpec } from "@elineas/specs";
import type { CreateTodoInput } from "@elineas/validations";

const backendUrl = import.meta.env.VITE_BACKEND_URL;

export async function listTodos() {
	const res = await fetch(`${backendUrl}${todosSpec.list.path}`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error("No se pudieron obtener las tareas");
	return todosSpec.list.response.parse(await res.json());
}

export async function createTodo(input: CreateTodoInput) {
	const body = todosSpec.create.body.parse(input);
	const res = await fetch(`${backendUrl}${todosSpec.create.path}`, {
		method: todosSpec.create.method,
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error("No se pudo crear la tarea");
	return todosSpec.create.response.parse(await res.json());
}
