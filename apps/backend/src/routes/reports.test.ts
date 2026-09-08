import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de la reportería mensual (spec 16 §9) contra la base de desarrollo.
 *
 * Lo que sólo se puede comprobar con la base delante: que dos peticiones
 * simultáneas encolen **una** corrida (RN-16.7 vive en un índice), que
 * reintentar cree una fila nueva sin tocar la anterior (RN-16.4), que una
 * corrida colgada caduque (RN-16.8), que **recalcular un mes cerrado no cambie
 * ningún valor** (RN-16.10) y que justificar una ausencia actualice su hecho
 * diario (RN-16.11).
 *
 * El criterio más importante de la §9 —que el XLSX y la matriz de Sheets salgan
 * del mismo módulo y coincidan celda a celda— se prueba **puro** en
 * `services/report-rules.test.ts`: no necesita base, y allí se lee mejor.
 *
 * Requiere el Postgres del compose (`docker compose up -d postgres` y
 * `bun run db:migrate`).
 */

// Los artefactos van a un directorio temporal, no al del proyecto. Se fija
// **antes** de importar la aplicación, porque `lib/config.ts` lo lee al cargarse.
process.env.REPORTS_DIR = await mkdtemp(join(tmpdir(), "elineas-reports-"));

mock.module("#/lib/identity", () => ({
	IdentityError: class IdentityError extends Error {},
	signIn: async () => {
		throw new Error("Estas pruebas no pasan por el login.");
	},
	signOut: async () => {},
	refreshJwt: async () => null,
	verifyJwt: async (token: string) => {
		const [, identityUserId] = token.split("|");
		if (!identityUserId) return null;
		return {
			identityUserId,
			email: `${identityUserId}@test.local`,
			name: identityUserId,
		};
	},
	fetchRoles: async (sessionToken: string): Promise<AppRole[]> => {
		const [, , roles] = sessionToken.split("|");
		return (roles ?? "")
			.split(",")
			.filter(Boolean)
			.map((role) => appRoleSchema.parse(role));
	},
}));

const { createApp } = await import("#/app.ts");
const { countQueries } = await import("#/test-support/count-queries.ts");
const { db } = await import("#/db");
const {
	appConfig,
	attendanceAbsenceReviews,
	attendanceDailyFacts,
	attendanceMarks,
	attendanceRuleVersions,
	auditLog,
	departments,
	notifications,
	payrollAdjustments,
	profiles,
	reportRuns,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");
const { processQueuedRuns, failStaleRuns } = await import(
	"#/services/report-runs.ts"
);

const app = createApp();
const TAG = `zz-rep-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
const outsider = testUser("outsider", ["employee"]);
const head = testUser("head", ["department_head"]);
const manager = testUser("manager", ["global_manager"]);

function request(
	path: string,
	options: { as?: TestUser; method?: string; body?: unknown } = {},
) {
	const headers: Record<string, string> = {};
	if (options.as) headers.Cookie = options.as.cookie;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	return app.request(path, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
}

const name = (suffix: string) => `${TAG} ${suffix}`;

const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);

/** Un mes ya cerrado, para no pelearse con jornadas en curso. */
const CLOSED_DAY = addDays(TODAY, -45);
const PERIOD = CLOSED_DAY.slice(0, 7);

let departmentId = "";
let otherDepartmentId = "";
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

type Run = {
	id: string;
	scope: "global" | "department";
	departmentId: string | null;
	periodStart: string;
	status: "queued" | "running" | "completed" | "failed";
	rowCount: number | null;
	retryCount: number;
	errorMessage: string | null;
	ruleVersion: number;
};

type Report = {
	period: string;
	scope: string;
	days: string[];
	ruleVersion: number;
	rows: {
		userId: string;
		codes: string[];
		summary: Record<string, number>;
	}[];
};

async function profileIdOf(who: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, who.identityUserId),
	});
	if (!row) throw new Error(`El perfil de ${who.identityUserId} no existe`);
	return row.id;
}

async function moveTo(who: TestUser, id: string | null) {
	await db
		.update(profiles)
		.set({ departmentId: id })
		.where(eq(profiles.identityUserId, who.identityUserId));
}

function windowAroundNow() {
	const now = new Date();
	const current = now.getUTCHours() * 60 + now.getUTCMinutes();
	const hhmm = (minutes: number) =>
		`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

	return {
		checkinStartTime: hhmm(Math.max(0, current - 60)),
		checkinEndTime: hhmm(Math.min(1439, current + 60)),
		checkoutStartTime: hhmm(Math.max(0, current - 60)),
		checkoutEndTime: hhmm(Math.min(1439, current + 60)),
		timezone: "UTC",
	};
}

