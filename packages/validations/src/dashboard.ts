import { z } from "zod";
import {
	attendanceDaySchema,
	type attendanceDayStatusSchema,
} from "./attendance.ts";
import { isoDateSchema } from "./time.ts";
import { vacationBalanceSchema } from "./vacations.ts";

/**
 * Paneles y dashboard (spec 15 §5 y §6).
 *
 * La pieza central de esta spec —la agregación diaria— **no está aquí**: es
 * `computeDailyStatus`, y vive en el backend porque necesita contexto que el
 * cliente no tiene. Lo que hay aquí son las **formas de las tres vistas**, y una
 * regla de forma que la spec repite dos veces y conviene tener delante:
 *
 * > *El frontend no calcula estados* (§4). Recibe el día resuelto.
 *
 * Por eso ninguno de estos esquemas lleva insumos —ni horarios, ni descansos, ni
 * marcas crudas para clasificar—: llevan el resultado. Si algún día una pantalla
 * necesita recomponer un estado desde aquí, es que falta un campo, no que haya
 * que calcularlo en el cliente.
 */

/**
 * Cuántas personas hay en cada estado. Las seis claves son el vocabulario de la
 * §2, **enumeradas y obligatorias**: un contador que a veces no viene obliga a
 * escribir `?? 0` en cada sitio que lo pinte, y un estado nuevo en la spec 15
 * tiene que romper aquí para que nadie lo olvide en un panel.
 */
export const dayCountsSchema = z.object({
	PRESENTE: z.number().int().nonnegative(),
	TARDE: z.number().int().nonnegative(),
	AUSENTE: z.number().int().nonnegative(),
	DESCANSO: z.number().int().nonnegative(),
	NO_LABORABLE: z.number().int().nonnegative(),
	VACACIONES: z.number().int().nonnegative(),
});

export const EMPTY_DAY_COUNTS: DayCounts = {
	PRESENTE: 0,
	TARDE: 0,
	AUSENTE: 0,
	DESCANSO: 0,
	NO_LABORABLE: 0,
	VACACIONES: 0,
};

export function countDay(counts: DayCounts, status: AttendanceDayStatusKey) {
	counts[status] += 1;
}

/**
 * `GET /attendance/daily?date=&departmentId=` (§6): el día del equipo, persona a
 * persona. Es la vista de la §5.2 **y** la de la §5.3 — "hacen lo mismo con
 * distinto alcance", dice la spec, así que es una sola.
 *
 * ⚠️ **No lleva `scope=`, al contrario que la §6.** Esa sección pide que un
 * `department_head` que pida `scope=global` reciba 403; aquí no hay ningún
 * parámetro con el que ampliar el alcance, así que la propiedad se cumple más
 * fuerte: el ámbito sale de la sesión (RN-03.2) y `departmentId` sólo **acota**
 * dentro de él. El parámetro que podría ensanchar el ámbito es el parámetro por
 * el que se escapan los datos; no tenerlo es mejor que rechazarlo.
 */
export const dailyRosterQuerySchema = z.object({
	/** Sin fecha, hoy — en la zona del departamento, que resuelve el servidor. */
	date: isoDateSchema.optional(),
	departmentId: z.uuid().optional(),
});

/**
 * Una persona y su día, para la lista del panel.
 *
 * **Sin `marks`**, al contrario que el día del historial propio: traer las marcas
 * de cada persona es una consulta por persona o un `join` que multiplica filas,
 * y es justo el N+1 del que avisa la §4. El detalle de una persona concreta se
 * pide aparte, con `/attendance/daily-range?userId=`.
 */
export const dailyRosterEntrySchema = attendanceDaySchema
	.omit({ marks: true })
	.extend({
		userId: z.uuid(),
		userFullName: z.string(),
		userEmail: z.string(),
		departmentId: z.uuid().nullable(),
		departmentName: z.string().nullable(),
		/**
		 * `true` si hay una entrada sin su salida **y el día todavía está en
		 * curso**: la aproximación honesta a "quién está dentro ahora mismo" (§8,
		 * decisión 4). No es lo mismo que estar dentro de la geocerca — eso exige
		 * geolocalización en segundo plano, que es una decisión abierta de la
		 * [spec 20] §7 — pero es lo que un jefe de planta puede usar hoy.
		 */
		open: z.boolean(),
	});

/** `GET /attendance/daily-range?from=&to=&userId=` (§6): la serie de una persona. */
export const dailyRangeQuerySchema = z
	.object({
		userId: z.uuid(),
		from: isoDateSchema,
		to: isoDateSchema,
	})
	.refine(({ from, to }) => from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	})
	.refine(
		({ from, to }) =>
			(Date.parse(`${to}T00:00:00.000Z`) -
				Date.parse(`${from}T00:00:00.000Z`)) /
				86_400_000 <=
			366,
		{ message: "El rango no puede pasar de un año." },
	);

