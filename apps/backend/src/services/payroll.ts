import {
	type CreatePayrollAdjustmentInput,
	type Currency,
	currencySchema,
	DEFAULT_CURRENCY,
	effectivePeriodOf,
	type ListPayrollAdjustmentsQuery,
	type ListPayrollSalariesQuery,
	type PayrollAdjustment,
	type PayrollAdjustmentEffect,
	type PayrollSalary,
	type PayrollSummary,
	type PayrollSummaryQuery,
	payrollAdjustmentCategorySchema,
	payrollAdjustmentStatusSchema,
	type RevertPayrollAdjustmentInput,
} from "@elineas/validations";
import { and, asc, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import {
	departments,
	employeeCompensation,
	payrollAdjustments,
	profiles,
} from "#/db/schema";
import { type Actor, audit, type Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";
import { notify } from "#/services/notifications.ts";
import { todayIn } from "#/services/schedule-rules.ts";

/**
 * Nómina (spec 17): el descuento que dispara la spec 13 y la superficie de
 * administración de la §5.
 *
 * **La barrera de privilegios de RN-13.5 sigue siendo la forma de este
 * archivo**, aunque `/payroll/*` ya exista. En el legacy era un trigger
 * `SECURITY DEFINER` sobre `attendance_absence_reviews`, porque quien justifica
 * —el `department_head`— no tiene ni debe tener acceso a la tabla de nómina
 * (RN-17.1, hallazgo H-3). Aquí es más simple y más legible: las dos funciones
 * del descuento automático —`createAbsenceDiscount` y `revertAbsenceDiscount`—
 * **no las expone ninguna ruta**. Se llaman desde `services/absences.ts`,
 * dentro de la transacción de la revisión, y reciben la transacción como primer
 * argumento por lo mismo que `audit` y `notify`: si la revisión se revierte, el
 * ajuste también.
 *
 * Lo que sí exponen las rutas es lo de más abajo —listar, ajustar a mano,
 * revertir, totales, sueldos—, y todo detrás de `requireRole("global_manager")`.
 * De ahí que la comprobación de la barrera cambiara de forma: un jefe recibía
 * **404** porque no había nada montado en `/api/payroll`, y ahora recibe
 * **403**, que es lo que la spec pedía desde el principio.
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

// ── §5 y §6 · La administración de nómina ─────────────────────────────────────

/**
 * Todo lo que sigue **sí** lo exponen las rutas de `/api/payroll`, y todo detrás
 * de `requireRole("global_manager")` (RN-17.1). El ámbito departamental no
 * aparece por ningún lado a propósito: aquí no hay ámbito que acotar, porque el
 * único rol que entra ya alcanza a la empresa entera. Un `department_head` no
 * ve una versión reducida de esta pantalla; no ve ninguna.
 */

const creator = alias(profiles, "payroll_creator");
const reverter = alias(profiles, "payroll_reverter");

/** El mes en curso **en la zona del sistema** (RN-06.6), no en la del servidor. */
async function currentPeriod(): Promise<string> {
	const config = await getConfig();
	return todayIn(config.global_timezone).slice(0, 7);
}

type AdjustmentJoin = {
	row: typeof payrollAdjustments.$inferSelect;
	userFullName: string;
	userEmail: string;
	departmentId: string | null;
	departmentName: string | null;
	createdByName: string | null;
	revertedByName: string | null;
};

/**
 * La proyección del ajuste, con las tres personas que puede llevar dentro:
 * a quién afecta, quién lo registró y quién lo revirtió.
 *
 * Son tres `join` y no tres consultas porque un listado de un mes son decenas de
 * filas y el patrón "trae los ids y luego resuelve los nombres" es el que en el
 * legacy convertía una pantalla en una cascada de peticiones.
 */
const adjustmentQuery = () =>
	db
		.select({
			row: payrollAdjustments,
			userFullName: profiles.fullName,
			userEmail: profiles.email,
			departmentId: profiles.departmentId,
			departmentName: departments.name,
			createdByName: creator.fullName,
			revertedByName: reverter.fullName,
		})
		.from(payrollAdjustments)
		.innerJoin(profiles, eq(profiles.id, payrollAdjustments.userId))
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.leftJoin(creator, eq(creator.id, payrollAdjustments.createdBy))
		.leftJoin(reverter, eq(reverter.id, payrollAdjustments.revertedBy));

function toAdjustment(joined: AdjustmentJoin): PayrollAdjustment {
	const { row } = joined;
	return {
		id: row.id,
		userId: row.userId,
		userFullName: joined.userFullName,
		userEmail: joined.userEmail,
		departmentId: joined.departmentId,
		departmentName: joined.departmentName,
		amount: row.amount,
		currency: toCurrency(row.currency),
		// Categoría y estado son `text` en la base y enums en el contrato: se
		// toleran al leer, igual que las notificaciones con un tipo desconocido.
		// Una fila escrita por una versión anterior no debe tumbar el listado.
		category: payrollAdjustmentCategorySchema
			.catch("other")
			.parse(row.category),
		description: row.description,
		status: payrollAdjustmentStatusSchema.catch("active").parse(row.status),
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		effectivePeriod: row.effectivePeriod,
		createdBy: row.createdBy,
		createdByName: joined.createdByName,
		revertedBy: row.revertedBy,
		revertedByName: joined.revertedByName,
		revertedAt: row.revertedAt?.toISOString() ?? null,
		revertReason: row.revertReason,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * `GET /payroll/adjustments` (§6) — el historial del periodo.
 *
 * **Sin periodo se devuelve el mes en curso**, no la historia entera: un listado
 * sin acotar de una tabla que sólo crece es la consulta que un día tumba la
 * pantalla, y el filtro por mes es además la unidad en la que se trabaja
 * (§7). Los revertidos vienen incluidos salvo que se pidan sólo los activos:
 * RN-17.4 los conserva justamente para que se puedan ver.
 */
export async function listAdjustments(
	query: ListPayrollAdjustmentsQuery,
): Promise<PayrollAdjustment[]> {
	const period = query.period ?? (await currentPeriod());
	const conditions = [eq(payrollAdjustments.effectivePeriod, `${period}-01`)];

	if (query.departmentId) {
		conditions.push(eq(profiles.departmentId, query.departmentId));
	}
	if (query.userId)
		conditions.push(eq(payrollAdjustments.userId, query.userId));
	if (query.status)
		conditions.push(eq(payrollAdjustments.status, query.status));
	if (query.category) {
		conditions.push(eq(payrollAdjustments.category, query.category));
	}

	const rows = await adjustmentQuery()
		.where(and(...conditions))
		.orderBy(desc(payrollAdjustments.createdAt), asc(profiles.fullName));

	return rows.map(toAdjustment);
}

async function requireAdjustment(id: string): Promise<PayrollAdjustment> {
	const [row] = await adjustmentQuery().where(eq(payrollAdjustments.id, id));
	if (!row) {
		throw new HTTPException(404, { message: "Ese ajuste no existe." });
	}
	return toAdjustment(row);
}

/**
 * RN-17.8 — Un ajuste manual, de cualquier signo.
 *
 * Tres cosas lo separan del automático, y las tres importan:
 *
 * - **No tiene origen.** `source_type` y `source_id` quedan nulos, que es lo que
 *   permite distinguirlo de un descuento por ausencia sin mirar su categoría, y
 *   lo que hace que el índice único parcial de RN-17.5 no le aplique: dos
 *   ajustes manuales del mismo mes para la misma persona son legítimos.
 * - **Lleva motivo obligatorio**, porque es una decisión discrecional (§4.2).
 * - **Avisa con su propio tipo de notificación**, no con el de la clasificación
 *   de una ausencia: aquí no se clasificó nada.
 */
export async function createManualAdjustment(
	input: CreatePayrollAdjustmentInput,
	actor: Actor,
): Promise<PayrollAdjustment> {
	const [person] = await db
		.select({ id: profiles.id, currency: employeeCompensation.currency })
		.from(profiles)
		.leftJoin(
			employeeCompensation,
			eq(employeeCompensation.profileId, profiles.id),
		)
		.where(eq(profiles.id, input.userId));

	if (!person) {
		throw new HTTPException(404, { message: "Ese perfil no existe." });
	}

	// La moneda se hereda del sueldo, como en el automático: lo normal es
	// ajustar en aquella en la que se cobra. Indicarla es para la excepción.
	const currency =
		input.currency ??
		currencySchema.catch(DEFAULT_CURRENCY).parse(person.currency);
	const period = input.period ?? (await currentPeriod());

	const created = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(payrollAdjustments)
			.values({
				userId: input.userId,
				amount: input.amount,
				currency,
				category: input.category,
				description: input.description,
				status: "active",
				effectivePeriod: `${period}-01`,
				createdBy: actor.profileId,
			})
			.returning();

		if (!row) {
			throw new HTTPException(500, {
				message: "No se pudo registrar el ajuste.",
			});
		}

		// RN-17.9 — Toda creación llega a la bitácora, no sólo la automática.
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
			metadata: { manual: true, description: row.description },
			sourceIp: actor.sourceIp,
		});

		// RN-17.10 — ⚠️ Hueco del legacy (punto 76): allí el empleado se enteraba
		// en la boleta. El importe **sí** va en el cuerpo: es su propio dinero.
		await notify(tx, [row.userId], {
			type: "payroll_adjustment.applied",
			title: isDiscount(row.amount)
				? "Se aplicó un descuento a tu nómina"
				: "Se registró un ajuste a tu favor",
			body: `${row.amount} ${row.currency}, en el periodo ${period}. Motivo: ${row.description}`,
		});

		return row;
	});

	return requireAdjustment(created.id);
}

