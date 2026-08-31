import { attendanceSpec } from "@elineas/contracts";
import {
	attendanceRangeQuerySchema,
	createAttendanceMarkInputSchema,
} from "@elineas/validations";
import { Hono } from "hono";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth } from "#/middleware/auth";
import {
	createMark,
	getMyDays,
	getStatus,
	getTodayMarks,
} from "#/services/attendance.ts";

/**
 * Marcaje de asistencia (spec 09 §6). Montado en `/api/attendance`.
 *
 * Los cuatro endpoints son **del usuario sobre sí mismo**: ninguno acepta un
 * identificador de persona, así que no hay forma de marcar por otro ni de leer su
 * historial desde aquí (los paneles de gestión son de las specs 15 y 16). Por eso
 * tampoco hay `requireRole`: el rol que no marca lo rechaza la validación con
 * `ROLE_CANNOT_MARK`, que es un motivo tipado y no un 403 sin explicación.
 *
 * `POST /marks` responde **200 con el rechazo tipado** cuando no se puede marcar, y
 * 201 cuando se creó la marca. Un rechazo no es un fallo de la petición: es un hecho
 * del negocio, queda registrado, y la interfaz necesita el motivo para reaccionar
 * distinto a cada uno (spec 09 §6).
 */
export const attendance = new Hono();

attendance.use("*", requireAuth);

attendance.post(
	"/marks",
	validate("json", createAttendanceMarkInputSchema),
	async (c) => {
		const auth = getAuth(c);
		const result = await createMark(
			auth.profile,
			auth.effectiveRole,
			c.req.valid("json"),
		);

		return c.json(
			attendanceSpec.create.response.parse(result),
			result.accepted && !result.duplicate ? 201 : 200,
		);
	},
);

attendance.get("/marks/today", async (c) => {
	const auth = getAuth(c);
	const marks = await getTodayMarks(auth.profile, auth.effectiveRole);
	return c.json(attendanceSpec.today.response.parse(marks));
});

attendance.get("/status", async (c) => {
	const auth = getAuth(c);
	const status = await getStatus(auth.profile, auth.effectiveRole);
	return c.json(attendanceSpec.status.response.parse(status));
});

attendance.get(
	"/me",
	validate("query", attendanceRangeQuerySchema),
	async (c) => {
		const days = await getMyDays(getAuth(c).profile, c.req.valid("query"));
		return c.json(attendanceSpec.mine.response.parse(days));
	},
);
