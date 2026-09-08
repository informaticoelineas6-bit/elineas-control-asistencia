import {
	type AdminStats,
	type AttendanceImportReport,
	type AttendanceImportResult,
	type AttendanceImportRow,
	IMPORT_MAX_ROWS,
	type MaintenanceState,
	parseImportRow,
	type SetMaintenanceInput,
} from "@elineas/validations";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { readXlsx } from "hucre/xlsx";
import { db } from "#/db";
import {
	appConfig,
	attendanceMarks,
	auditLog,
	departmentSchedules,
	departments,
	profiles,
	userDepartmentResponsibilities,
} from "#/db/schema";
import { countPendingAbsences } from "#/services/absences.ts";
import { type Actor, audit } from "#/services/audit.ts";
import { getConfig, invalidateConfigCache } from "#/services/config.ts";
import { refreshDailyFacts } from "#/services/daily-facts-store.ts";
import { countPendingIncidents } from "#/services/incidents.ts";
import { countRuns } from "#/services/reports.ts";
import { todayIn } from "#/services/schedule-rules.ts";
import { countPendingVacationRequests } from "#/services/vacations.ts";

/**
 * Panel de superadmin (spec 19).
 *
 * ⚠️ **Aquí no hay ninguna función que ejecute SQL libre**, y es la decisión de
 * la §6.1 —"la decisión de seguridad más importante del proyecto"— resuelta por
 * la alternativa que la propia spec recomienda: no reimplementar la consola. El
 * razonamiento completo está en `packages/contracts/src/admin.ts`; el resumen es
 * que una lista negra sobre texto SQL no se puede arreglar y que la necesidad
 * legítima ya la cubre `db:studio`, con credenciales que no se alcanzan desde un
 * navegador.
 *
 * Lo que sí hay es lo que RN-19.10 tolera: cosas que se hacen **una vez** o
 * **casi nunca** —mirar el estado global, parar el sistema, traer un histórico—
 * y que por eso no son una funcionalidad del producto.
 */

// ── §2.1 Estadísticas globales ───────────────────────────────────────────────

/**
 * El estado global, en seis consultas y tres reutilizadas.
 *
 * Reutiliza los contadores que ya existen —incidencias, vacaciones y ausencias
 * pendientes, corridas de reporte— **con ámbito `"all"`**: son las mismas
 * funciones que alimentan el badge del aside de un jefe, y aquí se piden sin
 * acotar. No hay una segunda implementación de "cuántas incidencias hay
 * pendientes", que es como en el legacy acabaron discrepando el panel y la
 * bandeja.
 */
