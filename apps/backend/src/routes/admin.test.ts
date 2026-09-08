import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import {
	type AdminStats,
	type AppRole,
	type AttendanceImportReport,
	type AttendanceImportResult,
	appRoleSchema,
	type MaintenanceState,
} from "@elineas/validations";
import { and, eq, inArray, like } from "drizzle-orm";
import { writeXlsx } from "hucre/xlsx";

/**
 * Pruebas del panel de superadmin (spec 19 §5) contra la base de desarrollo.
 *
 * Lo que se demuestra aquí:
 *
 * - **RN-19.7** — ningún endpoint de `/admin` responde a otro rol, y eso incluye
 *   al `global_manager`, que en todo lo demás lo puede casi todo.
 * - **Decisión 1 de la §6** — `POST /admin/sql` **no existe**. La prueba lo fija:
 *   volver a añadirlo tendría que ser un acto deliberado, no un descuido.
 * - **§2.5** — el mantenimiento bloquea las escrituras de los demás, deja pasar
 *   las lecturas y no ata al `superadmin`, que es quien tiene que apagarlo.
 * - **RN-19.2** — la validación de importación **no escribe ni una fila**. Se
 *   comprueba contando marcajes antes y después.
 * - **RN-19.3** — reimportar el mismo archivo no duplica: lo sostiene el índice
 *   único por minuto que la spec 09 creó para el antirrebote.
 * - **RN-19.5** — los marcajes importados **no tienen coordenadas**, así que no
 *   se pueden confundir con evidencia de ubicación.
 * - **RN-19.4 y RN-19.6** — tras importar se recalculan los hechos diarios, y la
 *   importación deja bitácora con el archivo, el rango y las filas.
 *
 * Requiere el Postgres del compose (`docker compose up -d postgres` y
 * `bun run db:migrate`).
 */

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
const { db } = await import("#/db");
const {
	appConfig,
	attendanceDailyFacts,
	attendanceMarks,
	auditLog,
	departments,
	notifications,
	profiles,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-adm-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
const head = testUser("head", ["department_head"]);
const manager = testUser("manager", ["global_manager"]);
const root = testUser("root", ["superadmin"]);

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

/** El `multipart` de la importación: sin `Content-Type` a mano — lo pone `FormData`. */
function upload(
	path: string,
	bytes: Uint8Array,
	as: TestUser,
	name = "historico.xlsx",
) {
	const form = new FormData();
	form.append("file", new File([new Blob([bytes])], name));
	return app.request(path, {
		method: "POST",
		headers: { Cookie: as.cookie },
		body: form,
	});
}

const name = (suffix: string) => `${TAG} ${suffix}`;

const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);

/** Dos días cerrados del pasado: un histórico no se importa sobre hoy. */
const DAY_ONE = addDays(TODAY, -20);
const DAY_TWO = addDays(TODAY, -19);

let departmentId = "";
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

async function profileIdOf(who: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, who.identityUserId),
	});
	if (!row) throw new Error(`El perfil de ${who.identityUserId} no existe`);
	return row.id;
}

/** El correo con el que el archivo referencia a alguien. */
const emailOf = (who: TestUser) => `${who.identityUserId}@test.local`;

function workbook(rows: (string | number)[][]): Promise<Uint8Array> {
	return writeXlsx({
		sheets: [
			{
				name: "Histórico",
				rows: [["Correo", "Fecha", "Hora", "Tipo"], ...rows],
			},
		],
	});
}

/** El archivo de siempre: dos jornadas completas de la misma persona. */
const goodFile = () =>
	workbook([
		[emailOf(employee), DAY_ONE, "08:00", "entrada"],
		[emailOf(employee), DAY_ONE, "17:00", "salida"],
		[emailOf(employee), DAY_TWO, "08:05", "IN"],
		[emailOf(employee), DAY_TWO, "17:02", "OUT"],
	]);

async function marksOf(who: TestUser) {
	return db
		.select()
		.from(attendanceMarks)
		.where(eq(attendanceMarks.userId, await profileIdOf(who)));
}

async function maintenance(as: TestUser = root): Promise<MaintenanceState> {
	const res = await request("/api/admin/maintenance", { as });
	expect(res.status).toBe(200);
	return (await res.json()) as MaintenanceState;
}

async function setMaintenance(
	body: { active: boolean; message?: string },
	as: TestUser = root,
) {
	return request("/api/admin/maintenance", { as, method: "PUT", body });
}

