import { createTodoSchema } from "@elineas/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { db } from "#/db";
import { todos as todosTable } from "#/db/schema";

export const todos = new Hono();

todos.get("/", async (c) => {
	const result = await db.select().from(todosTable);
	return c.json(result);
});

todos.post("/", zValidator("json", createTodoSchema), async (c) => {
	const { title } = c.req.valid("json");
	const [created] = await db.insert(todosTable).values({ title }).returning();
	return c.json(created, 201);
});