const isDiscount = (amount: string) => amount.trimStart().startsWith("-");

/**
 * RN-17.4 — Reversión manual. **Nunca borra**: el historial económico es
 * inmutable, así que la fila queda con su autor, su fecha y su motivo.
 *
 * Se puede revertir también un descuento automático, y la §5 lo da por hecho al
 * pedir que se vea de dónde vino el ajuste que se está revirtiendo. Lo que pasa
 * después es coherente por el índice parcial de RN-17.5: si más tarde alguien
 * vuelve a clasificar esa ausencia como injustificada, se crea un ajuste
 * **nuevo** (RN-13.4), no resucita éste.
 *
 * El estado va en el `WHERE` y no en una comprobación previa por lo mismo que en
 * `revertAbsenceDiscount`: dos reversiones simultáneas no pueden pisarse el
 * autor. La comprobación de antes existe sólo para poder responder 404 y 409 con
 * un mensaje que se entienda.
 */
export async function revertAdjustment(
	id: string,
	input: RevertPayrollAdjustmentInput,
	actor: Actor,
): Promise<PayrollAdjustment> {
	const current = await requireAdjustment(id);
	if (current.status !== "active") {
		throw new HTTPException(409, { message: "Ese ajuste ya está revertido." });
	}

	await db.transaction(async (tx) => {
		const [row] = await tx
			.update(payrollAdjustments)
			.set({
				status: "reverted",
				revertedBy: actor.profileId,
				revertedAt: new Date(),
				revertReason: input.reason,
			})
			.where(
				and(
					eq(payrollAdjustments.id, id),
					eq(payrollAdjustments.status, "active"),
				),
			)
			.returning();

		if (!row) {
			throw new HTTPException(409, {
				message: "Ese ajuste ya está revertido.",
			});
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "payroll_adjustment.reverted",
			tableName: "payroll_adjustments",
			recordId: row.id,
			oldData: { status: "active" },
			newData: { status: "reverted", amount: row.amount },
			metadata: {
				manual: true,
				reason: input.reason,
				sourceType: row.sourceType,
				sourceId: row.sourceId,
			},
			sourceIp: actor.sourceIp,
		});

		await notify(tx, [row.userId], {
			type: "payroll_adjustment.reverted",
			title: "Se revirtió un ajuste de tu nómina",
			body: `${row.amount} ${row.currency}, del periodo ${row.effectivePeriod.slice(0, 7)}. Motivo: ${input.reason}`,
		});
	});

	return requireAdjustment(id);
}