export async function getAdminStats(): Promise<AdminStats> {
	const config = await getConfig();
	const today = todayIn(config.global_timezone);
	const monthStart = `${today.slice(0, 7)}-01`;

	const [profileCounts] = await db
		.select({
			total: sql<number>`count(*)::int`,
			active: sql<number>`count(*) filter (where ${profiles.isActive})::int`,
			inactive: sql<number>`count(*) filter (where not ${profiles.isActive})::int`,
			incomplete: sql<number>`count(*) filter (where ${profiles.departmentId} is null and ${profiles.isActive})::int`,
		})
		.from(profiles);

	const [scopeCount] = await db
		.select({
			count: sql<number>`count(distinct ${userDepartmentResponsibilities.userId})::int`,
		})
		.from(userDepartmentResponsibilities);

	const [departmentCounts] = await db
		.select({
			total: sql<number>`count(*)::int`,
			paused: sql<number>`count(*) filter (where ${departments.isPaused})::int`,
			withoutSchedule: sql<number>`count(*) filter (where ${departmentSchedules.id} is null)::int`,
		})
		.from(departments)
		.leftJoin(
			departmentSchedules,
			eq(departmentSchedules.departmentId, departments.id),
		);

	const [markCounts] = await db
		.select({
			marksToday: sql<number>`count(*) filter (where ${attendanceMarks.workDate} = ${today} and not ${attendanceMarks.blocked})::int`,
			marksThisMonth: sql<number>`count(*) filter (where ${attendanceMarks.workDate} >= ${monthStart} and not ${attendanceMarks.blocked})::int`,
			blockedToday: sql<number>`count(*) filter (where ${attendanceMarks.workDate} = ${today} and ${attendanceMarks.blocked})::int`,
			importedTotal: sql<number>`count(*) filter (where ${attendanceMarks.source} = 'import')::int`,
		})
		.from(attendanceMarks);

	const [auditCount] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(auditLog)
		.where(gte(auditLog.createdAt, new Date(Date.now() - 86_400_000)));

	const scope = { managedDepartmentIds: "all" as const };
	const [incidents, vacations, absences, queued, running, failed] =
		await Promise.all([
			countPendingIncidents(scope),
			countPendingVacationRequests(scope),
			countPendingAbsences(scope, {}),
			countRuns("queued"),
			countRuns("running"),
			countRuns("failed"),
		]);

	return {
		profiles: {
			total: profileCounts?.total ?? 0,
			active: profileCounts?.active ?? 0,
			inactive: profileCounts?.inactive ?? 0,
			incomplete: profileCounts?.incomplete ?? 0,
			withAdditionalScope: scopeCount?.count ?? 0,
		},
		departments: {
			total: departmentCounts?.total ?? 0,
			paused: departmentCounts?.paused ?? 0,
			withoutSchedule: departmentCounts?.withoutSchedule ?? 0,
		},
		attendance: {
			marksToday: markCounts?.marksToday ?? 0,
			marksThisMonth: markCounts?.marksThisMonth ?? 0,
			blockedToday: markCounts?.blockedToday ?? 0,
			importedTotal: markCounts?.importedTotal ?? 0,
		},
		pending: { incidents, vacations, absences },
		reports: { queued, running, failed },
		audit: { lastDay: auditCount?.count ?? 0 },
		generatedAt: new Date().toISOString(),
	};
}

// ── §2.5 Modo de mantenimiento ───────────────────────────────────────────────

/**
 * Estado del mantenimiento.
 *
 * `since` y `byName` **salen de la bitácora**, no de una columna: la §2.5 pide
 * "quién y cuándo lo activó" y eso ya se escribe donde va ese tipo de dato
 * (spec 18). Guardarlo además en `app_config` serían dos registros del mismo
 * hecho que se pueden desincronizar, y el de la bitácora es el que no se puede
 * editar.
 */
export async function getMaintenance(): Promise<MaintenanceState> {
	const config = await getConfig();
	if (!config.maintenance_mode) {
		return { active: false, message: null, since: null, byName: null };
	}

	const [entry] = await db
		.select({
			createdAt: auditLog.createdAt,
			actorName: profiles.fullName,
		})
		.from(auditLog)
		.leftJoin(profiles, eq(profiles.id, auditLog.actorId))
		.where(eq(auditLog.action, "maintenance.enabled"))
		.orderBy(desc(auditLog.createdAt))
		.limit(1);

	return {
		active: true,
		message: config.maintenance_message,
		since: entry?.createdAt.toISOString() ?? null,
		byName: entry?.actorName ?? null,
	};
}

/**
 * Activa o desactiva el mantenimiento (§2.5, decisión 2 cerrada).
 *
 * **Qué hace exactamente**, que es lo que la spec dejaba sin definir:
 *
 * - **Bloquea toda escritura** de cualquier rol por debajo de `superadmin`, con
 *   un 503 que lleva el mensaje. Marcar asistencia es una escritura, así que
 *   queda bloqueado; el 503 es además el código correcto para "vuelve luego".
 * - **No cierra sesiones**, y a propósito: cerrarlas sólo obligaría a toda la
 *   plantilla a volver a autenticarse contra el Identity Server —que es otro
 *   sistema y no está en mantenimiento— sin impedir nada que el bloqueo de
 *   escrituras no impida ya.
 * - **Las lecturas siguen**, y el login también: quien abra la aplicación tiene
 *   que poder ver el aviso y sus propios datos. Un sistema que no deja entrar no
 *   puede explicar por qué.
 * - **El `superadmin` está exento**, porque es quien está haciendo el
 *   mantenimiento y quien tiene que poder desactivarlo.
 *
 * No pasa por `setConfig` a propósito: allí la bitácora diría `config.updated`, y
 * lo que hace falta aquí es un verbo propio —`maintenance.enabled`— con su motivo
 * dentro. Es de donde `getMaintenance` saca el "quién y cuándo".
 */