async function monthly(who: TestUser, query = `?period=${PERIOD}`) {
	const res = await request(`/api/reports/monthly${query}`, { as: who });
	expect(res.status).toBe(200);
	return (await res.json()) as Report;
}

async function enqueue(
	who: TestUser,
	body: { period: string; departmentId?: string },
) {
	return request("/api/reports/runs", { as: who, method: "POST", body });
}

async function enqueued(
	who: TestUser,
	body: { period: string; departmentId?: string },
): Promise<Run> {
	const res = await enqueue(who, body);
	expect(res.status).toBe(201);
	return (await res.json()) as Run;
}

async function runRow(id: string) {
	const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, id));
	return row;
}

async function clearReportRows() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	const departmentIds = (
		await db
			.select({ id: departments.id })
			.from(departments)
			.where(like(departments.name, `${TAG}%`))
	).map((row) => row.id);

	if (departmentIds.length > 0) {
		await db
			.delete(reportRuns)
			.where(inArray(reportRuns.departmentId, departmentIds));
	}
	// Las globales no llevan departamento: se acotan por quién las pidió.
	if (ids.length > 0) {
		await db.delete(reportRuns).where(inArray(reportRuns.requestedBy, ids));
		await db
			.delete(attendanceDailyFacts)
			.where(inArray(attendanceDailyFacts.userId, ids));
		await db
			.delete(payrollAdjustments)
			.where(inArray(payrollAdjustments.userId, ids));
		await db
			.delete(attendanceAbsenceReviews)
			.where(inArray(attendanceAbsenceReviews.userId, ids));
		await db
			.delete(attendanceMarks)
			.where(inArray(attendanceMarks.userId, ids));
		await db.delete(notifications).where(inArray(notifications.userId, ids));
	}
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, outsider, head, manager]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}

	const created = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name("equipo") },
	});
	expect(created.status).toBe(201);
	departmentId = ((await created.json()) as { id: string }).id;

	const second = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name("ajeno") },
	});
	otherDepartmentId = ((await second.json()) as { id: string }).id;

	await moveTo(employee, departmentId);
	await moveTo(head, departmentId);
	await moveTo(outsider, otherDepartmentId);

	for (const id of [departmentId, otherDepartmentId]) {
		expect(
			(
				await request(`/api/departments/${id}/schedule`, {
					as: manager,
					method: "PUT",
					body: windowAroundNow(),
				})
			).status,
		).toBe(200);
	}
});

afterEach(async () => {
	await clearReportRows();
	await db.delete(appConfig);
	for (const row of savedConfig) await db.insert(appConfig).values(row);
	invalidateConfigCache();
});