/**
 * `GET /payroll/summary` (§6) — los totales del periodo.
 *
 * **Sólo los ajustes activos**: uno revertido no se cobra, y sumarlo dejaría el
 * total sin cuadrar con lo que se paga, que es justo el criterio de aceptación
 * de la §8.
 *
 * **Y siempre agrupados por moneda.** No hay un número por departamento y no
 * puede haberlo: en la misma plantilla se cobra en monedas distintas (spec 02
 * §6a) y sumar CUP con USD produce una cifra que no significa nada. Las tres
 * agregaciones son tres consultas y no una repartida en JavaScript porque la
 * suma de dinero se hace en PostgreSQL sobre `numeric` (RN-17.12).
 */
export async function getPayrollSummary(
	query: PayrollSummaryQuery,
): Promise<PayrollSummary> {
	const period = query.period ?? (await currentPeriod());

	const conditions = [
		eq(payrollAdjustments.effectivePeriod, `${period}-01`),
		eq(payrollAdjustments.status, "active"),
	];
	if (query.departmentId) {
		conditions.push(eq(profiles.departmentId, query.departmentId));
	}
	const where = and(...conditions);

	const total = sql<string>`sum(${payrollAdjustments.amount})::text`;
	const count = sql<number>`count(*)::int`;

	const totals = await db
		.select({ currency: payrollAdjustments.currency, total, count })
		.from(payrollAdjustments)
		.innerJoin(profiles, eq(profiles.id, payrollAdjustments.userId))
		.where(where)
		.groupBy(payrollAdjustments.currency);

	const byDepartment = await db
		.select({
			departmentId: profiles.departmentId,
			departmentName: departments.name,
			currency: payrollAdjustments.currency,
			total,
			count,
		})
		.from(payrollAdjustments)
		.innerJoin(profiles, eq(profiles.id, payrollAdjustments.userId))
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.where(where)
		.groupBy(
			profiles.departmentId,
			departments.name,
			payrollAdjustments.currency,
		)
		.orderBy(asc(departments.name));

	const byEmployee = await db
		.select({
			userId: payrollAdjustments.userId,
			userFullName: profiles.fullName,
			departmentId: profiles.departmentId,
			departmentName: departments.name,
			currency: payrollAdjustments.currency,
			total,
			count,
		})
		.from(payrollAdjustments)
		.innerJoin(profiles, eq(profiles.id, payrollAdjustments.userId))
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.where(where)
		.groupBy(
			payrollAdjustments.userId,
			profiles.fullName,
			profiles.departmentId,
			departments.name,
			payrollAdjustments.currency,
		)
		.orderBy(asc(profiles.fullName));

	return {
		period,
		totals: totals.map((row) => ({
			currency: toCurrency(row.currency),
			total: row.total,
			count: row.count,
		})),
		byDepartment: byDepartment.map((row) => ({
			departmentId: row.departmentId,
			departmentName: row.departmentName,
			currency: toCurrency(row.currency),
			total: row.total,
			count: row.count,
		})),
		byEmployee: byEmployee.map((row) => ({
			userId: row.userId,
			userFullName: row.userFullName,
			departmentId: row.departmentId,
			departmentName: row.departmentName,
			currency: toCurrency(row.currency),
			total: row.total,
			count: row.count,
		})),
	};
}

