import {
	type AppRole,
	type AttendanceDay,
	type AttendanceMark,
	type AttendanceMarkResult,
	type AttendanceStatus,
	type CreateAttendanceMarkInput,
	MARK_REJECTION_MESSAGES,
	type MarkRejectionReason,
	type MarkSource,
	type MarkType,
	markRejectionReasonSchema,
	markSourceSchema,
	markTypeSchema,
	roleCanMark,
	type WorkLocation,
} from "@elineas/validations";
import { eachDayOfInterval, format, parseISO, subDays } from "date-fns";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "#/db";
import { attendanceMarks, departments, workLocations } from "#/db/schema";
import {
	type AttendanceMarkContext,
	type RecentMark,
	validateAttendanceMark,
} from "#/services/attendance-rules.ts";
import { getConfig } from "#/services/config.ts";
import { dayKey, loadDailyFacts } from "#/services/daily-facts.ts";
import { listWorkLocations } from "#/services/locations.ts";
import { restDayResolverFor } from "#/services/rest-schedules.ts";
import {
	previousDate,
	todayIn,
	validateMarkTime,
} from "#/services/schedule-rules.ts";
import { getCalendar, getSchedule } from "#/services/schedules.ts";
import { isOnVacationToday } from "#/services/vacations.ts";

/**
 * Marcaje de asistencia (spec 09).
 *
 * Este servicio es **la única puerta de escritura** a `attendance_marks` (spec 09
 * §4): no hay otra función en el proyecto que inserte ahí, y no hay ninguna que
 * actualice ni borre (RN-09.12).
 *
 * Su trabajo es cargar contexto y escribir. Las reglas están en las tres funciones
 * puras —`validateMarkTime` (07), `validateMarkLocation` (08) y
 * `validateAttendanceMark` (09), que compone las dos— y la clasificación del día en
 * `computeDailyStatus` (adelanto de la 15). Aquí no se decide nada.
 */

type MarkRow = typeof attendanceMarks.$inferSelect;

/** Cuánto historial reciente hace falta para el antirrebote y la secuencia. */
const RECENT_MARKS_DAYS = 2;

/** Perfil tal como lo necesita este servicio. */
export type MarkingProfile = {
	id: string;
	isActive: boolean;
	departmentId: string | null;
	selectedWorkLocationId: string | null;
};

function toMark(row: MarkRow, workLocationName: string | null): AttendanceMark {
	const markType = markTypeSchema.safeParse(row.markType);
	const source = markSourceSchema.safeParse(row.source);
	const reason = row.blockReason
		? markRejectionReasonSchema.safeParse(row.blockReason)
		: null;

	return {
		id: row.id,
		userId: row.userId,
		// Un valor que no esté en el catálogo sólo puede venir de una importación mal
		// hecha; se cae al lado seguro en vez de romper la respuesta entera, igual que
		// con los tipos de notificación.
		markType: markType.success ? markType.data : "IN",
		markedAt: row.markedAt.toISOString(),
		workDate: row.workDate,
		latitude: row.latitude,
		longitude: row.longitude,
		accuracy: row.accuracy,
		distanceToCenter: row.distanceToCenter,
		insideGeofence: row.insideGeofence,
		workLocationId: row.workLocationId,
		workLocationName,
		departmentId: row.departmentId,
		blocked: row.blocked,
		blockReason: reason?.success ? reason.data : null,
		isLate: row.isLate,
		lateMinutes: row.lateMinutes,
		source: source.success ? source.data : "manual",
		createdAt: row.createdAt.toISOString(),
	};
}

/** Marcas con el nombre de su sede resuelto, que es como las pinta la interfaz. */
async function selectMarks(where: ReturnType<typeof and>) {
	const rows = await db
		.select({
			mark: attendanceMarks,
			locationName: workLocations.name,
		})
		.from(attendanceMarks)
		.leftJoin(
			workLocations,
			eq(workLocations.id, attendanceMarks.workLocationId),
		)
		.where(where)
		.orderBy(attendanceMarks.markedAt);

	return rows.map((row) => toMark(row.mark, row.locationName));
}

// ── Contexto ──────────────────────────────────────────────────────────────────

