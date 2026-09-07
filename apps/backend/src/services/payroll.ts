import {
	type Currency,
	currencySchema,
	effectivePeriodOf,
	type PayrollAdjustmentEffect,
} from "@elineas/validations";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { employeeCompensation, payrollAdjustments } from "#/db/schema";
import { type Actor, audit, type Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";

/**
 * Nómina (spec 17), **sólo la parte que dispara la spec 13**.
 *
 * Este archivo es la barrera de privilegios de RN-13.5. En el legacy era un
 * trigger `SECURITY DEFINER` sobre `attendance_absence_reviews`, porque quien
 * justifica —el `department_head`— no tiene ni debe tener acceso a la tabla de
 * nómina (RN-17.1, hallazgo H-3). Aquí el equivalente es más simple y más
 * legible: **no hay ninguna ruta que exponga estas funciones**. Se llaman desde
 * `services/absences.ts`, dentro de la transacción de la revisión, y reciben la
 * transacción como primer argumento por lo mismo que `audit` y `notify` — si la
 * revisión se revierte, el ajuste también.
 *
 * Buscar "payroll" en `routes/` no da nada, y eso es la comprobación de la
 * barrera: `/payroll/*` llega con la spec 17.
 *
 * **RN-17.12 (decisión 1 de la spec 17), cerrada: el cálculo se hace en
 * PostgreSQL.** `-round(monthly_salary::numeric / divisor, 2)` con el sueldo
 * viajando como cadena hasta el parámetro. En JavaScript habría que pasarlo por
 * un `double`, que es exactamente lo que la compensación de la spec 02 evita al
 * representar el importe como cadena: un dato de dinero no pasa por coma
 * flotante. `round()` de PostgreSQL sobre `numeric` es media al alza y exacto.
 *
 * **RN-17.5, idempotencia, la sostiene la base**: el índice único parcial
 * `payroll_adjustments_active_source_idx` impide dos ajustes `active` para el
 * mismo origen. Estas funciones no comprueban antes de escribir; escriben y
 * miran si escribieron, que es lo único que gana la carrera de dos revisiones
 * simultáneas del mismo día.
 */

const SOURCE_TYPE = "absence_review";

const unchanged: PayrollAdjustmentEffect = {
	effect: "unchanged",
	amount: null,
	currency: null,
	effectivePeriod: null,
};

const toCurrency = (value: string): Currency =>
	currencySchema.catch("CUP").parse(value);

/**
 * RN-13.4 / RN-17.2 — Crea el descuento de un día por ausencia injustificada.
 *
 * Devuelve `skipped_no_salary` si no hay sueldo configurado (RN-17.7): **no
 * falla**. Que la revisión de una ausencia se caiga porque a alguien le falta el
 * sueldo dejaría la decisión sin tomar por un dato de otro departamento; el
 * aviso va en la respuesta, que es lo que la regla pide —"una advertencia
 * visible para el administrador, no fallar en silencio"— y llega a quien acaba
 * de actuar en vez de a un buzón que nadie mira.
 *
 * ⚠️ Ese aviso **no** se puede además notificar "a los administradores" como
 * grupo: este sistema no sabe quién tiene rol `global_manager` sin que esa
 * persona se autentique (RN-00.43). Es la cuarta vez que la decisión 3 de la
 * spec 11 §9 aparece, y aquí la salida es que el propio revisor lo vea.
 */
export async function createAbsenceDiscount(
	tx: Database,
	input: { userId: string; date: string; reviewId: string },
	actor: Actor,
): Promise<PayrollAdjustmentEffect> {
	const config = await getConfig();

	const [compensation] = await tx
		.select({
			monthlySalary: employeeCompensation.monthlySalary,
			currency: employeeCompensation.currency,
		})
		.from(employeeCompensation)
		.where(
			and(
				eq(employeeCompensation.profileId, input.userId),
				isNotNull(employeeCompensation.monthlySalary),
			),
		);

	const salary = compensation?.monthlySalary;
	if (!salary || Number.parseFloat(salary) <= 0) {
		return {
			effect: "skipped_no_salary",
			amount: null,
			currency: null,
			effectivePeriod: null,
		};
	}

	const [row] = await tx
		.insert(payrollAdjustments)
		.values({
			userId: input.userId,
			// La división ocurre en Postgres sobre `numeric`; el sueldo entra como
			// parámetro y no como número de JavaScript.
			amount: sql`-round(${salary}::numeric / ${config.payroll_daily_divisor}, 2)`,
			currency: compensation.currency,
			category: "unjustified_absence",
			description: `Ausencia injustificada del ${input.date}`,
			status: "active",
			sourceType: SOURCE_TYPE,
			sourceId: input.reviewId,
			// §7: el periodo es el de la **ausencia**, no el de la revisión.
			effectivePeriod: effectivePeriodOf(input.date),
			createdBy: actor.profileId,
		})
		// Si ya había uno activo para esta revisión, no se duplica (RN-17.5) y el
		// efecto es `unchanged`: es lo que hace idempotente repetir la decisión.
		.onConflictDoNothing()
		.returning();

	if (!row) return unchanged;

	// RN-17.9 — ⚠️ Hueco del legacy (punto 76): allí los ajustes no llegaban a la
	// bitácora, que es justo lo que alguien querría leer al preguntar por un
	// descuento.
	await audit(tx, {
		actorId: actor.profileId,
		action: "payroll_adjustment.created",
		tableName: "payroll_adjustments",
		recordId: row.id,
		newData: {
			amount: row.amount,
			currency: row.currency,
			category: row.category,
			effectivePeriod: row.effectivePeriod,
		},
		metadata: {
			sourceType: SOURCE_TYPE,
			sourceId: input.reviewId,
			divisor: config.payroll_daily_divisor,
		},
		sourceIp: actor.sourceIp,
	});

	return {
		effect: "created",
		amount: row.amount,
		currency: toCurrency(row.currency),
		effectivePeriod: row.effectivePeriod,
	};
}

/**
 * RN-13.4 / RN-17.4 — Revierte el descuento de una revisión. **Nunca borra**: el
 * historial económico es inmutable, así que el ajuste queda con su autor y su
 * fecha de reversión.
 *
 * El estado va en el `WHERE`, no en una comprobación previa: si otro proceso ya
 * lo revirtió, esta llamada devuelve `unchanged` en vez de pisar quién lo hizo.
 */
export async function revertAbsenceDiscount(
	tx: Database,
	input: { reviewId: string },
	actor: Actor,
): Promise<PayrollAdjustmentEffect> {
	const [row] = await tx
		.update(payrollAdjustments)
		.set({
			status: "reverted",
			revertedBy: actor.profileId,
			revertedAt: new Date(),
		})
		.where(
			and(
				eq(payrollAdjustments.sourceType, SOURCE_TYPE),
				eq(payrollAdjustments.sourceId, input.reviewId),
				eq(payrollAdjustments.status, "active"),
			),
		)
		.returning();

	if (!row) return unchanged;

	await audit(tx, {
		actorId: actor.profileId,
		action: "payroll_adjustment.reverted",
		tableName: "payroll_adjustments",
		recordId: row.id,
		oldData: { status: "active" },
		newData: { status: "reverted", amount: row.amount },
		metadata: { sourceType: SOURCE_TYPE, sourceId: input.reviewId },
		sourceIp: actor.sourceIp,
	});

	return {
		effect: "reverted",
		amount: row.amount,
		currency: toCurrency(row.currency),
		effectivePeriod: row.effectivePeriod,
	};
}
