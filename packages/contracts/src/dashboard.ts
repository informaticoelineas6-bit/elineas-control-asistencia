import {
	attendanceDaySchema,
	dailyRangeQuerySchema,
	dailyRosterEntrySchema,
	dailyRosterQuerySchema,
	dashboardAlertsSchema,
	dashboardSummarySchema,
	dashboardTrendQuerySchema,
	dashboardTrendSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de paneles y dashboard (spec 15 §6).
 *
 * Los dos primeros cuelgan de `/attendance` y los tres últimos de `/dashboard`,
 * como propone la spec, y la división no es cosmética: los de `/attendance`
 * devuelven **días clasificados** —el mismo `DailyFact` que consume el historial
 * propio— y los de `/dashboard` devuelven **agregados de esos días**. Cuando
 * llegue la materialización de la [16](./16-reporteria-mensual.md) §4, lo que
 * cambia es de dónde salen los primeros; los segundos no se enteran.
 *
 * **Roles.** `summary` lo pide cualquier autenticado y su contenido depende del
 * rol (§5.1): un empleado recibe sólo lo suyo y `scope: null`. Los otros cuatro
 * exigen al menos `department_head`, porque no hay ninguna versión "propia" de
 * ellos que tenga sentido.
 *
 * **Ninguno acepta un parámetro que amplíe el ámbito.** La §6 pide que un
 * `department_head` que pida `scope=global` reciba 403; aquí ese parámetro no
 * existe: el ámbito sale de la sesión y `departmentId` sólo acota dentro de él.
 * Es la misma decisión que en `/absences`, y por el mismo motivo — el parámetro
 * que puede ensanchar el ámbito es el parámetro por el que se escapan los datos.
 */
export const dashboardSpec = {
	daily: {
		method: "GET",
		path: "/api/attendance/daily",
		query: dailyRosterQuerySchema,
		response: z.array(dailyRosterEntrySchema),
	},
	/**
	 * La serie de **una** persona del ámbito, con sus marcas. Es el detalle por
	 * empleado que pide la §5.3, y el equivalente de `/attendance/me` para quien
	 * gestiona; que sea de uno en uno es lo que permite devolver las marcas sin
	 * caer en el N+1 que la §4 prohíbe.
	 */
	dailyRange: {
		method: "GET",
		path: "/api/attendance/daily-range",
		query: dailyRangeQuerySchema,
		response: z.array(attendanceDaySchema),
	},
	summary: {
		method: "GET",
		path: "/api/dashboard/summary",
		response: dashboardSummarySchema,
	},
	trend: {
		method: "GET",
		path: "/api/dashboard/trend",
		query: dashboardTrendQuerySchema,
		response: dashboardTrendSchema,
	},
	alerts: {
		method: "GET",
		path: "/api/dashboard/alerts",
		response: dashboardAlertsSchema,
	},
} as const;