export async function setMaintenance(
	input: SetMaintenanceInput,
	actor: Actor,
): Promise<MaintenanceState> {
	const message = input.message?.trim() ?? "";
	if (input.active && message.length === 0) {
		throw new HTTPException(400, {
			message:
				"Escribe el motivo del mantenimiento: es lo que va a leer toda la plantilla.",
		});
	}

	const before = await getConfig();
	if (before.maintenance_mode === input.active) {
		// Idempotente y sin ruido: repetir la misma orden no llena la bitácora de
		// entradas que no cuentan ningún cambio.
		return getMaintenance();
	}

	await db.transaction(async (tx) => {
		for (const [key, value] of [
			["maintenance_mode", input.active],
			["maintenance_message", input.active ? message : null],
		] as const) {
			await tx
				.insert(appConfig)
				.values({
					key,
					value,
					updatedBy: actor.profileId,
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: appConfig.key,
					set: { value, updatedBy: actor.profileId, updatedAt: new Date() },
				});
		}

		// RN-19.8 — Con su verbo propio y el motivo dentro.
		await audit(tx, {
			actorId: actor.profileId,
			action: input.active ? "maintenance.enabled" : "maintenance.disabled",
			tableName: "app_config",
			recordId: "maintenance_mode",
			oldData: { maintenance_mode: before.maintenance_mode },
			newData: { maintenance_mode: input.active },
			metadata: input.active ? { message } : null,
			sourceIp: actor.sourceIp,
		});
	});

	invalidateConfigCache();
	return getMaintenance();
}

// ── §2.4 Importación de histórico ────────────────────────────────────────────

type ParsedFile = {
	rows: number;
	valid: { row: number; value: AttendanceImportRow }[];
	issues: AttendanceImportReport["issues"];
};

/**
 * Lee la hoja y traduce cada fila, sin tocar la base.
 *
 * **Se salta la primera fila**, que es la cabecera, y no comprueba sus textos:
 * un archivo exportado de otro sistema trae los rótulos que trae, y exigir un
 * texto exacto convierte un histórico entero en cero filas válidas por una
 * tilde. Las columnas se leen por posición (`IMPORT_COLUMNS`).
 */
async function parseWorkbook(bytes: Uint8Array): Promise<ParsedFile> {
	const workbook = await readXlsx(bytes).catch(() => null);
	const sheet = workbook?.sheets[0];
	if (!sheet) {
		throw new HTTPException(400, {
			message: "Ese archivo no es una hoja de cálculo que se pueda leer.",
		});
	}

	const dataRows = sheet.rows.slice(1);
	if (dataRows.length > IMPORT_MAX_ROWS) {
		throw new HTTPException(413, {
			message: `El archivo trae ${dataRows.length} filas y el máximo es ${IMPORT_MAX_ROWS}. Divídelo en tandas.`,
		});
	}

	const parsed: ParsedFile = { rows: 0, valid: [], issues: [] };

	for (const [index, cells] of dataRows.entries()) {
		// +2: la cabecera cuenta como fila 1 y el índice empieza en 0, así que el
		// número que se enseña es el que la persona ve en Excel.
		const row = index + 2;
		const isEmpty = cells.every(
			(cell) => cell === null || cell === undefined || cell === "",
		);
		if (isEmpty) continue;

		parsed.rows += 1;
		const result = parseImportRow(cells, row);
		if (result.ok) parsed.valid.push({ row, value: result.value });
		else parsed.issues.push(result.issue);
	}

	return parsed;
}

type Resolved = {
	userId: string;
	departmentId: string | null;
	markType: "IN" | "OUT";
	markedAt: Date;
	date: string;
};

/**
 * Resuelve los correos contra los perfiles y descarta lo que no existe.
 *
 * El instante se construye **con la zona configurada** (RN-06.6), no con la del
 * servidor: la hora del archivo es hora de pared de la planta, y meterla como
 * UTC correría todos los marcajes cuatro o cinco horas — suficiente para que una
 * entrada de las 08:00 apareciera como tardanza o cayera en otro día laboral.
 */
