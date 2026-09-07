import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { attendanceRuleVersions } from "#/db/schema";
import type { Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";

/**
 * Versiones de reglas (spec 16 §5).
 *
 * Responde a una pregunta muy concreta que el legacy no podía contestar: *"¿por
 * qué en marzo este día salía distinto?"*. La configuración cambia y los cambios
 * **no son retroactivos** (RN-06.4), así que la única forma de explicar un
 * cálculo viejo es haber guardado los valores con los que se hizo.
 *
 * **Qué claves entran en la foto** (`CALCULATION_KEYS`): sólo las que cambian el
 * resultado de clasificar un día. La zona horaria, la tolerancia y los
 * descansos, sí; el identificador de la hoja de cálculo o los SLOs, no —
 * meterlos crearía una versión nueva cada vez que alguien corrige una URL, y el
 * historial dejaría de significar nada.
 *
 * **RN-16.13, la pregunta "confirmar si el legacy lo hace automáticamente o a
 * mano": aquí es automático, pero perezoso.** No hay un disparador sobre la
 * tabla de configuración; la versión se comprueba y se crea cuando algo va a
 * *usarla* — al materializar hechos o al encolar una corrida. Un disparador
 * tendría que decidir qué hacer con las claves que no afectan al cálculo, y
 * versionar en el momento del uso da exactamente la misma respuesta con una
 * pieza menos que mantener.
 */

/** Las claves de configuración que cambian cómo se clasifica un día. */
const CALCULATION_KEYS = [
	"global_timezone",
	"late_tolerance_minutes",
	"attendance_checkout_mode",
	"attendance_auto_checkout_time",
	"attendance_geofence_exit_minutes",
	"rest_days_min_separation",
	"rest_days_min_per_week",
	"rest_days_max_per_week",
	"vacation_days_per_worked_day",
	"payroll_daily_divisor",
] as const;

export type RuleVersion = { id: string; version: number };

async function snapshot(): Promise<Record<string, unknown>> {
	const config = await getConfig();
	return Object.fromEntries(
		CALCULATION_KEYS.map((key) => [key, config[key]]),
	) as Record<string, unknown>;
}

/**
 * La versión vigente, creándola si la configuración cambió desde la última.
 *
 * La comparación es sobre el JSON **ordenado por clave**: dos objetos con las
 * mismas claves en distinto orden son la misma configuración, y sin ordenar
 * crearían una versión nueva cada vez que alguien reordena el catálogo.
 */
export async function currentRuleVersion(): Promise<RuleVersion> {
	const params = await snapshot();
	const fingerprint = JSON.stringify(params, Object.keys(params).sort());

	const [active] = await db
		.select()
		.from(attendanceRuleVersions)
		.where(eq(attendanceRuleVersions.isActive, true));

	if (active) {
		const previous = JSON.stringify(
			active.params,
			Object.keys(active.params as object).sort(),
		);
		if (previous === fingerprint) {
			return { id: active.id, version: active.version };
		}
	}

	return db.transaction(async (tx) => {
		// Se relee dentro de la transacción: dos peticiones simultáneas que vean la
		// misma configuración nueva no deben crear dos versiones. La segunda
		// encuentra la que escribió la primera y la reutiliza.
		const [current] = await tx
			.select()
			.from(attendanceRuleVersions)
			.where(eq(attendanceRuleVersions.isActive, true))
			.for("update");

		if (current) {
			const previous = JSON.stringify(
				current.params,
				Object.keys(current.params as object).sort(),
			);
			if (previous === fingerprint) {
				return { id: current.id, version: current.version };
			}
			await tx
				.update(attendanceRuleVersions)
				.set({ isActive: false })
				.where(eq(attendanceRuleVersions.id, current.id));
		}

		const [{ next } = { next: 1 }] = await tx
			.select({
				next: sql<number>`coalesce(max(${attendanceRuleVersions.version}), 0) + 1`,
			})
			.from(attendanceRuleVersions);

		const [created] = await tx
			.insert(attendanceRuleVersions)
			.values({ version: next, params, isActive: true })
			.returning();

		if (!created) {
			throw new Error("No se pudo crear la versión de reglas.");
		}
		return { id: created.id, version: created.version };
	});
}

/** El número legible de una versión, para pintarlo en un reporte. */
export async function ruleVersionNumber(
	database: Database,
	id: string,
): Promise<number> {
	const [row] = await database
		.select({ version: attendanceRuleVersions.version })
		.from(attendanceRuleVersions)
		.where(eq(attendanceRuleVersions.id, id));
	return row?.version ?? 0;
}

/** Para el panel de auditoría y las pruebas: el historial, de la más nueva a la más vieja. */
export async function listRuleVersions() {
	return db
		.select()
		.from(attendanceRuleVersions)
		.orderBy(desc(attendanceRuleVersions.version));
}

/** Sólo para pruebas: ¿existe ya una versión con estos params y activa? */
export async function activeRuleVersionId(): Promise<string | null> {
	const [row] = await db
		.select({ id: attendanceRuleVersions.id })
		.from(attendanceRuleVersions)
		.where(and(eq(attendanceRuleVersions.isActive, true)));
	return row?.id ?? null;
}