// ── §5.1 Dashboard ────────────────────────────────────────────────────────────

/**
 * Lo propio: el día de hoy de quien pregunta y su saldo de vacaciones.
 *
 * Nulo entero para quien no marca (RN-03.4): a un `global_manager` no se le
 * enseña una tarjeta vacía de "tu estado de hoy", que parecería un fallo de
 * configuración.
 */
export const personalSummarySchema = z.object({
	day: attendanceDaySchema.omit({ marks: true }).nullable(),
	vacationBalance: vacationBalanceSchema.nullable(),
});

export const departmentDaySummarySchema = z.object({
	departmentId: z.uuid(),
	departmentName: z.string(),
	isPaused: z.boolean(),
	total: z.number().int().nonnegative(),
	counts: dayCountsSchema,
});

/**
 * Lo del ámbito: el resumen de hoy y su desglose por departamento.
 *
 * Es **la misma forma para las dos filas de gestión de la §5.1** —el jefe y el
 * gestor global— porque su diferencia es sólo cuánto abarca `managedDepartmentIds`.
 * El "resumen ejecutivo global, por departamento" que la spec pide para el gestor
 * es este mismo objeto cuando el ámbito es toda la empresa.
 */
export const scopeSummarySchema = z.object({
	total: z.number().int().nonnegative(),
	counts: dayCountsSchema,
	/** Jornadas abiertas ahora mismo dentro del ámbito. */
	open: z.number().int().nonnegative(),
	byDepartment: z.array(departmentDaySummarySchema),
});

export const dashboardSummarySchema = z.object({
	/** El día que se está resumiendo, en la zona que corresponde (RN-15.4). */
	date: isoDateSchema,
	me: personalSummarySchema.nullable(),
	scope: scopeSummarySchema.nullable(),
});

export const dashboardTrendQuerySchema = z.object({
	days: z.coerce.number().int().min(2).max(31).default(7),
});

export const dashboardTrendSchema = z.object({
	days: z.array(
		z.object({
			date: isoDateSchema,
			total: z.number().int().nonnegative(),
			counts: dayCountsSchema,
		}),
	),
});

/**
 * Las alertas de gestión de la §5.1, **como conteos tipados y no como frases**.
 *
 * El servidor manda `kind` y `count`; la etiqueta y el enlace los pone la
 * interfaz. Es lo contrario de lo que hacen las notificaciones (spec 14), donde
 * el cuerpo y el `actionUrl` sí viajan desde el servidor — y la diferencia es
 * que una notificación es **un hecho ya ocurrido y congelado**, mientras que una
 * alerta es un contador vivo que se pinta distinto en cada sitio. Mandar la
 * frase hecha ataría el texto del panel al backend.
 */
export const dashboardAlertKindSchema = z.enum([
	/** Días ausentes sin decisión (spec 13 §5). */
	"absences_unreviewed",
	/** Incidencias esperando revisión (spec 12 §7). */
	"incidents_pending",
	/** Solicitudes de vacaciones por aprobar (spec 11 §5.2). */
	"vacations_pending",
	/** Departamentos en pausa dentro del ámbito (spec 01 RN-01.4). */
	"departments_paused",
]);

export const DASHBOARD_ALERT_LABELS: Record<DashboardAlertKind, string> = {
	absences_unreviewed: "ausencias sin clasificar",
	incidents_pending: "incidencias por revisar",
	vacations_pending: "vacaciones por aprobar",
	departments_paused: "departamentos en pausa",
};

export const dashboardAlertSchema = z.object({
	kind: dashboardAlertKindSchema,
	count: z.number().int().positive(),
});

/** Sólo las que tienen algo pendiente: una alerta con cero no es una alerta. */
export const dashboardAlertsSchema = z.object({
	alerts: z.array(dashboardAlertSchema),
});

type AttendanceDayStatusKey = z.infer<typeof attendanceDayStatusSchema>;

export type DayCounts = z.infer<typeof dayCountsSchema>;
export type DailyRosterQuery = z.infer<typeof dailyRosterQuerySchema>;
export type DailyRosterEntry = z.infer<typeof dailyRosterEntrySchema>;
export type DailyRangeQuery = z.infer<typeof dailyRangeQuerySchema>;
export type PersonalSummary = z.infer<typeof personalSummarySchema>;
export type DepartmentDaySummary = z.infer<typeof departmentDaySummarySchema>;
export type ScopeSummary = z.infer<typeof scopeSummarySchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
export type DashboardTrendQuery = z.infer<typeof dashboardTrendQuerySchema>;
export type DashboardTrend = z.infer<typeof dashboardTrendSchema>;
export type DashboardAlertKind = z.infer<typeof dashboardAlertKindSchema>;
export type DashboardAlert = z.infer<typeof dashboardAlertSchema>;
export type DashboardAlerts = z.infer<typeof dashboardAlertsSchema>;
