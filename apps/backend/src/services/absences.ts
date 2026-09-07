import {
	type AbsenceReview,
	type AbsenceReviewResult,
	type AppRole,
	type ListAbsenceReviewsQuery,
	type PayrollAdjustmentEffect,
	type PendingAbsence,
	type ReviewAbsenceInput,
	roleAtLeast,
} from "@elineas/validations";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import { attendanceAbsenceReviews, departments, profiles } from "#/db/schema";
import { type Actor, audit, type Database } from "#/services/audit.ts";
import {
	dayKey,
	loadDailyFacts,
	peopleInScope,
	type ScopedProfile,
} from "#/services/daily-facts.ts";
import { notify } from "#/services/notifications.ts";
import {
	createAbsenceDiscount,
	revertAbsenceDiscount,
} from "#/services/payroll.ts";

/**
 * Justificación de ausencias (spec 13). El flujo con más impacto económico del
 * sistema: **un clic aquí mueve dinero**.
 *
 * Tres cosas dan forma a este archivo:
 *
 * 1. **RN-13.5, la barrera de privilegios.** El efecto de nómina se ejecuta
 *    dentro de la misma transacción que la decisión, llamando a
 *    `services/payroll.ts`, que no tiene ninguna ruta que lo exponga. En el
 *    legacy esto era un trigger `SECURITY DEFINER`; aquí es que el jefe llama a
 *    un endpoint de ausencias y el servidor —no él— escribe en nómina.
 * 2. **RN-13.1 se comprueba con la agregación diaria**, no con una lista de
 *    estados repetida aquí: un día es revisable si `computeDailyStatus` le pone
 *    superposición de ausencia, y esa función es la que ya decide qué días la
 *    llevan. Se usa la función **pura** y no `getDaysFor` a propósito: así este
 *    servicio no depende de `attendance.ts`, que sí depende de éste para la
 *    superposición `AJ`/`ANJ` del historial.
 * 3. **La bandeja de la §5 clasifica jornadas por lotes**, con
 *    `services/daily-facts.ts` — el servicio de la §4 de la spec 15, que nació
 *    aquí y se mudó allí cuando le salieron más consumidores. La misma función
 *    sirve para la bandeja y para validar un solo día en RN-13.1.
 *
 * **Aquí no hay nada de `scope=own`.** El empleado no inicia este flujo (spec 12
 * §2): se entera por la notificación de RN-13.7 y por el código `AJ`/`ANJ` de su
 * propio historial, que es donde ya mira.
 */

type ReviewRow = typeof attendanceAbsenceReviews.$inferSelect;

type ReviewerColumns = {
	fullName: string;
	email: string;
	departmentId: string | null;
	departmentName: string | null;
};

