import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type CreateReportRunInput,
	type ListReportRunsQuery,
	type ReportDownload,
	type ReportRun,
	type ReportRunStatus,
	reportRunStatusSchema,
	reportScopeSchema,
} from "@elineas/validations";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "#/db";
import { departments, reportRuns } from "#/db/schema";
import { config } from "#/lib/config.ts";
import { type Actor, audit } from "#/services/audit.ts";
import { notify } from "#/services/notifications.ts";
import { reportToXlsx } from "#/services/xlsx.ts";
import {
	buildMonthlyReport,
	periodRange,
	type Scope,
} from "#/services/reports.ts";
import { currentRuleVersion } from "#/services/rule-versions.ts";

/**
 * Generación asíncrona del reporte mensual (spec 16 §3).
 *
 * *"Un reporte mensual de toda la empresa no se genera en una petición HTTP"*,
 * dice la spec, y esa decisión se mantiene: encolar responde de inmediato y el
 * trabajo lo hace `processQueuedRuns`, que arranca `index.ts` con un
 * temporizador — **no `app.ts`**, para que las pruebas controlen cuándo corre en
 * vez de pelearse con un proceso de fondo.
 *
 * Las cuatro reglas del §3, y dónde vive cada una:
 *
 * - **RN-16.4 — reintentar crea una fila nueva.** `retryRun` inserta; nunca
 *   toca la corrida fallida. El historial de corridas es un registro.
 * - **RN-16.7 — sin corridas duplicadas**, en la base: el índice único parcial
 *   sobre (scope, departamento, periodo) donde el estado está activo. Dos
 *   peticiones simultáneas no se detectan comprobando antes de insertar, que es
 *   justo lo que el criterio de aceptación pide demostrar.
 * - **RN-16.8 — tiempo límite.** `failStaleRuns` corre antes de tomar trabajo:
 *   una corrida colgada bloquearía RN-16.7 para siempre.
 * - **RN-16.5 — descarga por enlace firmado y temporal.** El artefacto vive
 *   fuera del alcance del servidor web y el enlace lleva su caducidad dentro de
 *   la firma.
 */

const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
/** El "bucket" del legacy, conservado como etiqueta del sitio donde vive. */
const BUCKET = "monthly-reports";

type RunRow = typeof reportRuns.$inferSelect;

const toStatus = (value: string): ReportRunStatus =>
	reportRunStatusSchema.catch("failed").parse(value);