async function taggedProfileIds(): Promise<string[]> {
	const rows = await db
		.select({ id: profiles.id })
		.from(profiles)
		.where(like(profiles.identityUserId, `${TAG}%`));
	return rows.map((row) => row.id);
}

async function clearRows() {
	const ids = await taggedProfileIds();
	if (ids.length === 0) return;
	await db.delete(attendanceMarks).where(inArray(attendanceMarks.userId, ids));
	await db
		.delete(attendanceDailyFacts)
		.where(inArray(attendanceDailyFacts.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
	await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
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

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, head, manager, root]) {
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

	await db
		.update(profiles)
		.set({ departmentId })
		.where(like(profiles.identityUserId, `${TAG}%`));

	// Con horario y calendario, el recálculo de RN-19.4 tiene algo que escribir.
	expect(
		(
			await request(`/api/departments/${departmentId}/schedule`, {
				as: manager,
				method: "PUT",
				body: windowAroundNow(),
			})
		).status,
	).toBe(200);
	expect(
		(
			await request(`/api/departments/${departmentId}/calendar`, {
				as: manager,
				method: "PUT",
				body: {
					entries: [
						{ date: DAY_ONE, isWorkday: true },
						{ date: DAY_TWO, isWorkday: true },
					],
				},
			})
		).status,
	).toBe(200);
});

afterEach(async () => {
	await clearRows();
	await db.delete(appConfig);
	for (const row of savedConfig) await db.insert(appConfig).values(row);
	invalidateConfigCache();
});