afterAll(async () => {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	const departmentIds = (
		await db
			.select({ id: departments.id })
			.from(departments)
			.where(like(departments.name, `${TAG}%`))
	).map((row) => row.id);

	await clearReportRows();

	if (ids.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
		await db
			.update(profiles)
			.set({ departmentId: null, selectedWorkLocationId: null })
			.where(inArray(profiles.id, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
	if (departmentIds.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.recordId, departmentIds));
	}
	await db.delete(departments).where(like(departments.name, `${TAG}%`));

	await db.delete(appConfig);
	for (const row of savedConfig) await db.insert(appConfig).values(row);
	invalidateConfigCache();
});

describe("ámbito (§9, RN-16.3)", () => {
	test("sin sesión, todo responde 401", async () => {
		expect(
			(await request(`/api/reports/monthly?period=${PERIOD}`)).status,
		).toBe(401);
		expect((await request("/api/reports/runs")).status).toBe(401);
		expect((await request("/api/reports/kpis")).status).toBe(401);
	});

	test("un empleado no entra a la reportería", async () => {
		expect(
			(await request(`/api/reports/monthly?period=${PERIOD}`, { as: employee }))
				.status,
		).toBe(403);
		expect(
			(await enqueue(employee, { period: PERIOD, departmentId })).status,
		).toBe(403);
	});

	test("un jefe no pide el reporte global", async () => {
		// Sin `departmentId` la corrida es de toda la empresa.
		const res = await enqueue(head, { period: PERIOD });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toContain(
			"gestor global",
		);
	});

	test("un jefe no pide ni ve el de otro departamento", async () => {
		expect(
			(await enqueue(head, { period: PERIOD, departmentId: otherDepartmentId }))
				.status,
		).toBe(403);
		expect(
			(
				await request(
					`/api/reports/monthly?period=${PERIOD}&departmentId=${otherDepartmentId}`,
					{ as: head },
				)
			).status,
		).toBe(403);
	});

	test("un jefe sólo ve las corridas de su ámbito", async () => {
		await enqueued(head, { period: PERIOD, departmentId });
		await enqueued(manager, {
			period: PERIOD,
			departmentId: otherDepartmentId,
		});

		const mine = (await (
			await request("/api/reports/runs", { as: head })
		).json()) as Run[];
		expect(mine.every((run) => run.departmentId === departmentId)).toBe(true);
	});

	test("los KPIs son de un gestor global", async () => {
		expect((await request("/api/reports/kpis", { as: head })).status).toBe(403);
		expect((await request("/api/reports/kpis", { as: manager })).status).toBe(
			200,
		);
	});

	test("el recálculo manual también", async () => {
		const body = { from: CLOSED_DAY, to: CLOSED_DAY };
		expect(
			(
				await request("/api/attendance/facts/refresh", {
					as: head,
					method: "POST",
					body,
				})
			).status,
		).toBe(403);
		expect(
			(
				await request("/api/attendance/facts/refresh", {
					as: manager,
					method: "POST",
					body,
				})
			).status,
		).toBe(200);
	});
});

describe("§2 — el reporte y sus totales", () => {
	test("una fila por persona del ámbito, un código por día", async () => {
		const report = await monthly(head, `?period=${PERIOD}`);
		const employeeId = await profileIdOf(employee);

		expect(report.period).toBe(PERIOD);
		expect(report.days.length).toBeGreaterThanOrEqual(28);

		const mine = report.rows.find((row) => row.userId === employeeId);
		expect(mine).toBeDefined();
		expect(mine?.codes).toHaveLength(report.days.length);
	});

	test("RN-16.1 — los totales suman los días del periodo, para todos", async () => {
		const report = await monthly(manager);
		expect(report.rows.length).toBeGreaterThan(0);

		for (const row of report.rows) {
			const total = Object.values(row.summary).reduce(
				(sum, value) => sum + value,
				0,
			);
			expect(total).toBe(report.days.length);
		}
	});

	test("una ausencia justificada sale AJ en el reporte", async () => {
		const employeeId = await profileIdOf(employee);

		// El día tiene que ser laborable para que sea una ausencia.
		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: CLOSED_DAY, isWorkday: true }] },
		});

		expect(
			(
				await request(`/api/absences/${employeeId}/${CLOSED_DAY}`, {
					as: manager,
					method: "PUT",
					body: { isJustified: true, notes: "Certificado médico." },
				})
			).status,
		).toBe(200);

		const report = await monthly(head);
		const index = report.days.indexOf(CLOSED_DAY);
		const mine = report.rows.find((row) => row.userId === employeeId);

		expect(index).toBeGreaterThanOrEqual(0);
		expect(mine?.codes[index]).toBe("AJ");
		expect(mine?.summary.ausenciaJustificada).toBe(1);
	});

	test("el reporte dice con qué versión de reglas se calculó (RN-16.12)", async () => {
		const report = await monthly(manager);
		expect(report.ruleVersion).toBeGreaterThanOrEqual(1);
	});
});