function toReview(row: ReviewRow, person: ReviewerColumns): AbsenceReview {
	return {
		id: row.id,
		userId: row.userId,
		userFullName: person.fullName,
		userEmail: person.email,
		departmentId: person.departmentId,
		departmentName: person.departmentName,
		date: row.date,
		isJustified: row.isJustified,
		notes: row.notes,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** Ventana por defecto de la bandeja: lo que un jefe revisa de verdad. */
const DEFAULT_PENDING_DAYS = 30;

function resolveRange(query: { from?: string; to?: string }): {
	from: string;
	to: string;
} {
	const to = query.to ?? new Date().toISOString().slice(0, 10);
	const from =
		query.from ??
		new Date(
			Date.parse(`${to}T00:00:00.000Z`) - DEFAULT_PENDING_DAYS * 86_400_000,
		)
			.toISOString()
			.slice(0, 10);
	return { from, to };
}

/**
 * `GET /absences/pending` (§5): los días ausentes **sin decisión** del ámbito.
 *
 * Es la vista que la spec echa en falta en el legacy —"hoy sólo se ven navegando
 * día por día"—, y la que hace que el badge de RN-05.8 signifique algo: sin
 * ella, una ausencia sin revisar no aparece en ninguna parte hasta que alguien
 * abre el día exacto.
 */
export async function listPendingAbsences(
	scope: { managedDepartmentIds: string[] | "all" },
	query: { from?: string; to?: string; departmentId?: string },
): Promise<PendingAbsence[]> {
	const range = resolveRange(query);
	const people = await peopleInScope(scope, query.departmentId);
	const facts = await loadDailyFacts(people, range);

	const pending: PendingAbsence[] = [];
	for (const person of people) {
		for (const [at, fact] of facts) {
			if (!at.startsWith(`${person.id}|`)) continue;
			// `absence` sólo es no nulo en un día ausente y cerrado (RN-13.1), y
			// `reviewed: false` es exactamente "nadie la ha mirado" (RN-13.10).
			if (!fact.absence || fact.absence.reviewed) continue;
			pending.push({
				userId: person.id,
				userFullName: person.fullName,
				userEmail: person.email,
				departmentId: person.departmentId,
				departmentName: person.departmentName,
				date: fact.date,
			});
		}
	}

	// Las más recientes primero: es el orden en que se revisan, y el mismo
	// criterio que la bandeja de incidencias.
	return pending.sort((a, b) =>
		a.date === b.date
			? a.userFullName.localeCompare(b.userFullName, "es")
			: b.date.localeCompare(a.date),
	);
}

export async function countPendingAbsences(
	scope: { managedDepartmentIds: string[] | "all" },
	query: { from?: string; to?: string; departmentId?: string },
): Promise<number> {
	return (await listPendingAbsences(scope, query)).length;
}

/**
 * `GET /absences` (§6): las decisiones ya tomadas del ámbito.
 *
 * A diferencia de las pendientes, esto **sí** es una consulta directa a una
 * tabla: una decisión existe como fila, así que no hay que clasificar jornadas
 * para encontrarla.
 */
export async function listAbsenceReviews(
	scope: { managedDepartmentIds: string[] | "all" },
	query: ListAbsenceReviewsQuery,
): Promise<AbsenceReview[]> {
	const conditions = [
		gte(attendanceAbsenceReviews.date, query.from),
		lte(attendanceAbsenceReviews.date, query.to),
	];

	if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return [];
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}
	if (query.userId) {
		conditions.push(eq(attendanceAbsenceReviews.userId, query.userId));
	}

	const rows = await db
		.select({
			review: attendanceAbsenceReviews,
			fullName: profiles.fullName,
			email: profiles.email,
			departmentId: profiles.departmentId,
			departmentName: departments.name,
		})
		.from(attendanceAbsenceReviews)
		.innerJoin(profiles, eq(profiles.id, attendanceAbsenceReviews.userId))
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.where(and(...conditions))
		.orderBy(asc(attendanceAbsenceReviews.date));

	return rows.map((row) =>
		toReview(row.review, {
			fullName: row.fullName,
			email: row.email,
			departmentId: row.departmentId,
			departmentName: row.departmentName,
		}),
	);
}

// ── Revisar (§3, la cadena de RN-13.4) ────────────────────────────────────────

/** El perfil de quien va a ser revisado, para que la ruta compruebe el ámbito. */
export async function absenceTargetOf(userId: string): Promise<ScopedProfile> {
	const [person] = await db
		.select({
			id: profiles.id,
			fullName: profiles.fullName,
			email: profiles.email,
			departmentId: profiles.departmentId,
			departmentName: departments.name,
		})
		.from(profiles)
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.where(eq(profiles.id, userId));

	if (!person) {
		throw new HTTPException(404, { message: "Ese perfil no existe." });
	}
	return person;
}

/**
 * `PUT /absences/:userId/:date` — la decisión, y su efecto económico.
 *
 * El orden importa: primero lo que puede rechazar la petición sin escribir nada
 * (RN-13.3 y RN-13.1) y sólo después la transacción, que es la que no debe
 * quedarse abierta esperando por un `400`.
 *
 * **La cadena de RN-13.4 completa, y en una sola transacción:** upsert de la
 * decisión → efecto de nómina → bitácora → notificación. Que sea una sola es lo
 * que hace que no pueda existir un descuento sin su revisión, ni una revisión
 * cuyo descuento se perdió por un fallo a mitad.
 */
export async function reviewAbsence(
	target: ScopedProfile,
	date: string,
	input: ReviewAbsenceInput,
	actor: Actor,
): Promise<AbsenceReviewResult> {
	// RN-13.3 — "Nadie justifica sus propias ausencias". El ámbito lo comprueba la
	// ruta; esto no depende de HTTP y va aquí.
	if (actor.profileId === target.id) {
		throw new HTTPException(403, {
			message: "No puedes clasificar tus propias ausencias.",
		});
	}

	// RN-13.1 — Sólo días efectivamente ausentes, y **validado en servidor** como
	// la regla exige. Se pregunta a la agregación diaria, que es quien sabe qué
	// días llevan superposición de ausencia.
	const facts = await loadDailyFacts([target], { from: date, to: date });
	const fact = facts.get(dayKey(target.id, date));

	if (!fact) {
		throw new HTTPException(500, {
			message: "No se pudo resolver ese día.",
		});
	}
	if (!fact.absence) {
		throw new HTTPException(400, {
			message: fact.pending
				? "Esa jornada todavía puede completarse: no se puede clasificar hoy."
				: `Ese día no es una ausencia: está como ${fact.status}.`,
		});
	}

	return db.transaction(async (tx) => {
		const previous = await currentReview(tx, target.id, date);

		const [row] = await tx
			.insert(attendanceAbsenceReviews)
			.values({
				userId: target.id,
				date,
				isJustified: input.isJustified,
				notes: input.notes ?? null,
				reviewedBy: actor.profileId,
				reviewedAt: new Date(),
			})
			// RN-13.2 — Upsert: una decisión por día, y revisar de nuevo sobrescribe.
			.onConflictDoUpdate({
				target: [
					attendanceAbsenceReviews.userId,
					attendanceAbsenceReviews.date,
				],
				set: {
					isJustified: input.isJustified,
					notes: input.notes ?? null,
					reviewedBy: actor.profileId,
					reviewedAt: new Date(),
					updatedAt: new Date(),
				},
			})
			.returning();

		if (!row) {
			throw new HTTPException(500, {
				message: "No se pudo guardar la clasificación.",
			});
		}

		// RN-13.4 — El efecto de nómina, con privilegio que quien dispara esto no
		// tiene (RN-13.5). Justificar revierte; no justificar crea. Las dos
		// operaciones devuelven `unchanged` si no había nada que cambiar, que es lo
		// que hace idempotente repetir la misma decisión.
		const payrollAdjustment = input.isJustified
			? await revertAbsenceDiscount(tx, { reviewId: row.id }, actor)
			: await createAbsenceDiscount(
					tx,
					{ userId: target.id, date, reviewId: row.id },
					actor,
				);

		// RN-13.8 — Con el valor anterior, que es lo que se querrá leer si alguien
		// pregunta por qué cambió una clasificación.
		await audit(tx, {
			actorId: actor.profileId,
			action: "absence.reviewed",
			tableName: "attendance_absence_reviews",
			recordId: row.id,
			oldData: previous
				? { isJustified: previous.isJustified, notes: previous.notes }
				: null,
			newData: { isJustified: row.isJustified, notes: row.notes },
			metadata: {
				userId: target.id,
				date,
				payrollEffect: payrollAdjustment.effect,
			},
			sourceIp: actor.sourceIp,
		});

		// RN-13.7 y RN-17.10 — ⚠️ Los dos son huecos del legacy (punto 76): allí el
		// empleado se enteraba del descuento en la boleta. El importe **sí** va en
		// el cuerpo: es su propio sueldo, y es el dato que necesita para reclamar.
		await notify(tx, [target.id], {
			type: "absence.reviewed",
			title: input.isJustified
				? "Tu ausencia fue justificada"
				: "Tu ausencia quedó como injustificada",
			body: absenceNotificationBody(date, input, payrollAdjustment),
			actionUrl: "/attendance",
		});

		return {
			review: toReview(row, target),
			payrollAdjustment,
		};
	});
}

async function currentReview(
	tx: Database,
	userId: string,
	date: string,
): Promise<ReviewRow | undefined> {
	const [row] = await tx
		.select()
		.from(attendanceAbsenceReviews)
		.where(
			and(
				eq(attendanceAbsenceReviews.userId, userId),
				eq(attendanceAbsenceReviews.date, date),
			),
		);
	return row;
}

function absenceNotificationBody(
	date: string,
	input: ReviewAbsenceInput,
	effect: PayrollAdjustmentEffect,
): string {
	const money = (() => {
		switch (effect.effect) {
			case "created":
				return ` Se aplicó un descuento de ${effect.amount} ${effect.currency}.`;
			case "reverted":
				return " Se revirtió el descuento que se había aplicado.";
			case "skipped_no_salary":
				return " No se aplicó descuento: no tienes sueldo configurado.";
			default:
				return "";
		}
	})();

	const reason = input.notes ? ` Nota: ${input.notes}` : "";
	return `Día ${date}.${money}${reason}`;
}

/**
 * Lo que la spec 12 dejó esperando: **justificar la ausencia del mismo día al
 * aprobar una incidencia** (decisión 1 de su §9).
 *
 * Se expone como una función y no se mete dentro de `reviewIncident` porque la
 * decisión que se cerró es que **no es automático**: es una acción combinada que
 * alguien elige. Ver la nota de `reviewIncident` para el razonamiento.
 *
 * Devuelve `null` si ese día no es una ausencia clasificable — al aprobar una
 * tardanza no hay nada que justificar—, en vez de fallar: la aprobación de la
 * incidencia es la operación principal y no debe caerse porque el extra no
 * aplique.
 */
export async function justifyAbsenceFromIncident(
	tx: Database,
	target: ScopedProfile,
	date: string,
	notes: string,
	actor: Actor,
): Promise<PayrollAdjustmentEffect | null> {
	const facts = await loadDailyFacts([target], { from: date, to: date });
	const fact = facts.get(dayKey(target.id, date));
	if (!fact?.absence) return null;

	const [row] = await tx
		.insert(attendanceAbsenceReviews)
		.values({
			userId: target.id,
			date,
			isJustified: true,
			notes,
			reviewedBy: actor.profileId,
			reviewedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [attendanceAbsenceReviews.userId, attendanceAbsenceReviews.date],
			set: {
				isJustified: true,
				notes,
				reviewedBy: actor.profileId,
				reviewedAt: new Date(),
				updatedAt: new Date(),
			},
		})
		.returning();

	if (!row) return null;

	const payrollAdjustment = await revertAbsenceDiscount(
		tx,
		{ reviewId: row.id },
		actor,
	);

	await audit(tx, {
		actorId: actor.profileId,
		action: "absence.reviewed",
		tableName: "attendance_absence_reviews",
		recordId: row.id,
		newData: { isJustified: true, notes },
		metadata: {
			userId: target.id,
			date,
			payrollEffect: payrollAdjustment.effect,
			// De dónde vino: es lo que permite responder "¿por qué se justificó
			// este día?" sin cruzar dos bitácoras a mano.
			via: "incident_review",
		},
		sourceIp: actor.sourceIp,
	});

	await notify(tx, [target.id], {
		type: "absence.reviewed",
		title: "Tu ausencia fue justificada",
		body: `Día ${date}. Se justificó al aprobar tu incidencia.${
			payrollAdjustment.effect === "reverted"
				? " Se revirtió el descuento que se había aplicado."
				: ""
		}`,
		actionUrl: "/attendance",
	});

	return payrollAdjustment;
}

/** Para la spec 12: el rol mínimo que puede justificar (RN-13.3). */
export const canReviewAbsences = (role: AppRole): boolean =>
	roleAtLeast(role, "department_head");
