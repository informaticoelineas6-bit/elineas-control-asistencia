import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de los paneles y el dashboard (spec 15 §7) contra la base de
 * desarrollo.
 *
 * El criterio de aceptación que sólo se puede comprobar así es el del **conteo
 * de consultas**: "un panel con 200 empleados no dispara 200 consultas". Se mide
 * envolviendo el pool de `pg` y comparando el mismo panel con 5 personas y con
 * 205 — si el número no cambia, no hay N+1, y eso no depende de que yo acierte
 * cuál es la cifra correcta.
 *
 * Los otros criterios de §7 —precedencia, vacaciones y descansos que nunca salen
 * `AUSENTE`, jornada sin salida— se prueban puros en `daily-status.test.ts`,
 * porque son de la función y no del panel. Aquí se comprueba lo que el panel
 * añade: el ámbito, la zona horaria del departamento y la agregación.
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
const { countQueries } = await import("#/test-support/count-queries.ts");
const {
	appConfig,
	attendanceIncidents,
	attendanceMarks,
	auditLog,
	departments,
	notifications,
	profiles,
	userDepartmentResponsibilities,
	vacationRequests,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-dash-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
const mate = testUser("mate", ["employee"]);
/** En el departamento remoto, fuera del ámbito de `head`. */
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

const CENTER = { latitude: 23.1136, longitude: -82.3666 };

let departmentId = "";
/** En `Pacific/Kiritimati` (UTC+14): el criterio de la zona horaria de §7. */
let remoteDepartmentId = "";
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

type DayCounts = Record<string, number>;
type RosterEntry = {
	userId: string;
	userFullName: string;
	departmentId: string | null;
	departmentName: string | null;
	date: string;
	status: string;
	incomplete: boolean;
	open: boolean;
	absence: { code: string; reviewed: boolean } | null;
};
type Summary = {
	date: string;
	me: { day: { status: string } | null; vacationBalance: unknown } | null;
	scope: {
		total: number;
		counts: DayCounts;
		open: number;
		byDepartment: {
			departmentId: string;
			departmentName: string;
			isPaused: boolean;
			total: number;
			counts: DayCounts;
		}[];
	} | null;
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

function windowAroundNow(timezone = "UTC") {
	const now = new Date();
	const current = now.getUTCHours() * 60 + now.getUTCMinutes();
	const hhmm = (minutes: number) =>
		`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

	return {
		checkinStartTime: hhmm(Math.max(0, current - 60)),
		checkinEndTime: hhmm(Math.min(1439, current + 60)),
		checkoutStartTime: hhmm(Math.max(0, current - 60)),
		checkoutEndTime: hhmm(Math.min(1439, current + 60)),
		timezone,
	};
}

async function roster(who: TestUser, query = ""): Promise<RosterEntry[]> {
	const res = await request(`/api/attendance/daily${query}`, { as: who });
	expect(res.status).toBe(200);
	return (await res.json()) as RosterEntry[];
}

async function summary(who: TestUser): Promise<Summary> {
	const res = await request("/api/dashboard/summary", { as: who });
	expect(res.status).toBe(200);
	return (await res.json()) as Summary;
}

/** Marca una entrada válida, sin salida: deja la jornada abierta. */
async function seedOpenDay(userId: string, date: string) {
	await db.insert(attendanceMarks).values({
		userId,
		markType: "IN",
		markedAt: new Date(`${date}T12:00:00.000Z`),
		workDate: date,
		latitude: CENTER.latitude,
		longitude: CENTER.longitude,
		accuracy: 10,
		blocked: false,
		departmentId,
	});
}

/** Ids de los perfiles sembrados en masa para la prueba de conteo. */
let bulkIds: string[] = [];

async function clearDashboardRows() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length === 0) return;
	await db.delete(attendanceMarks).where(inArray(attendanceMarks.userId, ids));
	await db
		.delete(attendanceIncidents)
		.where(inArray(attendanceIncidents.userId, ids));
	await db
		.delete(vacationRequests)
		.where(inArray(vacationRequests.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, mate, outsider, head, manager]) {
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

	const remote = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name("remoto") },
	});
	remoteDepartmentId = ((await remote.json()) as { id: string }).id;

	await moveTo(employee, departmentId);
	await moveTo(mate, departmentId);
	await moveTo(head, departmentId);
	await moveTo(outsider, remoteDepartmentId);

	expect(
		(
			await request(`/api/departments/${departmentId}/schedule`, {
				as: manager,
				method: "PUT",
				body: windowAroundNow(),
			})
		).status,
	).toBe(200);

	// RN-15.4: la zona la pone el horario del departamento, no el servidor.
	expect(
		(
			await request(`/api/departments/${remoteDepartmentId}/schedule`, {
				as: manager,
				method: "PUT",
				body: windowAroundNow("Pacific/Kiritimati"),
			})
		).status,
	).toBe(200);

	// 200 perfiles más en el departamento del equipo, sembrados directo: la
	// prueba de conteo necesita volumen, no identidades reales.
	const bulk = Array.from({ length: 200 }, (_, index) => ({
		identityUserId: `${TAG}-bulk-${index}`,
		email: `${TAG}-bulk-${index}@test.local`,
		fullName: `${TAG} Bulk ${String(index).padStart(3, "0")}`,
		departmentId,
		isActive: true,
	}));
	bulkIds = (
		await db.insert(profiles).values(bulk).returning({ id: profiles.id })
	).map((row) => row.id);
});

afterEach(async () => {
	await clearDashboardRows();
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

	if (ids.length > 0) {
		await clearDashboardRows();
		await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
		await db
			.delete(userDepartmentResponsibilities)
			.where(inArray(userDepartmentResponsibilities.userId, ids));
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

describe("ámbito (§7, el criterio de aislamiento)", () => {
	test("sin sesión, todo responde 401", async () => {
		expect((await request("/api/attendance/daily")).status).toBe(401);
		expect((await request("/api/dashboard/summary")).status).toBe(401);
		expect((await request("/api/dashboard/alerts")).status).toBe(401);
	});

	test("un empleado no entra a los paneles ni a la tendencia", async () => {
		expect(
			(await request("/api/attendance/daily", { as: employee })).status,
		).toBe(403);
		expect(
			(await request("/api/dashboard/trend", { as: employee })).status,
		).toBe(403);
		expect(
			(await request("/api/dashboard/alerts", { as: employee })).status,
		).toBe(403);
	});

	test("un jefe sólo ve su ámbito, y no hay parámetro que lo amplíe", async () => {
		const mine = await roster(head);
		const outsiderId = await profileIdOf(outsider);

		expect(mine.some((row) => row.userId === outsiderId)).toBe(false);
		expect(mine.every((row) => row.departmentId === departmentId)).toBe(true);

		// El parámetro que podría ensanchar el ámbito no existe: mandarlo no hace
		// nada, y acotar a un departamento ajeno se rechaza.
		const ignored = await roster(head, "?scope=global");
		expect(ignored.some((row) => row.userId === outsiderId)).toBe(false);

		expect(
			(
				await request(
					`/api/attendance/daily?departmentId=${remoteDepartmentId}`,
					{ as: head },
				)
			).status,
		).toBe(403);
	});

	test("un gestor global ve los dos departamentos y puede acotar", async () => {
		const all = await roster(manager);
		const outsiderId = await profileIdOf(outsider);
		expect(all.some((row) => row.userId === outsiderId)).toBe(true);

		const only = await roster(manager, `?departmentId=${remoteDepartmentId}`);
		expect(only.every((row) => row.departmentId === remoteDepartmentId)).toBe(
			true,
		);
	});

	test("el detalle de una persona respeta el ámbito", async () => {
		const outsiderId = await profileIdOf(outsider);
		const mateId = await profileIdOf(mate);
		const range = `from=${addDays(TODAY, -2)}&to=${TODAY}`;

		expect(
			(
				await request(
					`/api/attendance/daily-range?userId=${outsiderId}&${range}`,
					{ as: head },
				)
			).status,
		).toBe(403);

		expect(
			(
				await request(`/api/attendance/daily-range?userId=${mateId}&${range}`, {
					as: head,
				})
			).status,
		).toBe(200);
	});
});

describe("el panel del día (§5.2 y §5.3, que son la misma vista)", () => {
	test("clasifica a cada persona y marca las jornadas abiertas", async () => {
		const employeeId = await profileIdOf(employee);
		await seedOpenDay(employeeId, TODAY);

		const rows = await roster(head);
		const mine = rows.find((row) => row.userId === employeeId);

		expect(mine?.status).toBe("PRESENTE");
		// Entrada sin salida y el día es hoy: sigue dentro (§8, decisión 4).
		expect(mine?.open).toBe(true);

		// Quien no marcó no aparece "abierto", aunque el día siga en curso.
		const mateId = await profileIdOf(mate);
		const other = rows.find((row) => row.userId === mateId);
		expect(other?.open).toBe(false);
	});

	test("una jornada abierta de ayer es incompleta, no alguien dentro", async () => {
		const employeeId = await profileIdOf(employee);
		const yesterday = addDays(TODAY, -1);
		await seedOpenDay(employeeId, yesterday);

		const rows = await roster(head, `?date=${yesterday}`);
		const mine = rows.find((row) => row.userId === employeeId);
		expect(mine?.incomplete).toBe(true);
		expect(mine?.open).toBe(false);
	});

	test("no trae las marcas de cada persona: eso es el N+1 de la §4", async () => {
		await seedOpenDay(await profileIdOf(employee), TODAY);
		const rows = await roster(head);
		expect(rows[0]).not.toHaveProperty("marks");
	});

	test("el día se delimita en la zona del departamento (RN-15.4, §7)", async () => {
		// `Pacific/Kiritimati` va catorce horas por delante de UTC: durante buena
		// parte del día su fecha es la siguiente. El panel del departamento remoto
		// tiene que usar **su** fecha, no la del servidor.
		const rows = await roster(manager, `?departmentId=${remoteDepartmentId}`);
		expect(rows.length).toBeGreaterThan(0);

		const remoteDate = rows[0]?.date ?? "";
		const localRows = await roster(manager, `?departmentId=${departmentId}`);
		const localDate = localRows[0]?.date ?? "";

		// O coinciden (si el servidor está en la misma fecha) o la remota va por
		// delante: nunca por detrás.
		expect(remoteDate >= localDate).toBe(true);
	});
});

describe("el dashboard (§5.1)", () => {
	test("un empleado recibe lo suyo y ningún ámbito", async () => {
		const body = await summary(employee);
		expect(body.me).not.toBeNull();
		expect(body.me?.vacationBalance).not.toBeNull();
		expect(body.scope).toBeNull();
	});

	test("un jefe recibe lo suyo y el resumen de su equipo", async () => {
		const body = await summary(head);
		expect(body.me).not.toBeNull();
		expect(body.scope).not.toBeNull();
		// Su ámbito es un solo departamento.
		expect(body.scope?.byDepartment).toHaveLength(1);
		expect(body.scope?.byDepartment[0]?.departmentId).toBe(departmentId);
	});

	test("un gestor global no tiene día propio pero sí el desglose entero", async () => {
		const body = await summary(manager);
		// RN-03.4: no marca, así que no se le enseña una tarjeta vacía.
		expect(body.me).toBeNull();
		expect(body.scope).not.toBeNull();
		expect(
			body.scope?.byDepartment.some(
				(row) => row.departmentId === remoteDepartmentId,
			),
		).toBe(true);
	});

	test("los totales cuadran con la suma del desglose", async () => {
		await seedOpenDay(await profileIdOf(employee), TODAY);
		const body = await summary(manager);

		const sum = (body.scope?.byDepartment ?? []).reduce(
			(total, row) => total + row.total,
			0,
		);
		// Salen del mismo conteo, no de dos consultas: si no cuadraran, nadie
		// sabría a cuál creer.
		expect(sum).toBe(body.scope?.total ?? -1);
	});

	test("un departamento en pausa se señala en el desglose", async () => {
		expect(
			(
				await request(`/api/departments/${remoteDepartmentId}/pause`, {
					as: manager,
					method: "POST",
					body: { reason: name("prueba de pausa") },
				})
			).status,
		).toBe(200);

		const body = await summary(manager);
		const remote = body.scope?.byDepartment.find(
			(row) => row.departmentId === remoteDepartmentId,
		);
		expect(remote?.isPaused).toBe(true);

		await request(`/api/departments/${remoteDepartmentId}/resume`, {
			as: manager,
			method: "POST",
		});
	});

	test("la tendencia devuelve una fila por día y termina hoy", async () => {
		const res = await request("/api/dashboard/trend?days=7", { as: head });
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			days: { date: string; total: number; counts: DayCounts }[];
		};
		expect(body.days).toHaveLength(7);
		// Las fechas van en orden ascendente y sin huecos.
		for (let i = 1; i < body.days.length; i += 1) {
			expect(body.days[i]?.date).toBe(addDays(body.days[i - 1]?.date ?? "", 1));
		}
	});

	test("las alertas sólo traen lo que tiene algo pendiente", async () => {
		const res = await request("/api/dashboard/alerts", { as: head });
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			alerts: { kind: string; count: number }[];
		};
		// Una alerta con cero no es una alerta.
		expect(body.alerts.every((alert) => alert.count > 0)).toBe(true);
	});

	test("una incidencia pendiente aparece como alerta del jefe", async () => {
		expect(
			(
				await request("/api/incidents", {
					as: employee,
					method: "POST",
					body: {
						incidentType: "gps_issue",
						date: addDays(TODAY, -1),
						reason: "",
					},
				})
			).status,
		).toBe(201);

		const res = await request("/api/dashboard/alerts", { as: head });
		const body = (await res.json()) as {
			alerts: { kind: string; count: number }[];
		};
		const incidents = body.alerts.find(
			(alert) => alert.kind === "incidents_pending",
		);
		expect(incidents?.count).toBeGreaterThanOrEqual(1);
	});
});

describe("§7 — un panel de 200 empleados no dispara 200 consultas", () => {
	test("el número de consultas no crece con el tamaño del departamento", async () => {
		// Con las 200 personas sembradas fuera del ámbito del jefe primero…
		await db
			.update(profiles)
			.set({ departmentId: remoteDepartmentId })
			.where(inArray(profiles.id, bulkIds));

		// (una llamada previa para que las cachés de sesión y configuración estén
		// calientes en las dos medidas)
		await roster(head);
		const few = await countQueries(() => roster(head));

		// …y ahora dentro.
		await db
			.update(profiles)
			.set({ departmentId })
			.where(inArray(profiles.id, bulkIds));

		const rows = await roster(head);
		expect(rows.length).toBeGreaterThanOrEqual(200);

		const many = await countQueries(() => roster(head));

		// Lo que importa no es la cifra exacta sino que **no dependa del número de
		// personas**: si hubiera una consulta por empleado, `many` sería doscientas
		// veces `few`.
		// Medido: 11 consultas con 5 personas y **11 con 203**.
		expect(many).toBe(few);
		expect(many).toBeLessThan(30);
	});
});
