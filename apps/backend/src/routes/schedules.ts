import { schedulesSpec } from "@elineas/contracts";
import {
	updateDepartmentScheduleInputSchema,
	updateWorkCalendarInputSchema,
	workCalendarQuerySchema,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import {
	getAuth,
	requireAuth,
	requireRole,
	requireScope,
} from "#/middleware/auth";
import {
	deleteSchedule,
	getCalendar,
	getSchedule,
	upsertCalendar,
	upsertSchedule,
} from "#/services/schedules.ts";

/**
 * Horarios y calendario laboral (spec 07 §5). Montado en `/api/departments`,
 * junto al router de la spec 01: los dos recursos cuelgan del departamento y sus
 * paths viven una sola vez, en el contrato.
 *
 * El reparto de roles es el de la spec 07 §5 y tiene un motivo: **leer** el
 * horario lo necesita un `department_head` para saber qué se le exige a su gente,
 * pero **escribirlo** es una regla de empresa que además notifica a todos los
 * miembros (RN-07.10), así que se queda en `global_manager`.
 */
export const schedules = new Hono();

schedules.use("*", requireAuth);

const idParam = z.object({
	id: z.uuid("El identificador de departamento no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/** Lectura del horario: `department_head` **con ámbito** (RN-03.2). */
schedules.get(
	"/:id/schedule",
	requireRole("department_head"),
	validate("param", idParam),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), id);

		return c.json(schedulesSpec.get.response.parse(await getSchedule(id)));
	},
);

schedules.put(
	"/:id/schedule",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateDepartmentScheduleInputSchema),
	async (c) => {
		const saved = await upsertSchedule(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(schedulesSpec.update.response.parse(saved));
	},
);

/**
 * Quitar el horario. No está en la §5 de la spec: se añade porque el borrado de un
 * departamento se bloquea si tiene horario (spec 01 §5.2) y sin esto ese bloqueo
 * no tendría salida.
 */
schedules.delete(
	"/:id/schedule",
	requireRole("global_manager"),
	validate("param", idParam),
	async (c) => {
		await deleteSchedule(c.req.valid("param").id, actorOf(c));
		return c.json({ ok: true } as const);
	},
);

schedules.get(
	"/:id/calendar",
	requireRole("department_head"),
	validate("param", idParam),
	validate("query", workCalendarQuerySchema),
	async (c) => {
		const { id } = c.req.valid("param");
		requireScope(getAuth(c), id);

		const entries = await getCalendar(id, c.req.valid("query"));
		return c.json(schedulesSpec.calendar.response.parse(entries));
	},
);

schedules.put(
	"/:id/calendar",
	requireRole("global_manager"),
	validate("param", idParam),
	validate("json", updateWorkCalendarInputSchema),
	async (c) => {
		const entries = await upsertCalendar(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(schedulesSpec.updateCalendar.response.parse(entries));
	},
);