type LoadedContext = {
	timezone: string;
	department: AttendanceMarkContext["department"];
	schedule: AttendanceMarkContext["schedule"];
	calendarByDate: Record<
		string,
		{
			isWorkday: boolean;
			lateToleranceMinutes: number | null;
			note: string | null;
		}
	>;
	globalToleranceMinutes: number;
	selectedLocation: WorkLocation | null;
	activeLocations: WorkLocation[];
	recentMarks: RecentMark[];
	/**
	 * Spec 10: los descansos de esta persona, ya resueltos como predicado sobre el
	 * día laboral. Es la costura que la spec 09 dejó preparada —recibía los
	 * descansos por predicado para no elegir la convención de `days_of_week` antes
	 * de tiempo— y conectarla es literalmente pasar este argumento.
	 */
	isRestDay: (workDate: string) => boolean;
	/**
	 * Spec 11 RN-09.2: ¿tiene una solicitud aprobada que cubre **hoy**? Es la
	 * otra costura que la spec 09 dejó preparada, y la única de las dos que se
	 * resuelve para "hoy" y no para el día laboral: RN-09.2 se comprueba **antes**
	 * de que `validateMarkTime` resuelva a qué jornada pertenece la marca (spec
	 * 09 §3, es el segundo paso del orden exacto), así que todavía no hay un
	 * `workDate` contra el que preguntar.
	 */
	onVacation: boolean;
};

/**
 * Todo lo que las funciones puras necesitan, cargado de una vez.
 *
 * El calendario se pide sólo para los **dos días candidatos** —el local y el
 * anterior—, que son los únicos que una jornada nocturna puede tocar (RN-07.5): no
 * hace falta el mes para decidir un marcaje.
 */