afterAll(async () => {
	const ids = await taggedProfileIds();
	const departmentIds = (
		await db
			.select({ id: departments.id })
			.from(departments)
			.where(like(departments.name, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length > 0) {
		await clearRows();
		await db
			.update(profiles)
			.set({ departmentId: null, selectedWorkLocationId: null })
			.where(inArray(profiles.id, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
	if (departmentIds.length > 0) {
		await db.delete(departments).where(inArray(departments.id, departmentIds));
	}
});

describe("RN-19.7 — sólo superadmin", () => {
	const endpoints = [
		{ method: "GET", path: "/api/admin/stats" },
		{ method: "GET", path: "/api/admin/maintenance" },
		{
			method: "PUT",
			path: "/api/admin/maintenance",
			body: { active: false },
		},
	] as const;

	test("un gestor global recibe 403 en todos", async () => {
		// Es el rol que en todo lo demás lo puede casi todo: si algo se cuela, se
		// cuela por aquí.
		for (const endpoint of endpoints) {
			const res = await request(endpoint.path, { as: manager, ...endpoint });
			expect(`${endpoint.method} ${endpoint.path} → ${res.status}`).toBe(
				`${endpoint.method} ${endpoint.path} → 403`,
			);
		}
	});

	test("un jefe y un empleado tampoco, ni en la importación", async () => {
		const bytes = await goodFile();
		for (const who of [head, employee]) {
			for (const endpoint of endpoints) {
				expect(
					(await request(endpoint.path, { as: who, ...endpoint })).status,
				).toBe(403);
			}
			for (const path of [
				"/api/admin/import/attendance/validate",
				"/api/admin/import/attendance/commit",
			]) {
				expect((await upload(path, bytes, who)).status).toBe(403);
			}
		}
	});

	test("sin sesión, 401", async () => {
		expect((await request("/api/admin/stats")).status).toBe(401);
	});
});

describe("§6 decisión 1 — la consola SQL no existe", () => {
	test("no hay endpoint de SQL, ni para un superadmin", async () => {
		// La decisión está cerrada por la alternativa (a) de la §2.3: no se
		// reimplementa. Esta prueba la fija — añadirla nunca puede ser un descuido.
		for (const path of ["/api/admin/sql", "/api/admin/query"]) {
			const res = await request(path, {
				as: root,
				method: "POST",
				body: { sql: "select 1" },
			});
			expect(`${path} → ${res.status}`).toBe(`${path} → 404`);
		}
	});
});

describe("§2.1 — estadísticas globales", () => {
	test("cuentan lo que hay, y no inventan un desglose por rol", async () => {
		const res = await request("/api/admin/stats", { as: root });
		expect(res.status).toBe(200);
		const stats = (await res.json()) as AdminStats;

		expect(stats.profiles.total).toBeGreaterThanOrEqual(4);
		expect(stats.profiles.active).toBeGreaterThanOrEqual(4);
		expect(stats.departments.total).toBeGreaterThanOrEqual(1);
		expect(stats.reports.queued).toBeGreaterThanOrEqual(0);
		expect(stats.audit.lastDay).toBeGreaterThan(0);

		// Y lo que **no** trae: un conteo por rol. Este sistema no sabe qué rol
		// tiene nadie sin que esa persona se autentique (RN-00.43).
		expect(Object.keys(stats.profiles)).not.toContain("byRole");
	});
});

describe("§2.5 — modo de mantenimiento", () => {
	test("activar sin motivo es un 400", async () => {
		const res = await setMaintenance({ active: true });
		expect(res.status).toBe(400);
		expect((await maintenance()).active).toBe(false);
	});

	test("activo: bloquea las escrituras de los demás y deja pasar las lecturas", async () => {
		expect(
			(await setMaintenance({ active: true, message: "Migración de datos." }))
				.status,
		).toBe(200);

		const state = await maintenance();
		expect(state.active).toBe(true);
		expect(state.message).toBe("Migración de datos.");
		// «Quién y cuándo» sale de la bitácora, no de una columna duplicada.
		expect(state.byName).toBe(root.identityUserId);
		expect(state.since).not.toBeNull();

		// Una escritura de un empleado: 503 con el motivo dentro.
		const write = await request("/api/notifications/read-all", {
			as: employee,
			method: "POST",
		});
		expect(write.status).toBe(503);
		expect(((await write.json()) as { error: string }).error).toBe(
			"Migración de datos.",
		);

		// Y una escritura de un gestor global tampoco pasa: el rol no exime, el
		// mantenimiento es del sistema.
		expect(
			(
				await request("/api/departments", {
					as: manager,
					method: "POST",
					body: { name: name("no debería crearse") },
				})
			).status,
		).toBe(503);

		// Las lecturas siguen: quien entra tiene que poder ver el aviso.
		expect(
			(await request("/api/me/permissions", { as: employee })).status,
		).toBe(200);
		expect((await request("/api/notifications", { as: employee })).status).toBe(
			200,
		);
	});

	test("el superadmin sí escribe: es quien tiene que poder apagarlo", async () => {
		await setMaintenance({ active: true, message: "Parada corta." });
		expect((await setMaintenance({ active: false })).status).toBe(200);
		expect((await maintenance()).active).toBe(false);
	});

	test("el aviso viaja en la configuración pública, para todo el mundo", async () => {
		await setMaintenance({ active: true, message: "Volvemos en una hora." });

		// El criterio de la §5 dice "se refleja en la UI de todos los usuarios
		// conectados", y "todos" incluye a quien sólo tiene esta consulta.
		const res = await request("/api/config/public", { as: employee });
		expect(res.status).toBe(200);
		const config = (await res.json()) as Record<string, unknown>;
		expect(config.maintenance_mode).toBe(true);
		expect(config.maintenance_message).toBe("Volvemos en una hora.");
	});

	test("deja bitácora al activar y al desactivar, y repetir no la ensucia", async () => {
		await setMaintenance({ active: true, message: "Con motivo." });
		await setMaintenance({ active: false });
		// Repetir la misma orden es idempotente y no escribe una segunda entrada.
		await setMaintenance({ active: false });

		const entries = await db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.actorId, await profileIdOf(root)),
					eq(auditLog.tableName, "app_config"),
				),
			);
		const actions = entries.map((row) => row.action);

		expect(actions.filter((a) => a === "maintenance.enabled")).toHaveLength(1);
		expect(actions.filter((a) => a === "maintenance.disabled")).toHaveLength(1);
	});
});

describe("§2.4 — importación de histórico", () => {
	test("RN-19.2: la validación informa y no escribe ni una fila", async () => {
		const bytes = await workbook([
			[emailOf(employee), DAY_ONE, "08:00", "entrada"],
			[emailOf(employee), DAY_ONE, "17:00", "salida"],
			["quien-no-existe@test.local", DAY_ONE, "08:00", "entrada"],
			[emailOf(employee), "no es una fecha", "08:00", "entrada"],
			[emailOf(employee), DAY_TWO, "08:00", "bailar"],
		]);

		const res = await upload(
			"/api/admin/import/attendance/validate",
			bytes,
			root,
		);
		expect(res.status).toBe(200);
		const report = (await res.json()) as AttendanceImportReport;

		expect(report.rows).toBe(5);
		expect(report.valid).toBe(2);
		expect(report.issues).toHaveLength(3);
		expect(report.people).toBe(1);
		expect(report.from).toBe(DAY_ONE);
		expect(report.to).toBe(DAY_ONE);
		// Cada error dice **qué** fila y **por qué**, que es lo que RN-19.2 pide. Y
		// el número es el que la persona ve en Excel: la cabecera es la fila 1, así
		// que las tres filas con problema son la 4, la 5 y la 6.
		expect(report.issues.map((issue) => issue.row)).toEqual([4, 5, 6]);
		expect(report.issues[0]?.message).toContain("No hay perfil");

		// Y lo importante: nada escrito.
		expect(await marksOf(employee)).toHaveLength(0);
	});

	test("RN-19.1, 19.4 y 19.5: escribe marcado como importado, sin coordenadas y recalculando", async () => {
		const res = await upload(
			"/api/admin/import/attendance/commit",
			await goodFile(),
			root,
		);
		expect(res.status).toBe(200);
		const result = (await res.json()) as AttendanceImportResult;

		expect(result.inserted).toBe(4);
		expect(result.from).toBe(DAY_ONE);
		expect(result.to).toBe(DAY_TWO);
		// RN-19.4 — Los hechos diarios del rango se recalculan tras escribir.
		expect(result.factsRefreshed).toBeGreaterThan(0);

		const marks = await marksOf(employee);
		expect(marks).toHaveLength(4);
		for (const mark of marks) {
			expect(mark.source).toBe("import");
			// RN-19.5 — Sin coordenadas: no hay ubicación que fingir.
			expect(mark.latitude).toBeNull();
			expect(mark.longitude).toBeNull();
			expect(mark.accuracy).toBeNull();
			expect(mark.insideGeofence).toBeNull();
			expect(mark.blocked).toBe(false);
		}
		expect(marks.map((mark) => mark.workDate).sort()).toEqual([
			DAY_ONE,
			DAY_ONE,
			DAY_TWO,
			DAY_TWO,
		]);
	});

	test("RN-19.3: reimportar el mismo archivo no duplica nada", async () => {
		await upload("/api/admin/import/attendance/commit", await goodFile(), root);
		const again = await upload(
			"/api/admin/import/attendance/commit",
			await goodFile(),
			root,
		);
		expect(again.status).toBe(200);
		const result = (await again.json()) as AttendanceImportResult;

		expect(result.inserted).toBe(0);
		// Y el informe lo dice antes de escribir: las cuatro ya estaban.
		expect(result.alreadyPresent).toBe(4);
		expect(await marksOf(employee)).toHaveLength(4);
	});

	test("RN-19.6: la importación deja bitácora con archivo, rango y filas", async () => {
		await upload(
			"/api/admin/import/attendance/commit",
			await goodFile(),
			root,
			"marzo-2024.xlsx",
		);

		const [entry] = await db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.actorId, await profileIdOf(root)),
					eq(auditLog.action, "attendance.imported"),
				),
			);

		expect(entry).toBeDefined();
		expect(entry?.metadata).toMatchObject({ filename: "marzo-2024.xlsx" });
		expect(entry?.newData).toMatchObject({
			inserted: 4,
			from: DAY_ONE,
			to: DAY_TWO,
		});
	});

	test("un archivo que no es una hoja de cálculo es un 400, no un 500", async () => {
		const res = await upload(
			"/api/admin/import/attendance/validate",
			new TextEncoder().encode("esto no es un xlsx"),
			root,
		);
		expect(res.status).toBe(400);
	});

	test("sin archivo adjunto, 400", async () => {
		const res = await app.request("/api/admin/import/attendance/validate", {
			method: "POST",
			headers: { Cookie: root.cookie },
			body: new FormData(),
		});
		expect(res.status).toBe(400);
	});

	test("una hoja vacía no es un error: es un informe de cero filas", async () => {
		const res = await upload(
			"/api/admin/import/attendance/commit",
			await workbook([]),
			root,
		);
		expect(res.status).toBe(200);
		const result = (await res.json()) as AttendanceImportResult;
		expect(result.rows).toBe(0);
		expect(result.inserted).toBe(0);
		expect(result.from).toBeNull();
	});
});