/**
 * `GET /payroll/salaries` (§5) — los sueldos, todos a la vez.
 *
 * **Esto es lo único de los sueldos que faltaba.** Editarlos ya existe desde la
 * spec 02 (`PUT /users/:id/compensation`), con el mismo rol mínimo y la misma
 * entrada de bitácora, así que no se duplica aquí: lo que un diálogo por persona
 * no da es la vista de conjunto con su filtro por departamento, que es lo que
 * pide la §5 y lo que hace visible el caso de RN-17.7 —quien no tiene sueldo
 * configurado y por eso no genera descuento—.
 *
 * Un perfil sin fila de compensación aparece igual, con importe nulo: "no tiene
 * sueldo registrado" es la respuesta que se está buscando, no una ausencia de
 * respuesta.
 */
export async function listSalaries(
	query: ListPayrollSalariesQuery,
): Promise<PayrollSalary[]> {
	const conditions = [];
	if (query.departmentId) {
		conditions.push(eq(profiles.departmentId, query.departmentId));
	}
	if (!query.includeInactive) conditions.push(eq(profiles.isActive, true));
	if (query.search) {
		const pattern = `%${query.search}%`;
		conditions.push(
			or(
				sql`${profiles.fullName} ilike ${pattern}`,
				sql`${profiles.email} ilike ${pattern}`,
			),
		);
	}

	const rows = await db
		.select({
			profileId: profiles.id,
			fullName: profiles.fullName,
			email: profiles.email,
			departmentId: profiles.departmentId,
			departmentName: departments.name,
			monthlySalary: employeeCompensation.monthlySalary,
			currency: employeeCompensation.currency,
			updatedAt: employeeCompensation.updatedAt,
		})
		.from(profiles)
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.leftJoin(
			employeeCompensation,
			eq(employeeCompensation.profileId, profiles.id),
		)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(profiles.fullName));

	return rows.map((row) => ({
		profileId: row.profileId,
		fullName: row.fullName,
		email: row.email,
		departmentId: row.departmentId,
		departmentName: row.departmentName,
		monthlySalary: row.monthlySalary,
		// Sin fila de compensación no hay moneda, y no tenerla registrada no es lo
		// mismo que no saber en cuál se pagaría: hereda la de por defecto.
		currency: currencySchema.catch(DEFAULT_CURRENCY).parse(row.currency),
		updatedAt: row.updatedAt?.toISOString() ?? null,
	}));
}