async function resolvePeople(
	parsed: ParsedFile,
	timezone: string,
): Promise<{ resolved: Resolved[]; issues: AttendanceImportReport["issues"] }> {
	const emails = [...new Set(parsed.valid.map((entry) => entry.value.email))];
	const people =
		emails.length === 0
			? []
			: await db
					.select({
						id: profiles.id,
						email: profiles.email,
						departmentId: profiles.departmentId,
						isActive: profiles.isActive,
					})
					.from(profiles)
					.where(inArray(sql`lower(${profiles.email})`, emails));

	const byEmail = new Map(
		people.map((person) => [person.email.toLowerCase(), person]),
	);

	const resolved: Resolved[] = [];
	const issues: AttendanceImportReport["issues"] = [];

	for (const { row, value } of parsed.valid) {
		const person = byEmail.get(value.email);
		if (!person) {
			issues.push({
				row,
				message: `No hay perfil con el correo ${value.email}.`,
			});
			continue;
		}
		resolved.push({
			userId: person.id,
			departmentId: person.departmentId,
			markType: value.markType,
			markedAt: zonedInstant(value.date, value.time, timezone),
			date: value.date,
		});
	}

	return { resolved, issues };
}

/**
 * `2026-03-14` + `08:30` + `America/Havana` → el instante que le corresponde.
 *
 * Se resuelve preguntando **cuánto se desvía esa zona en ese instante** en vez de
 * sumar un desplazamiento fijo: el horario de verano cambia el desfase a mitad de
 * año, y un histórico cruza esa frontera por definición.
 */
function zonedInstant(date: string, time: string, timezone: string): Date {
	const naive = Date.parse(
		`${date}T${time.length === 5 ? `${time}:00` : time}Z`,
	);
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		timeZoneName: "longOffset",
	});
	const offsetName =
		formatter
			.formatToParts(new Date(naive))
			.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
	const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetName);
	if (!match) return new Date(naive);

	const [, sign = "+", hours = "0", minutes = "0"] = match;
	const offsetMs =
		(Number(hours) * 60 + Number(minutes)) * 60_000 * (sign === "-" ? -1 : 1);
	// La hora de pared menos el desplazamiento de la zona da el instante UTC.
	return new Date(naive - offsetMs);
}

const minuteKey = (entry: Resolved) =>
	`${entry.userId}|${entry.markType}|${entry.markedAt.toISOString().slice(0, 16)}`;

/** Cuáles de estas filas ya están en la base (RN-19.3). */
async function countAlreadyPresent(resolved: Resolved[]): Promise<number> {
	if (resolved.length === 0) return 0;

	const userIds = [...new Set(resolved.map((entry) => entry.userId))];
	const existing = await db
		.select({
			userId: attendanceMarks.userId,
			markType: attendanceMarks.markType,
			markedAt: attendanceMarks.markedAt,
		})
		.from(attendanceMarks)
		.where(
			and(
				inArray(attendanceMarks.userId, userIds),
				eq(attendanceMarks.blocked, false),
			),
		);

	const present = new Set(
		existing.map(
			(row) =>
				`${row.userId}|${row.markType}|${row.markedAt.toISOString().slice(0, 16)}`,
		),
	);
	return resolved.filter((entry) => present.has(minuteKey(entry))).length;
}

function toReport(
	parsed: ParsedFile,
	resolved: Resolved[],
	extraIssues: AttendanceImportReport["issues"],
	alreadyPresent: number,
): AttendanceImportReport {
	const dates = resolved.map((entry) => entry.date).sort();
	return {
		rows: parsed.rows,
		valid: resolved.length,
		issues: [...parsed.issues, ...extraIssues].sort((a, b) => a.row - b.row),
		alreadyPresent,
		people: new Set(resolved.map((entry) => entry.userId)).size,
		from: dates.at(0) ?? null,
		to: dates.at(-1) ?? null,
	};
}

