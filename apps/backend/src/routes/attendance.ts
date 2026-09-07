import { attendanceSpec, dashboardSpec } from "@elineas/contracts";
import {
	attendanceRangeQuerySchema,
	createAttendanceMarkInputSchema,
	dailyRangeQuerySchema,
	dailyRosterQuerySchema,
	roleAtLeast,
} from "@elineas/validations";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "#/lib/validate.ts";
import {
	type AuthContext,
	canManage,
	getAuth,
	requireAuth,
	requireRole,
	requireScope,
} from "#/middleware/auth";
import {
	createMark,
	getDaysFor,
	getStatus,
	getTodayMarks,
} from "#/services/attendance.ts";
import { getDaysOfUser, listDailyRoster } from "#/services/dashboard.ts";
import { getProfileRow } from "#/services/users.ts";

/**
 * Marcaje de asistencia (spec 09 §6). Montado en `/api/attendance`.
 *
 * Los cuatro primeros endpoints son **del usuario sobre sí mismo**: ninguno acepta
 * un identificador de persona, así que no hay forma de marcar por otro ni de leer
 * su historial desde ahí. Por eso tampoco llevan `requireRole`: el rol que no
 * marca lo rechaza la validación con `ROLE_CANNOT_MARK`, que es un motivo tipado
 * y no un 403 sin explicación.
 *
 * Los dos últimos —`/daily` y `/daily-range`, de la [spec 15] §6— son de
 * **gestión**: exigen `department_head` y se acotan al ámbito de quien pregunta.
 * Cuelgan de este prefijo porque devuelven días clasificados, que es lo que este
 * router sirve; los agregados de esos días viven en `/api/dashboard`.
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
		const days = await getDaysFor(getAuth(c).profile, c.req.valid("query"));
		return c.json(attendanceSpec.mine.response.parse(days));
	},
);

// ── Paneles (spec 15 §5.2 y §5.3, que son la misma vista) ─────────────────────

/** `"all"` para un gestor global; la lista concreta para un jefe (RN-03.2). */
const managedScope = (auth: AuthContext) => ({
	managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
		? ("all" as const)
		: auth.managedDepartmentIds,
});

/**
 * `GET /attendance/daily?date=&departmentId=`: el día del ámbito, persona a
 * persona.
 *
 * **No hay `scope=`.** La §6 pedía rechazar con 403 a un `department_head` que
 * pidiera `scope=global`; aquí ese parámetro no existe, así que la propiedad se
 * cumple más fuerte — el ámbito sale de la sesión y `departmentId` sólo acota
 * dentro de él, comprobado con `requireScope` como en `/users`.
 */
attendance.get(
	"/daily",
	requireRole("department_head"),
	validate("query", dailyRosterQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const query = c.req.valid("query");
		if (query.departmentId) requireScope(auth, query.departmentId);

		const roster = await listDailyRoster(managedScope(auth), query);
		return c.json(dashboardSpec.daily.response.parse(roster));
	},
);

/**
 * `GET /attendance/daily-range?userId=&from=&to=`: el detalle de una persona del
 * ámbito, con sus marcas (§5.3, "detalle por empleado").
 *
 * El ámbito se comprueba contra el departamento **de esa persona**, leído de su
 * perfil, igual que en `/absences` y en la revisión de incidencias.
 */
attendance.get(
	"/daily-range",
	requireRole("department_head"),
	validate("query", dailyRangeQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const { userId, ...range } = c.req.valid("query");

		const target = await getProfileRow(userId);
		if (!canManage(auth, target.departmentId)) {
			throw new HTTPException(403, {
				message: "Esa persona está fuera de tu ámbito.",
			});
		}

		const days = await getDaysOfUser(target, range);
		return c.json(dashboardSpec.dailyRange.response.parse(days));
	},
);