function toRun(
	row: RunRow,
	departmentName: string | null,
	version: number,
): ReportRun {
	return {
		id: row.id,
		scope: reportScopeSchema.catch("global").parse(row.scope),
		departmentId: row.departmentId,
		departmentName,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		status: toStatus(row.status),
		requestedBy: row.requestedBy,
		rowCount: row.rowCount,
		durationMs: row.durationMs,
		errorMessage: row.errorMessage,
		retryCount: row.retryCount,
		ruleVersion: version,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function selectRuns(where: ReturnType<typeof and>, limit = 100) {
	const rows = await db
		.select({
			run: reportRuns,
			departmentName: departments.name,
			version: sql<number>`(select version from attendance_rule_versions v where v.id = ${reportRuns.ruleVersionId})`,
		})
		.from(reportRuns)
		.leftJoin(departments, eq(departments.id, reportRuns.departmentId))
		.where(where)
		.orderBy(desc(reportRuns.createdAt))
		.limit(limit);

	return rows.map((row) => toRun(row.run, row.departmentName, row.version));
}

/** El ámbito, como condición SQL: `undefined` para quien alcanza todo. */
function scopeCondition(scope: Scope) {
	if (scope.managedDepartmentIds === "all") return undefined;
	if (scope.managedDepartmentIds.length === 0) {
		// Sin ámbito no hay corridas que ver. La condición imposible es más simple
		// que devolver antes y repetir la comprobación en cada consumidor.
		return sql`false`;
	}
	return inArray(reportRuns.departmentId, scope.managedDepartmentIds);
}

// ── Encolar ───────────────────────────────────────────────────────────────────

/**
 * `POST /reports/runs`.
 *
 * El **ámbito de la corrida no lo elige el cliente**: el cuerpo sólo trae el
 * periodo y, opcionalmente, el departamento. Sin departamento la corrida es
 * global, y quién puede pedir una global lo decide la ruta con el rol — no un
 * campo `scope` que habría que validar contra el rol de todas formas.
 */
export async function enqueueReportRun(
	input: CreateReportRunInput,
	actor: Actor,
): Promise<ReportRun> {
	const range = periodRange(input.period);
	const version = await currentRuleVersion();

	const [row] = await db
		.insert(reportRuns)
		.values({
			scope: input.departmentId ? "department" : "global",
			departmentId: input.departmentId ?? null,
			periodStart: range.from,
			periodEnd: range.to,
			status: "queued",
			requestedBy: actor.profileId,
			ruleVersionId: version.id,
		})
		// RN-16.7 en la base: si ya hay una activa para ese reporte, ésta no entra.
		.onConflictDoNothing()
		.returning();

	if (!row) {
		throw new HTTPException(409, {
			message:
				"Ya hay una corrida de ese reporte en cola o en curso. Espera a que termine.",
		});
	}

	await db.transaction(async (tx) => {
		await audit(tx, {
			actorId: actor.profileId,
			action: "report_run.enqueued",
			tableName: "report_runs",
			recordId: row.id,
			newData: {
				scope: row.scope,
				departmentId: row.departmentId,
				period: input.period,
			},
			sourceIp: actor.sourceIp,
		});
	});

	const [created] = await selectRuns(eq(reportRuns.id, row.id));
	if (!created) {
		throw new HTTPException(500, { message: "La corrida no se pudo leer." });
	}
	return created;
}

/**
 * RN-16.4 — Reintentar **crea una fila nueva** y conserva la anterior, con
 * `retry_count` incrementado para poder seguir la cadena.
 */
export async function retryReportRun(
	id: string,
	actor: Actor,
): Promise<ReportRun> {
	const failed = await requireRun(id);

	if (failed.status !== "failed") {
		throw new HTTPException(409, {
			message: "Sólo se reintenta una corrida que falló.",
		});
	}

	const version = await currentRuleVersion();
	const [row] = await db
		.insert(reportRuns)
		.values({
			scope: failed.scope,
			departmentId: failed.departmentId,
			periodStart: failed.periodStart,
			periodEnd: failed.periodEnd,
			status: "queued",
			requestedBy: actor.profileId,
			retryCount: failed.retryCount + 1,
			ruleVersionId: version.id,
		})
		.onConflictDoNothing()
		.returning();

	if (!row) {
		throw new HTTPException(409, {
			message: "Ya hay una corrida de ese reporte en cola o en curso.",
		});
	}

	const [created] = await selectRuns(eq(reportRuns.id, row.id));
	if (!created) {
		throw new HTTPException(500, { message: "La corrida no se pudo leer." });
	}
	return created;
}

// ── El trabajador ─────────────────────────────────────────────────────────────

/**
 * RN-16.8 — Las corridas colgadas pasan a `failed` antes de tomar trabajo
 * nuevo. Se hace aquí y no en un proceso aparte porque el momento en que
 * importa es exactamente éste: si no, la siguiente petición de ese mismo
 * reporte chocaría contra el índice de RN-16.7 y nadie podría desbloquearlo.
 */
export async function failStaleRuns(): Promise<number> {
	const deadline = new Date(Date.now() - config.reportRunTimeoutMs);
	const rows = await db
		.update(reportRuns)
		.set({
			status: "failed",
			errorMessage: `La corrida superó el tiempo límite de ${Math.round(config.reportRunTimeoutMs / 60_000)} minutos.`,
			updatedAt: new Date(),
		})
		.where(
			and(eq(reportRuns.status, "running"), lt(reportRuns.startedAt, deadline)),
		)
		.returning({ id: reportRuns.id });

	return rows.length;
}

/**
 * Toma las corridas encoladas y las ejecuta, de una en una.
 *
 * El paso a `running` va con el estado en el `WHERE`: dos trabajadores —dos
 * procesos, o el temporizador y una prueba— no pueden quedarse con la misma.
 */
export async function processQueuedRuns(): Promise<number> {
	await failStaleRuns();

	let done = 0;
	for (;;) {
		const [claimed] = await db
			.update(reportRuns)
			.set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
			.where(
				eq(
					reportRuns.id,
					sql`(select id from report_runs where status = 'queued' order by created_at limit 1 for update skip locked)`,
				),
			)
			.returning();

		if (!claimed) return done;
		await executeRun(claimed);
		done += 1;
	}
}

/** Dónde queda el archivo de una corrida. Un directorio por periodo. */
const artifactPathOf = (run: RunRow) =>
	join(run.periodStart.slice(0, 7), `${run.id}.xlsx`);

async function executeRun(run: RunRow): Promise<void> {
	const started = Date.now();

	try {
		const report = await buildMonthlyReport(
			run.departmentId
				? { managedDepartmentIds: [run.departmentId] }
				: { managedDepartmentIds: "all" },
			{
				period: run.periodStart.slice(0, 7),
				departmentId: run.departmentId ?? undefined,
			},
		);

		const bytes = await reportToXlsx(report);
		const relative = artifactPathOf(run);
		const absolute = resolve(config.reportsDir, relative);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, bytes);

		const checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

		await db.transaction(async (tx) => {
			await tx
				.update(reportRuns)
				.set({
					status: "completed",
					artifactBucket: BUCKET,
					artifactPath: relative,
					checksum,
					rowCount: report.rows.length,
					durationMs: Date.now() - started,
					updatedAt: new Date(),
				})
				.where(eq(reportRuns.id, run.id));

			await audit(tx, {
				actorId: null,
				action: "report_run.completed",
				tableName: "report_runs",
				recordId: run.id,
				newData: { rowCount: report.rows.length, checksum },
			});

			// RN-16.6 — Avisar al terminar, para no tener que quedarse mirando.
			await notify(tx, [run.requestedBy], {
				type: "report_run.finished",
				title: "Tu reporte mensual está listo",
				body: `Periodo ${run.periodStart.slice(0, 7)}, ${report.rows.length} ${report.rows.length === 1 ? "empleado" : "empleados"}.`,
				actionUrl: "/reports",
				dedupeKey: `report_run:${run.id}`,
			});
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Error desconocido.";

		await db.transaction(async (tx) => {
			await tx
				.update(reportRuns)
				.set({
					status: "failed",
					errorMessage: message.slice(0, 500),
					durationMs: Date.now() - started,
					updatedAt: new Date(),
				})
				.where(eq(reportRuns.id, run.id));

			await audit(tx, {
				actorId: null,
				action: "report_run.failed",
				tableName: "report_runs",
				recordId: run.id,
				newData: { error: message.slice(0, 500) },
			});

			await notify(tx, [run.requestedBy], {
				type: "report_run.finished",
				title: "Tu reporte mensual falló",
				body: `Periodo ${run.periodStart.slice(0, 7)}. Puedes reintentarlo.`,
				actionUrl: "/reports",
				dedupeKey: `report_run:${run.id}`,
			});
		});
	}
}

// ── Leer y descargar ──────────────────────────────────────────────────────────

export async function requireRun(id: string): Promise<RunRow> {
	const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, id));
	if (!row) {
		throw new HTTPException(404, { message: "Esa corrida no existe." });
	}
	return row;
}

export async function listReportRuns(
	scope: Scope,
	query: ListReportRunsQuery,
): Promise<ReportRun[]> {
	const conditions = [scopeCondition(scope)];
	if (query.status) conditions.push(eq(reportRuns.status, query.status));
	return selectRuns(and(...conditions.filter(Boolean)), query.limit);
}

/**
 * RN-16.5 — El enlace: temporal y no adivinable.
 *
 * El token es un HMAC del identificador **y su caducidad**; si se cambia la
 * fecha, la firma deja de casar. No hace falta guardar nada: el enlace se valida
 * solo, y no hay una tabla de tokens que limpiar ni que se pueda leer.
 */
function sign(id: string, expiresAt: number): string {
	return createHmac("sha256", config.reportDownloadSecret)
		.update(`${id}.${expiresAt}`)
		.digest("hex");
}

export function buildDownloadLink(run: RunRow): ReportDownload {
	const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
	const token = sign(run.id, expiresAt);
	const period = run.periodStart.slice(0, 7);

	return {
		url: `/api/reports/artifacts/${run.id}?expires=${expiresAt}&token=${token}`,
		expiresAt: new Date(expiresAt).toISOString(),
		filename: `asistencia-${period}${run.departmentId ? "-departamento" : ""}.xlsx`,
	};
}

export async function readArtifact(
	id: string,
	expires: number,
	token: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
	const expected = sign(id, expires);
	const provided = Buffer.from(token, "hex");
	const wanted = Buffer.from(expected, "hex");

	// Comparación en tiempo constante: comparar firmas con `===` filtra por
	// cuánto tarda en fallar.
	const valid =
		provided.length === wanted.length && timingSafeEqual(provided, wanted);

	if (!valid || Date.now() > expires) {
		throw new HTTPException(403, {
			message: "Ese enlace de descarga ya no es válido. Pide uno nuevo.",
		});
	}

	const run = await requireRun(id);
	if (!run.artifactPath) {
		throw new HTTPException(404, {
			message: "Esa corrida no tiene archivo.",
		});
	}

	return {
		bytes: await readFile(resolve(config.reportsDir, run.artifactPath)),
		filename: buildDownloadLink(run).filename,
	};
}