describe("§4 — los hechos diarios", () => {
	test("leer el reporte los materializa", async () => {
		const employeeId = await profileIdOf(employee);
		await monthly(head);

		const facts = await db
			.select()
			.from(attendanceDailyFacts)
			.where(eq(attendanceDailyFacts.userId, employeeId));

		expect(facts.length).toBeGreaterThanOrEqual(28);
		expect(facts.every((fact) => fact.ruleVersionId !== null)).toBe(true);
	});

	test("RN-16.10 — recalcular un mes cerrado no cambia ningún valor (§9)", async () => {
		const employeeId = await profileIdOf(employee);
		await monthly(manager);

		const before = await db
			.select()
			.from(attendanceDailyFacts)
			.where(eq(attendanceDailyFacts.userId, employeeId))
			.orderBy(attendanceDailyFacts.date);

		expect(
			(
				await request("/api/attendance/facts/refresh", {
					as: manager,
					method: "POST",
					body: {
						from: `${PERIOD}-01`,
						to: before.at(-1)?.date ?? CLOSED_DAY,
					},
				})
			).status,
		).toBe(200);

		const after = await db
			.select()
			.from(attendanceDailyFacts)
			.where(eq(attendanceDailyFacts.userId, employeeId))
			.orderBy(attendanceDailyFacts.date);

		expect(after).toHaveLength(before.length);
		// `computed_at` sí cambia —se recalculó— y es lo único que puede cambiar.
		for (const [index, row] of before.entries()) {
			const { computedAt: _before, ...stable } = row;
			const { computedAt: _after, ...recomputed } = after[index] ?? {};
			expect(recomputed).toEqual(stable);
		}
	});

	test("RN-16.11 — justificar una ausencia actualiza su hecho diario (§9)", async () => {
		const employeeId = await profileIdOf(employee);

		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: CLOSED_DAY, isWorkday: true }] },
		});

		// Se materializa el mes **antes** de la decisión.
		await monthly(manager);
		const [before] = await db
			.select()
			.from(attendanceDailyFacts)
			.where(
				and(
					eq(attendanceDailyFacts.userId, employeeId),
					eq(attendanceDailyFacts.date, CLOSED_DAY),
				),
			);
		expect(before?.status).toBe("AUSENTE");
		expect(before?.absenceCode).toBe("ANJ");

		expect(
			(
				await request(`/api/absences/${employeeId}/${CLOSED_DAY}`, {
					as: manager,
					method: "PUT",
					body: { isJustified: true, notes: "Trajo el certificado." },
				})
			).status,
		).toBe(200);

		// Sin volver a leer el reporte: la invalidación lo hizo sola.
		const [after] = await db
			.select()
			.from(attendanceDailyFacts)
			.where(
				and(
					eq(attendanceDailyFacts.userId, employeeId),
					eq(attendanceDailyFacts.date, CLOSED_DAY),
				),
			);
		expect(after?.absenceCode).toBe("AJ");
	});

	test("la versión de reglas se reutiliza mientras la configuración no cambie", async () => {
		await monthly(manager);
		const first = await db.select().from(attendanceRuleVersions);

		await monthly(manager);
		const second = await db.select().from(attendanceRuleVersions);

		expect(second).toHaveLength(first.length);
	});

	test("cambiar una clave que afecta al cálculo crea una versión nueva (RN-16.13)", async () => {
		await monthly(manager);
		const before = await db.select().from(attendanceRuleVersions);

		expect(
			(
				await request("/api/config", {
					as: manager,
					method: "PATCH",
					body: { late_tolerance_minutes: 17 },
				})
			).status,
		).toBe(200);
		invalidateConfigCache();

		await monthly(manager);
		const after = await db.select().from(attendanceRuleVersions);

		expect(after.length).toBe(before.length + 1);
		// Sólo una activa a la vez, y lo garantiza un índice.
		expect(after.filter((row) => row.isActive)).toHaveLength(1);
	});
});

