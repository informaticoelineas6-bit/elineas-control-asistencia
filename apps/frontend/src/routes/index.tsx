import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { createTodo, listTodos } from "#/lib/api-client";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	const [title, setTitle] = useState("");
	const queryClient = useQueryClient();

	const todos = useQuery({ queryKey: ["todos"], queryFn: listTodos });

	const createMutation = useMutation({
		mutationFn: createTodo,
		onSuccess: () => {
			setTitle("");
			queryClient.invalidateQueries({ queryKey: ["todos"] });
		},
	});

	return (
		<div className="p-8">
			<h1 className="text-4xl font-bold">Welcome to TanStack Start</h1>
			<p className="mt-4 text-lg">
				Edit <code>src/routes/index.tsx</code> to get started.
			</p>

			<section className="mt-8 max-w-md">
				<h2 className="text-xl font-semibold">
					Tareas (demo backend + frontend)
				</h2>

				<form
					className="mt-4 flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (title.trim()) createMutation.mutate({ title });
					}}
				>
					<input
						className="flex-1 border px-3 py-2"
						placeholder="Nueva tarea"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
					/>
					<button
						type="submit"
						className="border px-4 py-2"
						disabled={createMutation.isPending}
					>
						Agregar
					</button>
				</form>

				{todos.isLoading && <p className="mt-4">Cargando…</p>}
				{todos.isError && (
					<p className="mt-4 text-red-600">
						No se pudo conectar con el backend. ¿Está corriendo en
						VITE_BACKEND_URL?
					</p>
				)}
				{todos.data && (
					<ul className="mt-4 list-disc pl-5">
						{todos.data.map((todo) => (
							<li key={todo.id}>{todo.title}</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
