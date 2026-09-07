import {
	type AppRole,
	type CreateVacationRequestInput,
	computeBalance,
	countWorkableDays,
	type ListVacationRequestsQuery,
	type ReviewVacationRequestInput,
	rangesOverlap,
	roleAtLeast,
	roleCanMark,
	type VacationBalance,
	type VacationRequest,
	type VacationStatus,
	vacationStatusSchema,
} from "@elineas/validations";
import { eachDayOfInterval, format, parseISO } from "date-fns";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import { attendanceMarks, profiles, vacationRequests } from "#/db/schema";
import { type Actor, audit, type Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";
import { refreshFactsForUser } from "#/services/daily-facts-store.ts";
import { notify } from "#/services/notifications.ts";
import { additionalHeadsOf } from "#/services/responsibilities.ts";
import { restDayResolverFor } from "#/services/rest-schedules.ts";
import { getCalendar, todayForDepartment } from "#/services/schedules.ts";
import {
	loadApprovedVacationRanges,
	vacationDayPredicate,
} from "#/services/vacation-ranges.ts";

/**
 * Vacaciones (spec 11). Saldo acumulado por días trabajados, solicitud,
 * revisión y las dos costuras que se conectan aquí: `onVacation` para el
 * marcaje (spec 09 RN-09.2) y la superposición `VACACIONES` para la
 * agregación diaria (spec 15 RN-15.1).
 *
 * **RN-11.13 — todas las mutaciones que cambian el saldo pasan por transacción.**
 * Sólo `requestVacation` necesita bloquear: es la única operación que puede
 * dejar el saldo en negativo bajo concurrencia (RN-11.1). Aprobar o rechazar no
 * cambia lo que se resta del saldo —`available = earned − aprobados −
 * pendientes` resta lo mismo antes y después de mover una solicitud de
 * pendiente a aprobada—, y cancelar sólo **libera** saldo, que nunca puede
 * dejarlo negativo. El bloqueo es un `SELECT … FOR UPDATE` sobre la fila de
 * `profiles`, no una transacción serializable: serializa las solicitudes de la
 * misma persona sin arriesgarse a un error de serialización que haya que
 * reintentar.
 *
 * **Decisiones cerradas de la §9** (razonadas en el archivo de validaciones
 * compartido, `@elineas/validations/vacations`): sólo los días laborables del
 * rango consumen saldo (RN-11.5), no se piden medios días (decisión 4) y no hay
 * caducidad (decisión 5).
 *
 * **Sigue abierta la decisión 3 — quién aprueba las vacaciones de un jefe de
 * departamento.** Este sistema no puede saber, mirando sólo su propia base, si
 * un perfil concreto tiene el rol `department_head`: los roles los otorga el
 * Identity Server y sólo se conocen al autenticarse (RN-00.43); lo único que
 * queda localmente es `user_department_responsibilities`, que sólo registra
 * ámbito **adicional**, no el departamento propio de un jefe (spec 03 §3). Por
 * eso `reviewVacationRequest` aplica la única regla que sí es verificable —
 * nadie revisa su propia solicitud— y dejar sin resolver a quién más se le
 * bloquea es honesto en vez de fingir una detección de rol que fallaría
 * silenciosamente en el caso más común.
 */

type VacationRow = typeof vacationRequests.$inferSelect;

const toStatus = (value: string): VacationStatus =>
	vacationStatusSchema.catch("pending").parse(value);

function toVacationRequest(
	row: VacationRow,
	userFullName: string,
): VacationRequest {
	return {
		id: row.id,
		userId: row.userId,
		userFullName,
		startDate: row.startDate,
		endDate: row.endDate,
		requestedDays: row.requestedDays,
		status: toStatus(row.status),
		reviewComment: row.reviewComment,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
		cancelledBy: row.cancelledBy,
		cancelledAt: row.cancelledAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function selectRequests(
	where: ReturnType<typeof and>,
): Promise<VacationRequest[]> {
	const rows = await db
		.select({
			...getTableColumns(vacationRequests),
			fullName: profiles.fullName,
		})
		.from(vacationRequests)
		.innerJoin(profiles, eq(profiles.id, vacationRequests.userId))
		.where(where)
		.orderBy(vacationRequests.createdAt);

	return rows.map((row) => toVacationRequest(row, row.fullName));
}

type RequestWithProfile = {
	request: VacationRow;
	departmentId: string | null;
	fullName: string;
};

async function requireRequest(id: string): Promise<RequestWithProfile> {
	const [row] = await db
		.select({
			request: vacationRequests,
			departmentId: profiles.departmentId,
			fullName: profiles.fullName,
		})
		.from(vacationRequests)
		.innerJoin(profiles, eq(profiles.id, vacationRequests.userId))
		.where(eq(vacationRequests.id, id));

	if (!row) {
		throw new HTTPException(404, { message: "Esa solicitud no existe." });
	}
	return {
		request: row.request,
		departmentId: row.departmentId,
		fullName: row.fullName,
	};
}

/** El departamento de quien pidió, para que la ruta compruebe el ámbito antes de revisar. */
export async function departmentOfVacationRequest(
	id: string,
): Promise<string | null> {
	return (await requireRequest(id)).departmentId;
}

/** Perfil tal como lo necesita este servicio. */
export type VacationProfile = { id: string; departmentId: string | null };

// ── Saldo (§2) ────────────────────────────────────────────────────────────────

/**
 * RN-11.4 — "Día trabajado": uno con marcaje de entrada **aceptado**, contado
 * una vez por `work_date` aunque haya más de una marca ese día. Cuenta desde
 * siempre (no hay caducidad, decisión 5): éste es el numerador de `earned`.
 *
 * Lo que la propia RN-11.4 deja "¿?" —si un día justificado por la spec 13
 * cuenta como trabajado— sigue igual de abierto que allí: hoy no hay ausencias
 * justificadas que contar, y esta función crecerá cuando la 13 exista, no se
 * duplicará en otro sitio.
 */
async function countEarnedDays(
	database: Database,
	userId: string,
): Promise<number> {
	const [row] = await database
		.select({
			count: sql<number>`count(distinct ${attendanceMarks.workDate})::int`,
		})
		.from(attendanceMarks)
		.where(
			and(
				eq(attendanceMarks.userId, userId),
				eq(attendanceMarks.blocked, false),
				eq(attendanceMarks.markType, "IN"),
			),
		);
	return row?.count ?? 0;
}

/** Suma de `requested_days` por estado — lo que resta del saldo (§2). */
async function sumByStatus(
	database: Database,
	userId: string,
): Promise<{ approved: number; pending: number }> {
	const rows = await database
		.select({
			status: vacationRequests.status,
			requestedDays: vacationRequests.requestedDays,
		})
		.from(vacationRequests)
		.where(
			and(
				eq(vacationRequests.userId, userId),
				inArray(vacationRequests.status, ["approved", "pending"]),
			),
		);

	let approved = 0;
	let pending = 0;
	for (const row of rows) {
		if (row.status === "approved") approved += row.requestedDays;
		else pending += row.requestedDays;
	}
	return { approved, pending };
}

async function resolveBalance(
	database: Database,
	userId: string,
): Promise<ReturnType<typeof computeBalance>> {
	const config = await getConfig();
	const earnedDays =
		(await countEarnedDays(database, userId)) *
		config.vacation_days_per_worked_day;
	const { approved, pending } = await sumByStatus(database, userId);
	return computeBalance({
		earnedDays,
		approvedDays: approved,
		pendingDays: pending,
	});
}

/** `GET /me/vacations/balance` y `GET /users/:id/vacations/balance` (spec 11 §6). */
export async function getBalance(
	profile: VacationProfile,
): Promise<VacationBalance> {
	const balance = await resolveBalance(db, profile.id);
	return { userId: profile.id, ...balance };
}

// ── Cuántos días laborables consume un rango (RN-11.5) ────────────────────────

/**
 * Los días del rango que **sí** consumen saldo: laborables y no de descanso.
 * Es la misma pregunta que resuelve `computeDailyStatus` mirando hacia atrás,
 * pero aquí hacia adelante — un rango que todavía no ha pasado.
 */
async function countWorkableDaysInRange(
	profile: VacationProfile,
	startDate: string,
	endDate: string,
): Promise<number> {
	const dates = eachDayOfInterval({
		start: parseISO(startDate),
		end: parseISO(endDate),
	}).map((date) => format(date, "yyyy-MM-dd"));

	// Sin departamento no hay concepto de "laborable" (RN-02.3): cada día del
	// rango cuenta tal cual. En la práctica no importa mucho — sin departamento
	// tampoco se puede marcar, así que `earned` siempre es 0 y la solicitud
	// fallará por saldo antes de que este número decida nada.
	let isWorkday = (_date: string) => true;
	if (profile.departmentId) {
		const entries = await getCalendar(profile.departmentId, {
			from: startDate,
			to: endDate,
		});
		const byDate = new Map(entries.map((entry) => [entry.date, entry]));
		isWorkday = (date: string) => byDate.get(date)?.isWorkday ?? true;
	}

	const isRestDay = await restDayResolverFor(profile);

	return countWorkableDays(dates, isWorkday, isRestDay);
}

/**
 * El predicado `onVacation(date)` para un rango: la costura de RN-09.2 y
 * RN-15.1. Sólo las solicitudes **aprobadas** cubren fechas; una pendiente no
 * bloquea el marcaje todavía, ni una rechazada o cancelada.
 */
export async function vacationDayResolverFor(
	profile: VacationProfile,
): Promise<(date: string) => boolean> {
	const ranges = await loadApprovedVacationRanges([profile.id]);
	return vacationDayPredicate(ranges.get(profile.id) ?? []);
}

/**
 * `onVacation` para "hoy" (RN-09.2), sin cargar todo el predicado: es lo único
 * que necesita el marcaje en vivo, que comprueba la vacación **antes** de
 * resolver a qué día laboral pertenece la marca (spec 09 §3, RN-09.2 se evalúa
 * en segundo lugar, antes que el horario y el calendario).
 */
export async function isOnVacationToday(
	userId: string,
	today: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: vacationRequests.id })
		.from(vacationRequests)
		.where(
			and(
				eq(vacationRequests.userId, userId),
				eq(vacationRequests.status, "approved"),
				sql`${vacationRequests.startDate} <= ${today}`,
				sql`${vacationRequests.endDate} >= ${today}`,
			),
		)
		.limit(1);
	return !!row;
}

// ── Solicitar (§5.1) ────────────────────────────────────────────────────────────

/**
 * `POST /vacations/requests`.
 *
 * El orden importa: primero lo que no necesita bloquear nada (rol, fecha,
 * cuántos días consume el rango), y sólo entonces la transacción que sí lo
 * necesita — bloquear antes de saber si hay algo que rechazar sería tener la
 * fila de `profiles` esperando por un `400` que no iba a escribir nada.
 */
export async function requestVacation(
	profile: VacationProfile,
	role: AppRole,
	input: CreateVacationRequestInput,
	actor: Actor,
): Promise<VacationRequest> {
	// §4: quien no marca no acumula ni solicita (RN-03.4), igual que con los
	// descansos.
	if (!roleCanMark(role)) {
		throw new HTTPException(403, {
			message: "Tu rol no registra asistencia, así que no acumula vacaciones.",
		});
	}

	const today = await todayForDepartment(profile.departmentId);

	// RN-11.7 — Sólo a futuro, sin excepción de rol: una regularización hacia
	// atrás es una incidencia (spec 12), no unas vacaciones con la fecha movida.
	if (input.startDate < today) {
		throw new HTTPException(400, {
			message: `Las vacaciones sólo se piden a futuro: la fecha de inicio tiene que ser ${today} o posterior.`,
		});
	}

	const requestedDays = await countWorkableDaysInRange(
		profile,
		input.startDate,
		input.endDate,
	);

	if (requestedDays <= 0) {
		throw new HTTPException(400, {
			message:
				"Ese rango no incluye ningún día laborable tuyo: no consumiría saldo de vacaciones.",
		});
	}

	return db
		.transaction(async (tx) => {
			// RN-11.1 bajo concurrencia: el bloqueo serializa las solicitudes de esta
			// misma persona. Dos peticiones simultáneas que juntas exceden el saldo —
			// la segunda espera aquí a que la primera confirme, relee el saldo ya
			// actualizado y lo rechaza con datos frescos, no con los que tenía al
			// empezar.
			await tx
				.select({ id: profiles.id })
				.from(profiles)
				.where(eq(profiles.id, profile.id))
				.for("update");

			// RN-11.6 — Solapamiento contra lo pendiente o aprobado, leído ya dentro
			// del bloqueo.
			const existing = await tx
				.select({
					startDate: vacationRequests.startDate,
					endDate: vacationRequests.endDate,
				})
				.from(vacationRequests)
				.where(
					and(
						eq(vacationRequests.userId, profile.id),
						inArray(vacationRequests.status, ["approved", "pending"]),
					),
				);

			if (existing.some((row) => rangesOverlap(input, row))) {
				throw new HTTPException(409, {
					message:
						"Ya tienes una solicitud pendiente o aprobada que se solapa con esas fechas.",
				});
			}

			const balance = await resolveBalance(tx, profile.id);
			if (requestedDays > balance.available) {
				throw new HTTPException(409, {
					message: `No te alcanza el saldo: tienes ${balance.available} ${balance.available === 1 ? "día disponible" : "días disponibles"} y estás pidiendo ${requestedDays}.`,
				});
			}

			const [row] = await tx
				.insert(vacationRequests)
				.values({
					userId: profile.id,
					startDate: input.startDate,
					endDate: input.endDate,
					requestedDays,
					status: "pending",
				})
				.returning();

			if (!row) {
				throw new HTTPException(500, {
					message: "No se pudo crear la solicitud de vacaciones.",
				});
			}

			await audit(tx, {
				actorId: actor.profileId,
				action: "vacation.requested",
				tableName: "vacation_requests",
				recordId: row.id,
				newData: {
					startDate: input.startDate,
					endDate: input.endDate,
					requestedDays,
				},
				sourceIp: actor.sourceIp,
			});

			// §5.1 paso 4. Ver la nota de cabecera y la de `additionalHeadsOf`:
			// sólo llega a los responsables adicionales conocidos; el jefe "propio"
			// se entera por su bandeja.
			if (profile.departmentId) {
				await notify(tx, await additionalHeadsOf(profile.departmentId), {
					type: "vacation.requested",
					title: "Nueva solicitud de vacaciones",
					body: `Del ${input.startDate} al ${input.endDate} (${requestedDays} ${requestedDays === 1 ? "día" : "días"}).`,
					actionUrl: "/team",
				});
			}

			return row;
		})
		.then(async (row) => {
			// El nombre se resuelve fuera de la transacción, con un `join`: no cambia
			// el resultado, sólo cómo se presenta, y no vale la pena tenerlo abierto
			// mientras la fila sigue bloqueada.
			const [created] = await selectRequests(eq(vacationRequests.id, row.id));
			if (!created) {
				throw new HTTPException(500, {
					message: "La solicitud se creó pero no se pudo volver a leer.",
				});
			}
			return created;
		});
}

// ── Cancelar (§5.3, RN-11.10) ───────────────────────────────────────────────────

export async function cancelVacationRequest(
	id: string,
	actor: Actor & { role: AppRole },
): Promise<VacationRequest> {
	const { request, departmentId, fullName } = await requireRequest(id);

	if (request.status === "rejected" || request.status === "cancelled") {
		throw new HTTPException(409, {
			message: "Esa solicitud ya no está activa.",
		});
	}

	const isOwner = actor.profileId === request.userId;
	const isAdmin = roleAtLeast(actor.role, "global_manager");

	if (!isOwner && !isAdmin) {
		throw new HTTPException(403, {
			message: "No puedes cancelar una solicitud de otra persona.",
		});
	}

	if (request.status === "approved") {
		const today = await todayForDepartment(departmentId);
		// RN-11.10: en curso o pasada, sólo rol administrativo. Sólo a futuro
		// puede cancelarla quien la pidió.
		if (request.startDate <= today && !isAdmin) {
			throw new HTTPException(403, {
				message:
					"Esas vacaciones ya empezaron o ya pasaron: sólo un rol administrativo puede cancelarlas.",
			});
		}
	}

	return db.transaction(async (tx) => {
		const [row] = await tx
			.update(vacationRequests)
			.set({
				status: "cancelled",
				cancelledBy: actor.profileId,
				cancelledAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(vacationRequests.id, id))
			.returning();

		if (!row) {
			throw new HTTPException(404, { message: "Esa solicitud no existe." });
		}

		await audit(tx, {
			actorId: actor.profileId,
			action: "vacation.cancelled",
			tableName: "vacation_requests",
			recordId: id,
			oldData: { status: request.status },
			metadata: { onBehalfOf: isOwner ? null : request.userId },
			sourceIp: actor.sourceIp,
		});

		// Cancelar lo ya aprobado es un hecho que a la persona le interesa saber
		// si no fue ella quien lo hizo — un administrativo cancelando en su
		// nombre le cambia un periodo con el que ya contaba.
		if (!isOwner) {
			await notify(tx, [request.userId], {
				type: "vacation.cancelled",
				title: "Tus vacaciones fueron canceladas",
				body: `Del ${request.startDate} al ${request.endDate}.`,
				actionUrl: "/profile",
			});
		}

		return toVacationRequest(row, fullName);
	});
}

// ── Revisar (§5.2, RN-11.8) ──────────────────────────────────────────────────────

/**
 * `POST /vacations/requests/:id/review`. El ámbito (RN-11.8, "aprueba el jefe
 * del ámbito o un gestor global") lo comprueba la ruta con `canManage` **antes**
 * de llamar aquí, porque necesita el departamento de la solicitud para
 * resolverlo (`departmentOfVacationRequest`). Lo único que queda por comprobar
 * en el servicio es lo que no depende de HTTP: que nadie revise su propia
 * solicitud.
 */
export async function reviewVacationRequest(
	id: string,
	input: ReviewVacationRequestInput,
	actor: Actor,
): Promise<VacationRequest> {
	const { request, departmentId, fullName } = await requireRequest(id);

	if (request.status !== "pending") {
		throw new HTTPException(409, {
			message: "Esa solicitud ya fue revisada o cancelada.",
		});
	}

	// RN-11.8 — "Nadie aprueba su propia solicitud (ni un jefe la suya)". Es la
	// única mitad de la regla que este sistema puede verificar por sí mismo; ver
	// la nota de cabecera para la otra mitad, que sigue abierta.
	if (actor.profileId === request.userId) {
		throw new HTTPException(403, {
			message: "No puedes revisar tu propia solicitud de vacaciones.",
		});
	}

	return db
		.transaction(async (tx) => {
			const [row] = await tx
				.update(vacationRequests)
				.set({
					status: input.approved ? "approved" : "rejected",
					reviewComment: input.comment ?? null,
					reviewedBy: actor.profileId,
					reviewedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(vacationRequests.id, id))
				.returning();

			if (!row) {
				throw new HTTPException(404, { message: "Esa solicitud no existe." });
			}

			await audit(tx, {
				actorId: actor.profileId,
				action: "vacation.reviewed",
				tableName: "vacation_requests",
				recordId: id,
				oldData: { status: request.status },
				newData: { status: row.status, comment: row.reviewComment },
				sourceIp: actor.sourceIp,
			});

			await notify(tx, [request.userId], {
				type: "vacation.reviewed",
				title: input.approved
					? "Tus vacaciones fueron aprobadas"
					: "Tus vacaciones fueron rechazadas",
				body: input.approved
					? `Del ${request.startDate} al ${request.endDate} (${request.requestedDays} ${request.requestedDays === 1 ? "día" : "días"}). Ese periodo no se podrá marcar.`
					: `Del ${request.startDate} al ${request.endDate}.${input.comment ? ` Motivo: ${input.comment}` : ""}`,
				actionUrl: "/profile",
			});

			return toVacationRequest(row, fullName);
		})
		.then(async (reviewed) => {
			// RN-16.11 (spec 16) — Aprobar o rechazar cambia cómo se clasifica cada día
			// del rango: los hechos diarios de ese periodo quedan obsoletos. Se refresca
			// tras confirmar, por lo mismo que en la revisión de ausencias.
			await refreshFactsForUser(
				{ id: request.userId, departmentId },
				{ from: request.startDate, to: request.endDate },
			);
			return reviewed;
		});
}

// ── Listar (§6) ──────────────────────────────────────────────────────────────────

export async function listOwnVacationRequests(
	userId: string,
	status?: VacationStatus,
): Promise<VacationRequest[]> {
	return selectRequests(
		status
			? and(
					eq(vacationRequests.userId, userId),
					eq(vacationRequests.status, status),
				)
			: eq(vacationRequests.userId, userId),
	);
}

/**
 * Cuántas solicitudes esperan por una decisión del ámbito — la alerta de la spec
 * 15 §5.1. Es un `count(*)` y no `listX().length` por lo mismo que en
 * incidencias: el dashboard lo pide en cada carga y traer las filas para
 * contarlas sería el trabajo de la bandeja hecho para descartarlo.
 */
export async function countPendingVacationRequests(scope: {
	managedDepartmentIds: string[] | "all";
}): Promise<number> {
	const conditions = [eq(vacationRequests.status, "pending")];

	if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return 0;
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}

	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(vacationRequests)
		.innerJoin(profiles, eq(profiles.id, vacationRequests.userId))
		.where(and(...conditions));

	return row?.count ?? 0;
}

/**
 * La bandeja de un `department_head` o `global_manager` sobre su ámbito
 * (RN-03.2), igual que `listUsers`: `managedDepartmentIds: "all"` para un
 * gestor global, o la lista concreta para un jefe.
 */
export async function listManagedVacationRequests(
	scope: { managedDepartmentIds: string[] | "all" },
	filters: ListVacationRequestsQuery,
): Promise<VacationRequest[]> {
	const conditions = [];

	if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return [];
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}
	if (filters.departmentId) {
		conditions.push(eq(profiles.departmentId, filters.departmentId));
	}
	if (filters.status) {
		conditions.push(eq(vacationRequests.status, filters.status));
	}

	const rows = await db
		.select({
			...getTableColumns(vacationRequests),
			fullName: profiles.fullName,
		})
		.from(vacationRequests)
		.innerJoin(profiles, eq(profiles.id, vacationRequests.userId))
		.where(and(...conditions))
		.orderBy(vacationRequests.createdAt);

	return rows.map((row) => toVacationRequest(row, row.fullName));
}