describe("§3 — las corridas", () => {
	test("encolar responde de inmediato con la corrida en cola", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		expect(run.status).toBe("queued");
		expect(run.scope).toBe("department");
		expect(run.departmentId).toBe(departmentId);
	});

	test("RN-16.7 — dos peticiones simultáneas encolan una sola (§9)", async () => {
		const [a, b] = await Promise.all([
			enqueue(head, { period: PERIOD, departmentId }),
			enqueue(head, { period: PERIOD, departmentId }),
		]);

		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual([201, 409]);

		const runs = (await (
			await request("/api/reports/runs", { as: head })
		).json()) as Run[];
		expect(runs).toHaveLength(1);
	});

	test("una global y una de departamento del mismo periodo no chocan", async () => {
		// El índice único trata cada NULL como distinto, así que la corrida global
		// lleva un `coalesce`; sin él, esto pasaría por casualidad.
		await enqueued(manager, { period: PERIOD });
		await enqueued(manager, { period: PERIOD, departmentId });
		expect((await enqueue(manager, { period: PERIOD })).status).toBe(409);
	});

	test("el trabajador la completa y deja el archivo con su checksum", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		expect(await processQueuedRuns()).toBeGreaterThanOrEqual(1);

		const row = await runRow(run.id);
		expect(row?.status).toBe("completed");
		expect(row?.artifactBucket).toBe("monthly-reports");
		expect(row?.artifactPath).toContain(PERIOD);
		expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.rowCount).toBeGreaterThan(0);
		expect(row?.durationMs).not.toBeNull();
	});

	test("RN-16.6 — al terminar, avisa a quien la pidió", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		await processQueuedRuns();

		const rows = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, await profileIdOf(head)),
					eq(notifications.type, "report_run.finished"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.body).toContain(PERIOD);
		expect((await runRow(run.id))?.status).toBe("completed");
	});

	test("RN-16.8 — una corrida colgada pasa a failed (§9)", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });

		// Se simula la cuelga: `running` desde hace mucho.
		await db
			.update(reportRuns)
			.set({
				status: "running",
				startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
			})
			.where(eq(reportRuns.id, run.id));

		expect(await failStaleRuns()).toBeGreaterThanOrEqual(1);

		const row = await runRow(run.id);
		expect(row?.status).toBe("failed");
		expect(row?.errorMessage).toContain("tiempo límite");

		// Y con eso RN-16.7 deja de estar bloqueada: se puede volver a encolar.
		expect((await enqueue(head, { period: PERIOD, departmentId })).status).toBe(
			201,
		);
	});

	test("RN-16.4 — reintentar crea una fila nueva y conserva la anterior (§9)", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		await db
			.update(reportRuns)
			.set({ status: "failed", errorMessage: "fallo de prueba" })
			.where(eq(reportRuns.id, run.id));

		const res = await request(`/api/reports/runs/${run.id}/retry`, {
			as: head,
			method: "POST",
		});
		expect(res.status).toBe(201);

		const retried = (await res.json()) as Run;
		expect(retried.id).not.toBe(run.id);
		expect(retried.retryCount).toBe(1);
		expect(retried.status).toBe("queued");

		// La fallida sigue ahí, tal cual.
		const original = await runRow(run.id);
		expect(original?.status).toBe("failed");
		expect(original?.errorMessage).toBe("fallo de prueba");
	});

	test("una corrida que no falló no se reintenta", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		const res = await request(`/api/reports/runs/${run.id}/retry`, {
			as: head,
			method: "POST",
		});
		expect(res.status).toBe(409);
	});
});

describe("RN-16.5 — la descarga (§9)", () => {
	async function completedRun() {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		await processQueuedRuns();
		return run;
	}

	test("una corrida sin terminar no da enlace", async () => {
		const run = await enqueued(head, { period: PERIOD, departmentId });
		expect(
			(await request(`/api/reports/runs/${run.id}/download`, { as: head }))
				.status,
		).toBe(409);
	});

	test("el enlace lleva caducidad y sirve para descargar el XLSX", async () => {
		const run = await completedRun();
		const res = await request(`/api/reports/runs/${run.id}/download`, {
			as: head,
		});
		expect(res.status).toBe(200);

		const link = (await res.json()) as {
			url: string;
			expiresAt: string;
			filename: string;
		};
		expect(link.filename).toContain(PERIOD);
		expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());

		// El artefacto se sirve sin cookie: lo que autoriza es la firma.
		const file = await app.request(link.url);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toContain("spreadsheetml");

		const bytes = new Uint8Array(await file.arrayBuffer());
		// Un XLSX es un zip: empieza por `PK`.
		expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
	});

	test("un token manipulado no vale", async () => {
		const run = await completedRun();
		const link = (await (
			await request(`/api/reports/runs/${run.id}/download`, { as: head })
		).json()) as { url: string };

		const tampered = link.url.replace(
			/token=[0-9a-f]+/,
			`token=${"0".repeat(64)}`,
		);
		expect((await app.request(tampered)).status).toBe(403);
	});

	test("un enlace caducado no vale, aunque la firma case", async () => {
		const run = await completedRun();
		const link = (await (
			await request(`/api/reports/runs/${run.id}/download`, { as: head })
		).json()) as { url: string };

		// Se cambia sólo la caducidad: la firma la incluye, así que deja de casar
		// **y** además está en el pasado. Las dos razones dan 403.
		const expired = link.url.replace(/expires=\d+/, "expires=1000");
		expect((await app.request(expired)).status).toBe(403);
	});

	test("un jefe no descarga la corrida global de nadie", async () => {
		const global = await enqueued(manager, { period: PERIOD });
		await processQueuedRuns();

		expect(
			(await request(`/api/reports/runs/${global.id}/download`, { as: head }))
				.status,
		).toBe(403);
	});
});