async function loadContext(
	profile: MarkingProfile,
	at: Date,
): Promise<LoadedContext> {
	const config = await getConfig();

	const department = profile.departmentId
		? ((await db.query.departments.findFirst({
				where: eq(departments.id, profile.departmentId),
			})) ?? null)
		: null;

	const schedule = department ? await getSchedule(department.id) : null;
	const timezone = schedule?.timezone ?? config.global_timezone;

	const localDate = todayIn(timezone, at);
	const calendarByDate: LoadedContext["calendarByDate"] = {};

	if (department) {
		const entries = await getCalendar(department.id, {
			from: previousDate(localDate),
			to: localDate,
		});
		for (const entry of entries) {
			calendarByDate[entry.date] = {
				isWorkday: entry.isWorkday,
				lateToleranceMinutes: entry.lateToleranceMinutes,
				note: entry.note,
			};
		}
	}

	const [selectedLocation] = profile.selectedWorkLocationId
		? await db
				.select()
				.from(workLocations)
				.where(eq(workLocations.id, profile.selectedWorkLocationId))
		: [];

	const activeLocations = await listWorkLocations({ includeInactive: false });

	const isRestDay = await restDayResolverFor(profile);
	const onVacation = await isOnVacationToday(profile.id, localDate);

	const recentRows = await db
		.select({
			id: attendanceMarks.id,
			markType: attendanceMarks.markType,
			markedAt: attendanceMarks.markedAt,
			workDate: attendanceMarks.workDate,
		})
		.from(attendanceMarks)
		.where(
			and(
				eq(attendanceMarks.userId, profile.id),
				eq(attendanceMarks.blocked, false),
				gte(attendanceMarks.markedAt, subDays(at, RECENT_MARKS_DAYS)),
			),
		)
		.orderBy(desc(attendanceMarks.markedAt));

	return {
		timezone,
		department: department
			? {
					id: department.id,
					name: department.name,
					isPaused: department.isPaused,
					pauseReason: department.pauseReason,
				}
			: null,
		schedule,
		calendarByDate,
		globalToleranceMinutes: config.late_tolerance_minutes,
		selectedLocation: selectedLocation
			? {
					id: selectedLocation.id,
					name: selectedLocation.name,
					centerLat: selectedLocation.centerLat,
					centerLng: selectedLocation.centerLng,
					radiusMeters: selectedLocation.radiusMeters,
					accuracyThreshold: selectedLocation.accuracyThreshold,
					blockOnPoorAccuracy: selectedLocation.blockOnPoorAccuracy,
					isActive: selectedLocation.isActive,
					createdAt: selectedLocation.createdAt.toISOString(),
					updatedAt: selectedLocation.updatedAt.toISOString(),
				}
			: null,
		activeLocations,
		recentMarks: recentRows.map((row) => ({
			id: row.id,
			markType: markTypeSchema.catch("IN").parse(row.markType),
			markedAt: row.markedAt,
			workDate: row.workDate,
		})),
		isRestDay,
		onVacation,
	};
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * `POST /attendance/marks`.
 *
 * Tres cosas que hace y que conviene no perder de vista:
 *
 * - **El instante lo pone aquí el servidor** (RN-09.11), una sola vez, y el mismo
 *   valor se valida y se guarda. Si se dejara a `defaultNow()` de la base, la hora
 *   validada y la almacenada podrían diferir en milisegundos y, en el borde de la
 *   ventana, en el veredicto.
 * - **Un rechazo también se escribe** (decisión 2 de la §8), con `blocked = true` y
 *   el motivo. Es lo que sostiene "intenté marcar cuatro veces" en soporte y en una
 *   incidencia (spec 12).
 * - **El doble toque no duplica** (RN-09.10): primero por la ventana de 30 s que
 *   comprueba la función pura, y si dos peticiones llegan a la vez —que es el caso
 *   real del doble toque— por los índices únicos por minuto de la base. Cuando el
 *   índice gana la carrera, se devuelve la fila que sí entró.
 */
export async function createMark(
	profile: MarkingProfile,
	role: AppRole,
	input: CreateAttendanceMarkInput,
	source: MarkSource = "manual",
): Promise<AttendanceMarkResult> {
	const at = new Date();
	const context = await loadContext(profile, at);

	const decision = validateAttendanceMark({
		markType: input.markType,
		at,
		role,
		profile: { isActive: profile.isActive },
		department: context.department,
		schedule: context.schedule,
		calendarByDate: context.calendarByDate,
		// Los descansos ya están conectados (spec 10 RN-10.4): un intento en día de
		// descanso se rechaza con `REST_DAY` y queda registrado como los demás.
		isRestDay: context.isRestDay,
		// Y las vacaciones también (spec 11 RN-09.2): con una solicitud aprobada
		// vigente hoy, se rechaza con `ON_VACATION` antes de mirar nada más.
		onVacation: context.onVacation,
		globalToleranceMinutes: context.globalToleranceMinutes,
		requestedLocationId: input.workLocationId,
		selectedLocation: context.selectedLocation,
		activeLocations: context.activeLocations,
		position: {
			latitude: input.latitude,
			longitude: input.longitude,
			accuracy: input.accuracy,
		},
		recentMarks: context.recentMarks,
	});

	// Repetición: no se escribe nada y se devuelve la marca que ya existía.
	if (decision.duplicate && decision.duplicateOfId) {
		const [existing] = await selectMarks(
			eq(attendanceMarks.id, decision.duplicateOfId),
		);
		return {
			accepted: true,
			duplicate: true,
			reason: "DUPLICATE_MARK",
			message: decision.message,
			mark: existing ?? null,
		};
	}

	const [inserted] = await db
		.insert(attendanceMarks)
		.values({
			userId: profile.id,
			markType: input.markType,
			markedAt: at,
			workDate: decision.workDate,
			latitude: input.latitude,
			longitude: input.longitude,
			accuracy: input.accuracy,
			distanceToCenter: decision.distanceToCenter,
			insideGeofence: decision.insideGeofence,
			workLocationId: decision.workLocationId,
			departmentId: context.department?.id ?? null,
			blocked: !decision.accepted,
			blockReason: decision.accepted ? null : decision.reason,
			isLate: decision.isLate,
			lateMinutes: decision.lateMinutes,
			source,
		})
		// Los índices únicos por minuto son la red del doble toque simultáneo: si otra
		// petición idéntica ya escribió, ésta no inserta y se devuelve aquélla.
		.onConflictDoNothing()
		.returning();

	if (!inserted) {
		const [existing] = await selectMarks(
			and(
				eq(attendanceMarks.userId, profile.id),
				eq(attendanceMarks.markType, input.markType),
				eq(attendanceMarks.blocked, !decision.accepted),
				sql`date_trunc('minute', ${attendanceMarks.markedAt} at time zone 'UTC') = date_trunc('minute', ${at.toISOString()}::timestamptz at time zone 'UTC')`,
			),
		);

		return {
			accepted: decision.accepted,
			duplicate: true,
			reason: decision.accepted ? "DUPLICATE_MARK" : decision.reason,
			message: decision.accepted
				? "Ese marcaje ya estaba registrado. No se duplica."
				: decision.message,
			mark: existing ?? null,
		};
	}

	const [mark] = await selectMarks(eq(attendanceMarks.id, inserted.id));

	return {
		accepted: decision.accepted,
		duplicate: false,
		reason: decision.reason,
		message: decision.message,
		mark: mark ?? null,
	};
}

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * El día laboral **en curso** para esta persona.
 *
 * No es "hoy" sin más: en una jornada nocturna, a las 03:00 la jornada abierta es la
 * de ayer (RN-07.5), y las marcas de "hoy" que hay que mostrar son las de ella. Se
 * resuelve mirando si hay una entrada sin salida y, si no la hay, con el día que
 * resolvería una entrada ahora mismo.
 */
function resolveActiveWorkDate(
	context: LoadedContext,
	at: Date,
	role: AppRole,
): {
	workDate: string | null;
	inVerdict: ReturnType<typeof validateMarkTime>;
	outVerdict: ReturnType<typeof validateMarkTime>;
} {
	const common = {
		at,
		role,
		department: context.department ?? {
			id: "",
			name: "",
			isPaused: false,
			pauseReason: null,
		},
		schedule: context.schedule,
		calendarByDate: context.calendarByDate,
		// Sin esto, `GET /attendance/status` diría "puedes registrar tu entrada" en
		// un día de descanso y el `POST` lo rechazaría a continuación: el estado
		// tiene que aplicar las mismas reglas que la escritura (spec 09 §6).
		isRestDay: context.isRestDay,
		globalToleranceMinutes: context.globalToleranceMinutes,
	} as const;

	const inVerdict = validateMarkTime({ ...common, markType: "IN" });
	const outVerdict = validateMarkTime({ ...common, markType: "OUT" });

	// Jornada abierta: la entrada más reciente sin una salida posterior.
	const open = context.recentMarks.find((mark, index) => {
		if (mark.markType !== "IN") return false;
		const laterOut = context.recentMarks
			.slice(0, index)
			.some(
				(other) => other.markType === "OUT" && other.workDate === mark.workDate,
			);
		return !laterOut;
	});

	return {
		workDate:
			open?.workDate ?? inVerdict.workDate ?? outVerdict.workDate ?? null,
		inVerdict,
		outVerdict,
	};
}

export async function getStatus(
	profile: MarkingProfile,
	role: AppRole,
): Promise<AttendanceStatus> {
	const at = new Date();
	const context = await loadContext(profile, at);
	const canMark = roleCanMark(role);

	const { workDate, inVerdict, outVerdict } = resolveActiveWorkDate(
		context,
		at,
		role,
	);

	const dayMarks = workDate
		? await selectMarks(
				and(
					eq(attendanceMarks.userId, profile.id),
					eq(attendanceMarks.blocked, false),
					eq(attendanceMarks.workDate, workDate),
				),
			)
		: [];

	const last = dayMarks.at(-1) ?? null;
	const openSince = last?.markType === "IN" ? last.markedAt : null;

	const nextMarkType: MarkType | null = !canMark
		? null
		: last?.markType === "IN"
			? "OUT"
			: "IN";

	const applicable = nextMarkType === "OUT" ? outVerdict : inVerdict;

	// RN-09.2: las vacaciones se comprueban **antes** que la ventana horaria
	// (spec 09 §3, es el segundo paso del orden exacto), así que aquí se aplican
	// como un gate más externo que `inVerdict`/`outVerdict` — igual que `canMark`,
	// que tampoco pasa por `validateMarkTime`. `validateMarkTime` es de la spec 07
	// y no conoce vacaciones; meterlo ahí sería una capa que no le corresponde.
	const canCheckIn =
		canMark &&
		!context.onVacation &&
		inVerdict.allowed &&
		last?.markType !== "IN";
	const canCheckOut =
		canMark &&
		!context.onVacation &&
		outVerdict.allowed &&
		last?.markType === "IN";

	const reason: MarkRejectionReason | null = !canMark
		? "ROLE_CANNOT_MARK"
		: context.onVacation
			? "ON_VACATION"
			: canCheckIn || canCheckOut
				? null
				: (applicable.reason ?? null);

	const message = !canMark
		? MARK_REJECTION_MESSAGES.ROLE_CANNOT_MARK
		: context.onVacation
			? MARK_REJECTION_MESSAGES.ON_VACATION
			: canCheckIn
				? "Puedes registrar tu entrada."
				: canCheckOut
					? "Puedes registrar tu salida."
					: (applicable.message ?? "Ahora mismo no puedes marcar.");

	return {
		workDate,
		nextMarkType: canCheckIn ? "IN" : canCheckOut ? "OUT" : nextMarkType,
		canCheckIn,
		canCheckOut,
		reason,
		message,
		openSince,
		marks: dayMarks,
		canMark,
	};
}

/** `GET /attendance/marks/today`: las marcas de la jornada en curso. */
export async function getTodayMarks(
	profile: MarkingProfile,
	role: AppRole,
): Promise<AttendanceMark[]> {
	return (await getStatus(profile, role)).marks;
}

/**
 * El historial de una persona, ya agregado por día. Sirve a
 * `GET /attendance/me?from=&to=` —donde el perfil es siempre el de la sesión, sin
 * parámetro de persona posible— y al contexto que la bandeja de incidencias pone
 * junto a cada una (spec 12 §6), donde el perfil es el de quien reportó y el
 * ámbito lo comprueba esa ruta.
 *
 * Se llamaba `getMyDays`; el "my" era del endpoint, no de la función, y con dos
 * consumidores el nombre habría hecho pensar que la segunda llamada estaba mal.
 *
 * El frontend **no calcula estados** (spec 15 §4): recibe el día resuelto.
 */
export async function getDaysFor(
	profile: MarkingProfile,
	range: { from: string; to: string },
): Promise<AttendanceDay[]> {
	// La clasificación sale del servicio de agregación (spec 15 §4), no de una
	// composición paralela aquí. Antes este cuerpo repetía calendario, descansos,
	// vacaciones y revisiones de ausencia por su cuenta: dos composiciones del
	// mismo estado, que es exactamente el error del legacy que la §1 de esa spec
	// manda no repetir.
	const facts = await loadDailyFacts([profile], range);

	// Las marcas se piden aparte porque aquí se **presentan**, con su sede y su
	// motivo de rechazo resueltos; a la agregación le basta con el tipo y la hora.
	const marks = await selectMarks(
		and(
			eq(attendanceMarks.userId, profile.id),
			eq(attendanceMarks.blocked, false),
			gte(attendanceMarks.workDate, range.from),
			lte(attendanceMarks.workDate, range.to),
		),
	);

	const days = eachDayOfInterval({
		start: parseISO(range.from),
		end: parseISO(range.to),
	}).map((day) => format(day, "yyyy-MM-dd"));

	return days.map((date) => {
		const fact = facts.get(dayKey(profile.id, date));
		const dayMarks = marks.filter((mark) => mark.workDate === date);

		return {
			date,
			status: fact?.status ?? "AUSENTE",
			firstIn: fact?.firstIn?.toISOString() ?? null,
			lastOut: fact?.lastOut?.toISOString() ?? null,
			workedMinutes: fact?.workedMinutes ?? null,
			incomplete: fact?.incomplete ?? false,
			pending: fact?.pending ?? false,
			isLate: fact?.isLate ?? false,
			lateMinutes: fact?.lateMinutes ?? 0,
			absence: fact?.absence ?? null,
			marks: dayMarks,
		};
	});
}

/** Para las pruebas y para la spec 12: las marcas de una jornada, tal cual. */
export async function listMarksOfWorkDate(
	userId: string,
	workDate: string,
): Promise<AttendanceMark[]> {
	return selectMarks(
		and(
			eq(attendanceMarks.userId, userId),
			inArray(attendanceMarks.workDate, [workDate]),
		),
	);
}

/**
 * Los **intentos rechazados** de una jornada (RN-09.8), que el historial no
 * devuelve porque sólo cuenta los válidos. Es la evidencia con la que se revisa
 * una incidencia de "intenté marcar y no me dejó" (spec 12, cabecera).
 *
 * Filtra por `work_date`, así que **no alcanza a un intento rechazado antes de
 * poder resolver la jornada** —sin horario, o con el departamento en pausa: esas
 * filas nacen con `work_date` nulo (ver el esquema). No es una pérdida
 * significativa: en esos dos casos no hay jornada con la que correlacionar nada,
 * y la incidencia que abriría esa persona no es sobre un marcaje concreto.
 */
export async function listBlockedMarksOfWorkDate(
	userId: string,
	workDate: string,
): Promise<AttendanceMark[]> {
	return selectMarks(
		and(
			eq(attendanceMarks.userId, userId),
			eq(attendanceMarks.workDate, workDate),
			eq(attendanceMarks.blocked, true),
		),
	);
}
