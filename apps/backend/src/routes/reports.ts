import { reportsSpec } from "@elineas/contracts";
import {
	createReportRunInputSchema,
	listReportRunsQuerySchema,
	monthlyReportQuerySchema,
	refreshFactsInputSchema,
	reportKpisQuerySchema,
	roleAtLeast,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "#/db";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import {
	type AuthContext,
	canManage,
	getAuth,
	requireAuth,
	requireRole,
	requireScope,
} from "#/middleware/auth";
import { audit } from "#/services/audit.ts";
import { refreshFactsForScope } from "#/services/daily-facts-store.ts";
import {
	buildDownloadLink,
	enqueueReportRun,
	listReportRuns,
	readArtifact,
	requireRun,
	retryReportRun,
} from "#/services/report-runs.ts";
import { buildMonthlyReport, getReportKpis } from "#/services/reports.ts";

/**
 * Reportería mensual (spec 16 §8). Montado en `/api/reports`.
 *
 * Todo exige al menos `department_head` y se acota a su ámbito (RN-16.3), menos
 * los KPIs y el recálculo manual, que son de `global_manager`.
 *
 * **Una corrida global sólo la pide quien alcanza toda la empresa.** Sin
 * `departmentId`, la corrida es global; el `scope` no viaja en el cuerpo, así
 * que no hay que decidir qué hacer cuando el rol y el campo se contradicen — la
 * contradicción no se puede escribir.
 */
export const reports = new Hono();

const idParam = z.object({
	id: z.uuid("El identificador de corrida no es válido."),
});

/** `"all"` para un gestor global; la lista concreta para un jefe (RN-03.2). */
const managedScope = (auth: AuthContext) => ({
	managedDepartmentIds: roleAtLeast(auth.effectiveRole, "global_manager")
		? ("all" as const)
		: auth.managedDepartmentIds,
});

/**
 * `GET /reports/artifacts/:id` — la descarga en sí.
 *
 * **Va antes del `requireAuth` del resto y no lo lleva**, a propósito: RN-16.5
 * pide un enlace firmado y temporal, y un enlace que además exija la cookie de
 * sesión no es un enlace, es la misma pantalla. Lo que autoriza aquí es la
 * firma, que sólo pudo emitirla `GET /runs/:id/download` **después** de
 * comprobar el ámbito.
 */
reports.get("/artifacts/:id", validate("param", idParam), async (c) => {
	const expires = Number(c.req.query("expires") ?? 0);
	const token = c.req.query("token") ?? "";

	const { bytes, filename } = await readArtifact(
		c.req.valid("param").id,
		expires,
		token,
	);

	return c.body(bytes as unknown as ArrayBuffer, 200, {
		"Content-Type":
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"Content-Disposition": `attachment; filename="${filename}"`,
	});
});

reports.use("*", requireAuth);
reports.use("*", requireRole("department_head"));

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

/** `GET /reports/monthly?period=&departmentId=`: los datos en JSON. */
reports.get(
	"/monthly",
	validate("query", monthlyReportQuerySchema),
	async (c) => {
		const auth = getAuth(c);
		const query = c.req.valid("query");
		if (query.departmentId) requireScope(auth, query.departmentId);

		const report = await buildMonthlyReport(managedScope(auth), query);
		return c.json(reportsSpec.monthly.response.parse(report));
	},
);

reports.get(
	"/runs",
	validate("query", listReportRunsQuerySchema),
	async (c) => {
		const runs = await listReportRuns(
			managedScope(getAuth(c)),
			c.req.valid("query"),
		);
		return c.json(reportsSpec.runs.response.parse(runs));
	},
);

reports.post(
	"/runs",
	validate("json", createReportRunInputSchema),
	async (c) => {
		const auth = getAuth(c);
		const input = c.req.valid("json");

		if (input.departmentId) {
			requireScope(auth, input.departmentId);
		} else if (!roleAtLeast(auth.effectiveRole, "global_manager")) {
			// Sin departamento la corrida es global, y eso es la empresa entera.
			throw new HTTPException(403, {
				message:
					"Sólo un gestor global puede pedir el reporte de toda la empresa. Indica tu departamento.",
			});
		}

		const run = await enqueueReportRun(input, actorOf(c));
		return c.json(reportsSpec.enqueue.response.parse(run), 201);
	},
);

/** El ámbito de una corrida: el departamento por el que se pidió. */
async function requireRunScope(c: Context, id: string) {
	const auth = getAuth(c);
	const run = await requireRun(id);

	if (run.departmentId === null) {
		if (!roleAtLeast(auth.effectiveRole, "global_manager")) {
			throw new HTTPException(403, {
				message: "Esa corrida es de toda la empresa.",
			});
		}
	} else if (!canManage(auth, run.departmentId)) {
		throw new HTTPException(403, {
			message: "Esa corrida está fuera de tu ámbito.",
		});
	}

	return run;
}

/** `GET /reports/runs/:id/download` (RN-16.5): el enlace, no el archivo. */
reports.get("/runs/:id/download", validate("param", idParam), async (c) => {
	const run = await requireRunScope(c, c.req.valid("param").id);

	if (run.status !== "completed" || !run.artifactPath) {
		throw new HTTPException(409, {
			message: "Esa corrida todavía no tiene un archivo que descargar.",
		});
	}

	return c.json(reportsSpec.download.response.parse(buildDownloadLink(run)));
});

/** `POST /reports/runs/:id/retry` (RN-16.4): crea una fila nueva. */
reports.post("/runs/:id/retry", validate("param", idParam), async (c) => {
	const run = await requireRunScope(c, c.req.valid("param").id);
	const retried = await retryReportRun(run.id, actorOf(c));
	return c.json(reportsSpec.retry.response.parse(retried), 201);
});

/** `GET /reports/kpis` (§6): de la reportería entera, sólo para un gestor global. */
reports.get(
	"/kpis",
	requireRole("global_manager"),
	validate("query", reportKpisQuerySchema),
	async (c) => {
		const kpis = await getReportKpis(c.req.valid("query").windowDays);
		return c.json(reportsSpec.kpis.response.parse(kpis));
	},
);

/**
 * `POST /attendance/facts/refresh` (RN-16.9), montado aparte en `app.ts`.
 *
 * Es la herramienta para lo que la invalidación automática no puede alcanzar:
 * un cambio en los días de un grupo de descanso alcanza al pasado de sus
 * miembros (spec 10 §9, decisión 5) y ese pasado no tiene principio, así que no
 * hay un rango que refrescar solo.
 */
export const attendanceFacts = new Hono();

attendanceFacts.use("*", requireAuth);
attendanceFacts.use("*", requireRole("global_manager"));

attendanceFacts.post(
	"/refresh",
	validate("json", refreshFactsInputSchema),
	async (c) => {
		const range = c.req.valid("json");
		const result = await refreshFactsForScope(
			{ managedDepartmentIds: "all" },
			range,
		);

		await db.transaction(async (tx) => {
			await audit(tx, {
				actorId: getAuth(c).profile.id,
				action: "attendance_facts.refreshed",
				tableName: "attendance_daily_facts",
				newData: { ...range, facts: result.facts },
				sourceIp: clientIp(c),
			});
		});

		return c.json(
			reportsSpec.refreshFacts.response.parse({
				...range,
				facts: result.facts,
				ruleVersion: result.ruleVersion,
			}),
		);
	},
);