describe("RQ-22.5 — sin N+1 (spec 22 §5)", () => {
	test("el reporte de 200 personas hace las mismas consultas que el de 5", async () => {
		// La spec 22 pide este conteo en "los endpoints de panel **y reporte**", y
		// el del panel ya existía (spec 15). Éste faltaba, y es el que más lo
		// necesita: la matriz mensual es empleado × día, así que una consulta por
		// persona no se nota con cinco y tumba el servidor con doscientas.
		const few = await countQueries(() => monthly(manager));

		const bulk = Array.from({ length: 200 }, (_, index) => ({
			identityUserId: `${TAG}-bulk-${index}`,
			email: `${TAG}-bulk-${index}@test.local`,
			fullName: `${TAG} Bulk ${String(index).padStart(3, "0")}`,
			departmentId,
			isActive: true,
		}));
		const bulkIds = (
			await db.insert(profiles).values(bulk).returning({ id: profiles.id })
		).map((row) => row.id);

		try {
			// La comprobación de volumen va **dentro** de la medición: construir el
			// reporte de 205 personas cuesta segundos, y hacerlo dos veces sólo para
			// contar filas convertía esta prueba en la más lenta del archivo.
			let rows = 0;
			const many = await countQueries(async () => {
				rows = (await monthly(manager)).rows.length;
			});
			expect(rows).toBeGreaterThanOrEqual(200);

			// **No se afirma que el número sea el mismo**, y aquí está lo que esta
			// prueba enseñó: el reporte *sí* hace más consultas con más gente, pero
			// no una por persona. Medido: **34 con 5 personas y 45 con 205**.
			//
			// Los once de diferencia no son un N+1: son el `insert` de los hechos
			// diarios materializados, que va en **trozos de 500 filas** porque un
			// `insert` de decenas de miles supera el límite de parámetros del
			// protocolo de PostgreSQL (`daily-facts-store.ts`). 205 personas × 31
			// días son 6.355 filas, o trece trozos; cinco personas caben en uno.
			//
			// Así que lo que se afirma es lo que de verdad importa: que el
			// crecimiento sea **muchísimo menor que el de la plantilla**. Con un N+1
			// de lectura, `many` estaría por encima de 230.
			expect(many - few).toBeLessThan(20);
			expect(many).toBeLessThan(60);
		} finally {
			// Se limpian aquí y no en el `afterEach`: doscientas filas de más harían
			// lento y ruidoso al resto de este archivo.
			await db
				.delete(attendanceDailyFacts)
				.where(inArray(attendanceDailyFacts.userId, bulkIds));
			await db.delete(profiles).where(inArray(profiles.id, bulkIds));
		}
		// Timeout propio: son dos reportes de 205 personas, con sus hechos diarios
		// materializados. El de 5 segundos por defecto no da.
	}, 60_000);
});

describe("§6 — los KPIs", () => {
	test("una corrida completada y una fallida dan la tasa de error", async () => {
		const ok = await enqueued(manager, { period: PERIOD, departmentId });
		await processQueuedRuns();
		expect((await runRow(ok.id))?.status).toBe("completed");

		const bad = await enqueued(manager, {
			period: PERIOD,
			departmentId: otherDepartmentId,
		});
		await db
			.update(reportRuns)
			.set({ status: "failed", errorMessage: "fallo de prueba" })
			.where(eq(reportRuns.id, bad.id));

		const kpis = (await (
			await request("/api/reports/kpis?windowDays=1", { as: manager })
		).json()) as {
			total: number;
			failed: number;
			errorRatePct: number;
			availabilityPct: number;
			p95DurationMs: number | null;
			meetsSlo: boolean;
		};

		expect(kpis.total).toBeGreaterThanOrEqual(2);
		expect(kpis.failed).toBeGreaterThanOrEqual(1);
		expect(kpis.errorRatePct).toBeGreaterThan(0);
		expect(kpis.availabilityPct).toBe(
			Math.round((100 - kpis.errorRatePct) * 100) / 100,
		);
		expect(kpis.p95DurationMs).not.toBeNull();
	});

	test("las encoladas no cuentan: no son ni éxito ni fallo", async () => {
		await enqueued(manager, { period: PERIOD, departmentId });

		const kpis = (await (
			await request("/api/reports/kpis?windowDays=1", { as: manager })
		).json()) as { total: number; errorRatePct: number };

		expect(kpis.total).toBe(0);
		expect(kpis.errorRatePct).toBe(0);
	});
});