/** RN-19.2 — El informe previo. **No escribe nada**, y hay una prueba de eso. */
export async function validateAttendanceImport(
	bytes: Uint8Array,
): Promise<AttendanceImportReport> {
	const config = await getConfig();
	const parsed = await parseWorkbook(bytes);
	const { resolved, issues } = await resolvePeople(
		parsed,
		config.global_timezone,
	);
	return toReport(
		parsed,
		resolved,
		issues,
		await countAlreadyPresent(resolved),
	);
}

/**
 * Escribe el histórico.
 *
 * Tres reglas de la §2.4 se cumplen sin código propio, y merece la pena saber
 * por qué:
 *
 * - **RN-19.1** — `source: "import"`. La columna existe desde la spec 09
 *   precisamente para esto: *"cuando exista la importación histórica, nadie podrá
 *   distinguirlos hacia atrás si no está el campo"*.
 * - **RN-19.3** — la idempotencia la sostiene el **índice único por minuto** que
 *   la spec 09 creó para el antirrebote (`attendance_marks_valid_minute_idx`), así
 *   que reimportar el mismo archivo no duplica nada aunque se haga dos veces a la
 *   vez. `onConflictDoNothing` y a otra cosa.
 * - **RN-19.5** — sin coordenadas: `latitude`, `longitude` y `accuracy` van nulos.
 *   No es un valor de relleno, es la verdad — de ese marcaje no se midió la
 *   ubicación. Un `0, 0` diría "el golfo de Guinea" y `accuracy: 0` diría
 *   "precisión perfecta", que es lo contrario de lo que hay.
 *
 * Y una que sí necesita trabajo: **RN-19.4**, el recálculo de los hechos diarios
 * del rango afectado. Sin él, el reporte del mes seguiría contando ausencias
 * donde ahora hay marcajes.
 */
export async function commitAttendanceImport(
	bytes: Uint8Array,
	filename: string,
	actor: Actor,
): Promise<AttendanceImportResult> {
	const config = await getConfig();
	const parsed = await parseWorkbook(bytes);
	const { resolved, issues } = await resolvePeople(
		parsed,
		config.global_timezone,
	);
	const report = toReport(
		parsed,
		resolved,
		issues,
		await countAlreadyPresent(resolved),
	);

	if (resolved.length === 0) {
		return { ...report, inserted: 0, factsRefreshed: 0 };
	}

	const inserted = await db.transaction(async (tx) => {
		const rows = await tx
			.insert(attendanceMarks)
			.values(
				resolved.map((entry) => ({
					userId: entry.userId,
					markType: entry.markType,
					markedAt: entry.markedAt,
					// El día laboral del histórico es el del archivo: no se recalcula con
					// el horario de hoy, que puede no ser el de entonces (RN-06.4).
					workDate: entry.date,
					latitude: null,
					longitude: null,
					accuracy: null,
					distanceToCenter: null,
					insideGeofence: null,
					workLocationId: null,
					departmentId: entry.departmentId,
					blocked: false,
					// Un histórico no se juzga con la tolerancia de hoy: se importa el
					// hecho, no su calificación.
					isLate: false,
					lateMinutes: 0,
					source: "import" as const,
				})),
			)
			.onConflictDoNothing()
			.returning({ id: attendanceMarks.id });

		// RN-19.6 — Con el nombre del archivo, el rango y el número de filas.
		await audit(tx, {
			actorId: actor.profileId,
			action: "attendance.imported",
			tableName: "attendance_marks",
			newData: {
				inserted: rows.length,
				from: report.from,
				to: report.to,
				people: report.people,
			},
			metadata: {
				filename,
				rows: report.rows,
				issues: report.issues.length,
				alreadyPresent: report.alreadyPresent,
			},
			sourceIp: actor.sourceIp,
		});

		return rows.length;
	});

	// RN-19.4 — Fuera de la transacción: el recálculo lee con la conexión suelta y
	// no vería lo que aún no se ha confirmado. Es el mismo orden que la spec 13.
	const people = [
		...new Map(
			resolved.map((entry) => [
				entry.userId,
				{ id: entry.userId, departmentId: entry.departmentId },
			]),
		).values(),
	];
	const refreshed =
		report.from && report.to
			? await refreshDailyFacts(people, { from: report.from, to: report.to })
			: { facts: 0 };

	return { ...report, inserted, factsRefreshed: refreshed.facts };
}
