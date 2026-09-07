import {
	type AttendanceIncident,
	type CreateIncidentInput,
	INCIDENT_TYPE_LABELS,
	type IncidentContext,
	type IncidentStatus,
	type IncidentType,
	incidentDateIssue,
	incidentStatusSchema,
	incidentTypeSchema,
	type ListIncidentsQuery,
	type ReviewIncidentInput,
	type ReviewIncidentResult,
} from "@elineas/validations";
import { and, desc, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import {
	attendanceIncidents,
	attendanceMarks,
	departments,
	profiles,
} from "#/db/schema";
import {
	absenceTargetOf,
	justifyAbsenceFromIncident,
} from "#/services/absences.ts";
import {
	getDaysFor,
	listBlockedMarksOfWorkDate,
} from "#/services/attendance.ts";
import type { Actor } from "#/services/audit.ts";
import { audit } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";
import { refreshFactsForUser } from "#/services/daily-facts-store.ts";
import { notify } from "#/services/notifications.ts";
import { additionalHeadsOf } from "#/services/responsibilities.ts";
import { todayForDepartment } from "#/services/schedules.ts";

/**
 * Incidencias de asistencia (spec 12). El empleado reporta un problema con su
 * marcaje; el jefe lo revisa y queda constancia.
 *
 * **RN-12.9 — aprobar no corrige nada.** En este archivo no hay un solo
 * `insert` ni `update` sobre `attendance_marks`, y no es un olvido: el marcaje
 * es inmutable desde la aplicación (spec 09 RN-09.12) y la aprobación de una
 * incidencia es un acto documental.
 *
 * **La [decisión 1 de la §9](../../../../packages/specs/12-incidencias.md) quedó
 * cerrada con la spec 13**, que es la que faltaba: aprobar **no** justifica la
 * ausencia por sí solo, pero `justifyAbsence` permite hacer las dos cosas en un
 * mismo acto y en una sola transacción. El razonamiento está en
 * `reviewIncidentInputSchema`; lo que aquí importa es que el efecto de nómina
 * sigue viviendo en `services/payroll.ts` y entra por
 * `justifyAbsenceFromIncident`, así que la barrera de RN-13.5 vale igual por
 * esta puerta que por la de `/absences`.
 *
 * Las reglas que se pueden escribir sin base de datos —qué tipos exigen motivo
 * (RN-12.1), qué fechas se admiten (RN-12.3, RN-12.4) y la asimetría del
 * rechazo (RN-12.7)— viven en `@elineas/validations/incidents`, porque las
 * comparte el formulario. Aquí sólo se lee, se escribe y se avisa.
 *
 * **RN-12.10, con la misma limitación que las vacaciones:** el aviso al jefe
 * sólo alcanza a quien gestiona el departamento como responsabilidad
 * *adicional* (`additionalHeadsOf`), porque este sistema no sabe quién es el
 * jefe "propio" de un departamento sin que esa persona se autentique
 * (RN-00.43). Es la tercera spec que se topa con la decisión 3 de la
 * [spec 11 §9](../../../../packages/specs/11-vacaciones.md); el jefe propio se
 * entera al abrir su bandeja.
 */

type IncidentRow = typeof attendanceIncidents.$inferSelect;

/** Perfil tal como lo necesita este servicio. */
export type IncidentProfile = { id: string; departmentId: string | null };

/**
 * Un valor fuera del catálogo sólo puede venir de una importación o de una
 * versión revertida: se cae al lado seguro en vez de romper la respuesta
 * entera, igual que con los tipos de notificación y de marcaje.
 */
const toType = (value: string): IncidentType =>
	incidentTypeSchema.catch("forgot_to_mark").parse(value);

const toStatus = (value: string): IncidentStatus =>
	incidentStatusSchema.catch("pending").parse(value);

type ReporterColumns = {
	fullName: string;
	email: string;
	departmentId: string | null;
	departmentName: string | null;
};

function toIncident(
	row: IncidentRow,
	reporter: ReporterColumns,
): AttendanceIncident {
	return {
		id: row.id,
		userId: row.userId,
		userFullName: reporter.fullName,
		userEmail: reporter.email,
		departmentId: reporter.departmentId,
		departmentName: reporter.departmentName,
		incidentType: toType(row.incidentType),
		date: row.date,
		reason: row.reason,
		status: toStatus(row.status),
		managerNotes: row.managerNotes,
		attendanceMarkId: row.attendanceMarkId,
		reviewedBy: row.reviewedBy,
		reviewedAt: row.reviewedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * El orden de la bandeja (§6): **pendientes primero**, y dentro de cada grupo
 * por fecha descendente.
 *
 * Va en SQL y no en un `sort` posterior porque es el orden de una lista que
 * puede crecer y acabar paginada, y porque hay un índice
 * (`attendance_incidents_status_date_idx`) que lo cubre. El desempate por
 * `created_at` no es decorativo: dos incidencias del mismo día y estado tienen
 * que salir siempre en el mismo orden, o la lista baila entre recargas.
 */
const trayOrder = [
	sql`case when ${attendanceIncidents.status} = 'pending' then 0 else 1 end`,
	desc(attendanceIncidents.date),
	desc(attendanceIncidents.createdAt),
];

const withReporter = () =>
	db
		.select({
			...getTableColumns(attendanceIncidents),
			fullName: profiles.fullName,
			email: profiles.email,
			reporterDepartmentId: profiles.departmentId,
			departmentName: departments.name,
		})
		.from(attendanceIncidents)
		.innerJoin(profiles, eq(profiles.id, attendanceIncidents.userId))
		.leftJoin(departments, eq(departments.id, profiles.departmentId));

type JoinedRow = IncidentRow & {
	fullName: string;
	email: string;
	reporterDepartmentId: string | null;
	departmentName: string | null;
};

const fromJoined = (row: JoinedRow): AttendanceIncident =>
	toIncident(row, {
		fullName: row.fullName,
		email: row.email,
		departmentId: row.reporterDepartmentId,
		departmentName: row.departmentName,
	});

type IncidentWithReporter = {
	incident: IncidentRow;
	reporter: ReporterColumns;
};

async function requireIncident(id: string): Promise<IncidentWithReporter> {
	const [row] = await db
		.select({
			incident: attendanceIncidents,
			fullName: profiles.fullName,
			email: profiles.email,
			reporterDepartmentId: profiles.departmentId,
			departmentName: departments.name,
		})
		.from(attendanceIncidents)
		.innerJoin(profiles, eq(profiles.id, attendanceIncidents.userId))
		.leftJoin(departments, eq(departments.id, profiles.departmentId))
		.where(eq(attendanceIncidents.id, id));

	if (!row) {
		throw new HTTPException(404, { message: "Esa incidencia no existe." });
	}

	return {
		incident: row.incident,
		reporter: {
			fullName: row.fullName,
			email: row.email,
			departmentId: row.reporterDepartmentId,
			departmentName: row.departmentName,
		},
	};
}

/**
 * Quién reportó y desde qué departamento, para que la ruta compruebe el ámbito
 * antes de revisar (RN-12.6) — mismo patrón que `departmentOfVacationRequest` y
 * `departmentOfGroup`: el ámbito no se resuelve con un parámetro del cliente,
 * se lee de la fila. Devuelve también el `userId` porque el contexto (§6) lo
 * puede pedir además quien reportó, y comprobarlo con esta misma consulta
 * evita listarle todas sus incidencias para buscar una.
 */
export async function incidentOwnerOf(
	id: string,
): Promise<{ userId: string; departmentId: string | null }> {
	const { incident, reporter } = await requireIncident(id);
	return { userId: incident.userId, departmentId: reporter.departmentId };
}

// ── Reportar (§5, RN-12.3 a RN-12.5) ──────────────────────────────────────────

/**
 * RN-12.2 — El marcaje enlazado tiene que ser **de quien reporta** y **de ese
 * día**. Lo primero es autorización: sin comprobarlo, cualquiera podría colgar
 * la marca de otra persona de su propia incidencia y ponerla delante del
 * revisor. Lo segundo es coherencia: una incidencia del día 3 con la evidencia
 * del día 12 no explica nada.
 *
 * Un marcaje con `work_date` nulo —rechazado antes de poder resolver la jornada,
 * sin horario o con el departamento en pausa— no se puede enlazar: no hay fecha
 * con la que comprobar la coherencia, y aceptarlo sería dejar pasar justo lo que
 * esta comprobación evita.
 */
async function requireOwnMarkOfDate(
	markId: string,
	userId: string,
	date: string,
): Promise<void> {
	const [mark] = await db
		.select({
			userId: attendanceMarks.userId,
			workDate: attendanceMarks.workDate,
		})
		.from(attendanceMarks)
		.where(eq(attendanceMarks.id, markId));

	// Un marcaje ajeno no se distingue de uno que no existe: así no hay forma de
	// sondear identificadores de otras personas, el mismo criterio que en
	// `markRead` de notificaciones.
	if (!mark || mark.userId !== userId) {
		throw new HTTPException(404, {
			message: "Ese marcaje no existe entre los tuyos.",
		});
	}
	if (mark.workDate !== date) {
		throw new HTTPException(400, {
			message:
				"Ese marcaje no pertenece al día que estás reportando: enlaza uno de esa jornada o ninguno.",
		});
	}
}

/**
 * `POST /incidents`. Siempre para uno mismo (RN-12.3): el perfil sale de la
 * sesión y el cuerpo no admite persona.
 *
 * **Sin puerta de rol**, al contrario que `requestVacation`. Allí la spec 11 §4
 * invoca RN-03.4 de forma explícita —quien no marca no acumula ni solicita—;
 * aquí la §7 dice "autenticado" y no hay nada que restringir: una incidencia no
 * consume saldo ni cambia ningún cálculo (RN-12.9), así que un 403 que la spec
 * no pide sería una regla inventada.
 */
export async function reportIncident(
	profile: IncidentProfile,
	input: CreateIncidentInput,
	actor: Actor,
): Promise<AttendanceIncident> {
	const config = await getConfig();
	const today = await todayForDepartment(profile.departmentId);

	// RN-12.3 y RN-12.4, con la misma función y el mismo mensaje que usa el
	// formulario para avisar antes de enviar.
	const issue = incidentDateIssue({
		date: input.date,
		today,
		windowDays: config.incident_report_window_days,
	});
	if (issue) throw new HTTPException(400, { message: issue });

	if (input.attendanceMarkId) {
		await requireOwnMarkOfDate(input.attendanceMarkId, profile.id, input.date);
	}

	return db
		.transaction(async (tx) => {
			const [row] = await tx
				.insert(attendanceIncidents)
				.values({
					userId: profile.id,
					incidentType: input.incidentType,
					date: input.date,
					reason: input.reason,
					attendanceMarkId: input.attendanceMarkId,
					status: "pending",
				})
				// RN-12.5 — El duplicado lo para el índice único parcial, no una
				// comprobación previa: dos envíos simultáneos del mismo formulario no se
				// detectan leyendo antes de insertar.
				.onConflictDoNothing()
				.returning();

			if (!row) {
				throw new HTTPException(409, {
					message: `Ya tienes una incidencia pendiente de tipo «${INCIDENT_TYPE_LABELS[input.incidentType]}» para ese día.`,
				});
			}

			await audit(tx, {
				actorId: actor.profileId,
				action: "incident.reported",
				tableName: "attendance_incidents",
				recordId: row.id,
				newData: {
					incidentType: input.incidentType,
					date: input.date,
					attendanceMarkId: input.attendanceMarkId,
				},
				sourceIp: actor.sourceIp,
			});

			// RN-12.10. Ver la nota de cabecera y la de `additionalHeadsOf`: sólo
			// alcanza a los responsables adicionales conocidos.
			if (profile.departmentId) {
				await notify(tx, await additionalHeadsOf(profile.departmentId), {
					type: "incident.reported",
					title: "Nueva incidencia de asistencia",
					body: `${INCIDENT_TYPE_LABELS[input.incidentType]} del ${input.date}.`,
					actionUrl: "/team",
				});
			}

			return row;
		})
		.then(async (created) => {
			// El nombre, el correo y el departamento se resuelven fuera de la
			// transacción, con el `join` de la lista: no cambian el resultado, sólo
			// cómo se presenta.
			const [row] = await withReporter().where(
				eq(attendanceIncidents.id, created.id),
			);
			if (!row) {
				throw new HTTPException(500, {
					message: "La incidencia se creó pero no se pudo volver a leer.",
				});
			}
			return fromJoined(row);
		});
}

// ── Revisar (§5, RN-12.6 a RN-12.9) ───────────────────────────────────────────

/**
 * `POST /incidents/:id/review`.
 *
 * El ámbito (RN-12.6) lo comprueba la ruta con `canManage` **antes** de llamar
 * aquí, porque necesita el departamento de quien reportó
 * (`departmentOfIncident`). Al servicio le queda lo que no depende de HTTP:
 * nadie revisa la suya (RN-12.6) y una revisada no se reabre (RN-12.8).
 */
export async function reviewIncident(
	id: string,
	input: ReviewIncidentInput,
	actor: Actor,
): Promise<ReviewIncidentResult> {
	const { incident, reporter } = await requireIncident(id);

	// RN-12.8 — Inmutable tras la revisión: no se reabre, se crea otra. El
	// índice único parcial de RN-12.5 lo permite justamente por esto.
	if (incident.status !== "pending") {
		throw new HTTPException(409, {
			message: "Esa incidencia ya fue revisada y no se reabre.",
		});
	}

	// RN-12.6 — "Nadie revisa la suya propia". Es la mitad de la regla que este
	// sistema puede verificar por sí mismo; la otra —que quien revisa sea jefe
	// del ámbito— la comprueba la ruta con los roles de la sesión.
	if (actor.profileId === incident.userId) {
		throw new HTTPException(403, {
			message: "No puedes revisar tu propia incidencia.",
		});
	}

	return db
		.transaction(async (tx) => {
			const [row] = await tx
				.update(attendanceIncidents)
				.set({
					status: input.approved ? "approved" : "rejected",
					managerNotes: input.notes ?? null,
					reviewedBy: actor.profileId,
					reviewedAt: new Date(),
					updatedAt: new Date(),
				})
				// El estado va en el `where` y no sólo en la comprobación de arriba: dos
				// revisores simultáneos sobre la misma incidencia no pueden escribir los
				// dos, y el segundo recibe el 409 en vez de sobrescribir el veredicto
				// del primero.
				.where(
					and(
						eq(attendanceIncidents.id, id),
						eq(attendanceIncidents.status, "pending"),
					),
				)
				.returning();

			if (!row) {
				throw new HTTPException(409, {
					message: "Esa incidencia ya fue revisada y no se reabre.",
				});
			}

			await audit(tx, {
				actorId: actor.profileId,
				action: "incident.reviewed",
				tableName: "attendance_incidents",
				recordId: id,
				oldData: { status: incident.status },
				newData: { status: row.status, notes: row.managerNotes },
				metadata: { justifyAbsence: input.justifyAbsence },
				sourceIp: actor.sourceIp,
			});

			// La acción combinada de la §6 (spec 12), dentro de la **misma**
			// transacción: si la justificación falla, la aprobación no queda hecha a
			// medias con un descuento sin revertir.
			//
			// Las notas de la justificación se componen cuando el revisor no escribió
			// ninguna: RN-13.6 exige un motivo al justificar, y aquí lo hay — la
			// incidencia aprobada **es** el motivo. Dejarlo en nulo habría sido saltarse
			// la regla por la puerta de al lado.
			let absence: ReviewIncidentResult["absence"] = null;
			if (input.justifyAbsence) {
				const target = await absenceTargetOf(incident.userId);
				const payrollAdjustment = await justifyAbsenceFromIncident(
					tx,
					target,
					incident.date,
					input.notes ??
						`Justificada al aprobar la incidencia «${INCIDENT_TYPE_LABELS[toType(incident.incidentType)]}» del ${incident.date}.`,
					actor,
				);
				if (payrollAdjustment) {
					absence = { date: incident.date, payrollAdjustment };
				}
			}

			// RN-12.10 — Al revisar, a quien la reportó. El cuerpo dice explícitamente
			// que aprobarla no corrige el marcaje (RN-12.9): sin esa frase, "aprobada"
			// se lee como "ya está arreglado" y la persona no vuelve a reclamar por
			// algo que sigue igual en su historial.
			await notify(tx, [incident.userId], {
				type: "incident.reviewed",
				title: input.approved
					? "Tu incidencia fue aprobada"
					: "Tu incidencia fue rechazada",
				body: input.approved
					? `${INCIDENT_TYPE_LABELS[toType(incident.incidentType)]} del ${incident.date}. Queda constancia; tu marcaje no cambia.`
					: `${INCIDENT_TYPE_LABELS[toType(incident.incidentType)]} del ${incident.date}. Motivo: ${row.managerNotes ?? "sin notas"}.`,
				actionUrl: "/incidents",
			});

			return { incident: toIncident(row, reporter), absence };
		})
		.then(async (result) => {
			// RN-16.11 — Si se justificó la ausencia, su hecho diario quedó obsoleto.
			// Después de confirmar, por lo mismo que en `reviewAbsence`.
			if (result.absence) {
				await refreshFactsForUser(
					{ id: incident.userId, departmentId: reporter.departmentId },
					{ from: result.absence.date, to: result.absence.date },
				);
			}
			return result;
		});
}

// ── Listar y contar (§6, §7) ──────────────────────────────────────────────────

function filterConditions(filters: ListIncidentsQuery) {
	const conditions = [];
	if (filters.status) {
		conditions.push(eq(attendanceIncidents.status, filters.status));
	}
	if (filters.incidentType) {
		conditions.push(eq(attendanceIncidents.incidentType, filters.incidentType));
	}
	return conditions;
}

export async function listOwnIncidents(
	userId: string,
	filters: ListIncidentsQuery,
): Promise<AttendanceIncident[]> {
	const rows = await withReporter()
		.where(
			and(eq(attendanceIncidents.userId, userId), ...filterConditions(filters)),
		)
		.orderBy(...trayOrder);

	return rows.map(fromJoined);
}

/**
 * La bandeja de un `department_head` o `global_manager` sobre su ámbito
 * (RN-03.2), igual que `listUsers` y `listManagedVacationRequests`:
 * `managedDepartmentIds: "all"` para un gestor global, o la lista concreta para
 * un jefe.
 *
 * El filtro de texto de la §6 busca por nombre, correo **y departamento** de
 * quien reporta — los tres van en el mismo `ilike` porque quien busca escribe lo
 * que recuerda sin declarar en qué campo está.
 */
export async function listManagedIncidents(
	scope: { managedDepartmentIds: string[] | "all" },
	filters: ListIncidentsQuery,
): Promise<AttendanceIncident[]> {
	const conditions = filterConditions(filters);

	if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return [];
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}
	if (filters.departmentId) {
		conditions.push(eq(profiles.departmentId, filters.departmentId));
	}
	if (filters.search) {
		const pattern = `%${filters.search}%`;
		const matches = or(
			sql`${profiles.fullName} ilike ${pattern}`,
			sql`${profiles.email} ilike ${pattern}`,
			sql`${departments.name} ilike ${pattern}`,
		);
		if (matches) conditions.push(matches);
	}

	const rows = await withReporter()
		.where(and(...conditions))
		.orderBy(...trayOrder);

	return rows.map(fromJoined);
}

/**
 * `GET /incidents/pending-count?scope=` — el badge de la navegación (RN-05.8).
 *
 * Es un `count(*)` y no `listX().length` a propósito: el badge se pide en cada
 * carga del shell y traer las filas para contarlas sería el trabajo de la
 * bandeja hecho para descartarlo.
 */
export async function countPendingIncidents(
	scope: { userId: string } | { managedDepartmentIds: string[] | "all" },
): Promise<number> {
	const conditions = [eq(attendanceIncidents.status, "pending")];

	if ("userId" in scope) {
		conditions.push(eq(attendanceIncidents.userId, scope.userId));
	} else if (scope.managedDepartmentIds !== "all") {
		if (scope.managedDepartmentIds.length === 0) return 0;
		conditions.push(inArray(profiles.departmentId, scope.managedDepartmentIds));
	}

	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(attendanceIncidents)
		.innerJoin(profiles, eq(profiles.id, attendanceIncidents.userId))
		.where(and(...conditions));

	return row?.count ?? 0;
}

// ── Contexto de la revisión (§6) ──────────────────────────────────────────────

/**
 * `GET /incidents/:id/context`: el día de la incidencia tal como lo ve el
 * sistema — su estado calculado y sus marcas (spec 15) — más los intentos
 * rechazados de esa jornada.
 *
 * Reutiliza la agregación diaria en vez de recomponerla: es el aviso de la spec
 * 15, que en el legacy esta lógica vivía duplicada entre un hook, una función
 * SQL y una edge function. El revisor tiene que ver **el mismo** estado que ve
 * el empleado en su historial, o la conversación empieza discutiendo qué día es.
 */
export async function getIncidentContext(id: string): Promise<IncidentContext> {
	const { incident } = await requireIncident(id);

	const reporter = await db.query.profiles.findFirst({
		where: eq(profiles.id, incident.userId),
	});
	if (!reporter) {
		throw new HTTPException(404, {
			message: "El perfil de quien reportó ya no existe.",
		});
	}

	const [day] = await getDaysFor(reporter, {
		from: incident.date,
		to: incident.date,
	});
	if (!day) {
		throw new HTTPException(500, {
			message: "No se pudo resolver el día de la incidencia.",
		});
	}

	return {
		incidentId: incident.id,
		day,
		blockedMarks: await listBlockedMarksOfWorkDate(
			incident.userId,
			incident.date,
		),
	};
}
