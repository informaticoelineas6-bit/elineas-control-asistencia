import {
	attendanceDayStatusSchema,
	type DayCode,
	dayCodeOf,
	type MonthlyReport,
	p95,
	type ReportKpis,
	type ReportScope,
	summarizeCodes,
} from "@elineas/validations";
import { eachDayOfInterval, format, parseISO } from "date-fns";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "#/db";
import { reportRuns } from "#/db/schema";
import { getConfig } from "#/services/config.ts";
import { dayKey, peopleInScope } from "#/services/daily-facts.ts";
import { readFacts, refreshDailyFacts } from "#/services/daily-facts-store.ts";

/**
 * El reporte mensual (spec 16 §2) y sus KPIs (§6).
 *
 * **De dónde salen los datos, y por qué se refresca al leer.** El reporte se
 * arma desde `attendance_daily_facts`, que es lo que la §4 pide para escala.
 * Pero un periodo que nunca se materializó daría un reporte vacío, y eso no es
 * "sin datos": es un error silencioso del peor tipo, porque parece un mes sin
 * ausencias. Así que **leer un periodo lo materializa primero**.
 *
 * Suena a que la caché no sirve de nada, y no es así: el refresco es idempotente
 * por RN-16.10 —recalcular da lo mismo—, cuesta las mismas consultas que un
 * panel (dos por rango más tres por departamento) y deja la tabla caliente para
 * la corrida asíncrona, para el recálculo del día anterior y para lo que venga.
 * Lo que se gana es que el reporte **no puede** estar incompleto por no haberse
 * acordado nadie de materializarlo.
 */

/**
 * El mes natural del periodo (decisión 3 de la §11).
 *
 * Todo en UTC, de punta a punta: `Date.UTC(año, mes, 0)` es el día 0 del mes
 * siguiente, es decir el último del actual, y `toISOString()` lo lee en la misma
 * zona en que se construyó.
 *
 * ⚠️ Construir el instante en UTC y formatearlo con `format` de date-fns —que es
 * local— da **el día anterior** en cualquier zona al oeste de Greenwich. Es
 * exactamente el error que RN-15.4 y la spec 07 §2 llevan advirtiendo, y aquí se
 * coló hasta que una prueba lo vio: en La Habana, marzo terminaba el 30.
 */
export function periodRange(period: string): { from: string; to: string } {
	const [year = 0, month = 1] = period.split("-").map(Number);
	const last = new Date(Date.UTC(year, month, 0));
	return { from: `${period}-01`, to: last.toISOString().slice(0, 10) };
}

export type Scope = { managedDepartmentIds: string[] | "all" };

/**
 * `GET /reports/monthly` y la entrada de la corrida asíncrona.
 *
 * **RN-16.2** — `include_heads_in_global_reports` decide si los jefes salen en
 * el reporte **global**. En el de un departamento salen siempre: quien lo pide
 * es su jefe y excluirse a sí mismo del reporte de su equipo no tiene sentido.
 * ⚠️ Este sistema no sabe qué perfiles tienen rol `department_head` sin que se
 * autentiquen (RN-00.43), así que la clave no se puede aplicar todavía; queda
 * anotado en la spec y es la quinta aparición de la decisión 3 de la spec 11.
 */
export async function buildMonthlyReport(
	scope: Scope,
	input: { period: string; departmentId?: string },
): Promise<MonthlyReport> {
	const range = periodRange(input.period);
	const people = await peopleInScope(scope, input.departmentId);

	const { ruleVersion } = await refreshDailyFacts(people, range);
	const facts = await readFacts(
		people.map((person) => person.id),
		range,
	);

	const days = eachDayOfInterval({
		start: parseISO(range.from),
		end: parseISO(range.to),
	}).map((day) => format(day, "yyyy-MM-dd"));

	const rows = people.map((person) => {
		const codes = days.map((date): DayCode => {
			const fact = facts.get(dayKey(person.id, date));
			// Sin hecho no debería quedar ninguno tras el refresco; si quedara, el
			// día se cuenta como no laborable en vez de inventar una ausencia que
			// nadie puede explicar.
			if (!fact) return "NL";

			const status = attendanceDayStatusSchema
				.catch("AUSENTE")
				.parse(fact.status);
			return dayCodeOf(
				status,
				fact.absenceCode === "AJ" || fact.absenceCode === "ANJ"
					? { code: fact.absenceCode, reviewed: true, notes: null }
					: null,
			);
		});

		return {
			userId: person.id,
			userFullName: person.fullName,
			userEmail: person.email,
			departmentId: person.departmentId,
			departmentName: person.departmentName,
			codes,
			summary: summarizeCodes(codes),
		};
	});

	return {
		period: input.period,
		scope: (input.departmentId ? "department" : "global") as ReportScope,
		departmentId: input.departmentId ?? null,
		days,
		rows,
		ruleVersion,
		generatedAt: new Date().toISOString(),
	};
}

// ── §6 Observabilidad ─────────────────────────────────────────────────────────

/**
 * KPIs de la reportería contra sus SLOs.
 *
 * ⚠️ **Hallazgo H-1:** en el legacy esta función llamaba a la comprobación de
 * jefe de departamento **con los argumentos invertidos** — fallaba cerrado, pero
 * un jefe nunca veía los KPIs de su departamento. Aquí no hay comprobación de
 * ámbito que invertir: estos KPIs son de la **reportería entera**, no de un
 * departamento, y la ruta los reserva a un gestor global con el mismo
 * `requireRole` que todo lo demás. El hallazgo se evita quitando la pieza que
 * fallaba, no reescribiéndola con cuidado.
 */
export async function getReportKpis(windowDays: number): Promise<ReportKpis> {
	const config = await getConfig();
	const since = new Date(Date.now() - windowDays * 86_400_000);

	const rows = await db
		.select({
			status: reportRuns.status,
			durationMs: reportRuns.durationMs,
		})
		.from(reportRuns)
		.where(gte(reportRuns.createdAt, since));

	const finished = rows.filter(
		(row) => row.status === "completed" || row.status === "failed",
	);
	const failed = finished.filter((row) => row.status === "failed").length;

	// Sobre las **terminadas**, no sobre todas: una corrida encolada hace un
	// segundo no es ni un éxito ni un fallo, y meterla en el denominador haría
	// que la tasa de error bajara sola por pedir reportes.
	const errorRatePct =
		finished.length === 0 ? 0 : (failed / finished.length) * 100;

	const durations = rows
		.filter((row) => row.status === "completed" && row.durationMs !== null)
		.map((row) => row.durationMs as number);

	return {
		windowDays,
		total: finished.length,
		failed,
		errorRatePct: Math.round(errorRatePct * 100) / 100,
		availabilityPct: Math.round((100 - errorRatePct) * 100) / 100,
		p95DurationMs: p95(durations),
		slo: {
			errorRatePct: config.report_slo_error_rate_pct,
			availabilityPct: config.report_slo_availability_pct,
		},
		meetsSlo:
			errorRatePct <= config.report_slo_error_rate_pct &&
			100 - errorRatePct >= config.report_slo_availability_pct,
	};
}

/** Para las pruebas: cuántas corridas hay en un estado. */
export async function countRuns(status: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(reportRuns)
		.where(and(eq(reportRuns.status, status)));
	return row?.count ?? 0;
}
