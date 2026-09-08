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
	type AppRole,
	type AuditPage,
	appRoleSchema,
} from "@elineas/validations";
import { eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de la bitácora (spec 18 §8) contra la base de desarrollo.
 *
 * Cinco de sus siete criterios sólo se pueden demostrar aquí:
 *
 * - **RN-18.5** — la bitácora completa es de `superadmin`. Un `global_manager`
 *   recibe 403, y es un criterio explícito de la §8.
 * - **RN-18.6** — no hay forma de escribir ni de borrar: los métodos de
 *   escritura no existen, y las entradas **sobreviven al borrado del perfil que
 *   las generó**, que es lo que hace que la bitácora sirva seis meses después.
 * - **RN-18.8** — una acción en cascada comparte identificador de correlación.
 *   Se prueba con la que la regla nombra: clasificar una ausencia como
 *   injustificada escribe la revisión **y** el ajuste de nómina.
 * - **Estado anterior** — las entradas traen `old_data`, no sólo el nuevo.
 * - **RN-18.2** — ninguna entrada lleva credenciales.
 *
 * La diferencia campo a campo, el cursor y la cobertura del catálogo se prueban
 * puros en `services/audit-rules.test.ts`.
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
	attendanceAbsenceReviews,
	auditLog,
	departments,
	employeeCompensation,
	notifications,
	payrollAdjustments,
	profiles,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-aud-${crypto.randomUUID().slice(0, 8)}`;

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
/** Se borra a mitad de una prueba: su rastro tiene que sobrevivirle (RN-18.6). */
const ghost = testUser("ghost", ["global_manager"]);

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

/** Un día laborable, ausente y ya cerrado: la cascada de RN-18.8. */
const ABSENT_DAY = addDays(TODAY, -3);
/** 3000 / 30 = 100.00 exactos. */
const SALARY = "3000.00";

let departmentId = "";
let managerId = "";
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

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

async function auditPage(query = "", as: TestUser = root): Promise<AuditPage> {
	const res = await request(`/api/audit${query}`, { as });
	expect(res.status).toBe(200);
	return (await res.json()) as AuditPage;
}

/**
 * Una página **acotada al actor de esta prueba**.
 *
 * Sin esto, cada aserción se mediría contra la bitácora entera de la base de
 * desarrollo —que trae lo de todas las corridas anteriores y lo del uso a mano—,
 * y un `toHaveLength(2)` pasaría o fallaría según lo que hubiera hecho alguien
 * ayer. El `TAG` de este archivo es único por corrida, así que filtrar por el
 * perfil del gestor aísla exactamente lo que la prueba provocó. Es además un
 * filtro que la §6 ya ofrece: no se inventa nada para poder probar.
 */
const mine = (query = ""): Promise<AuditPage> =>
	auditPage(`?actorId=${managerId}${query}`);

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
	await db
		.delete(payrollAdjustments)
		.where(inArray(payrollAdjustments.userId, ids));
	await db
		.delete(attendanceAbsenceReviews)
		.where(inArray(attendanceAbsenceReviews.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
	await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, head, manager, root, ghost]) {
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

	await moveTo(employee, departmentId);
	await moveTo(head, departmentId);
	managerId = await profileIdOf(manager);

	// Zona UTC para que el "hoy" del servidor coincida con el de la prueba y
	// `ABSENT_DAY` esté inequívocamente cerrado.
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
				body: { entries: [{ date: ABSENT_DAY, isWorkday: true }] },
			})
		).status,
	).toBe(200);

	const id = await profileIdOf(employee);
	expect(
		(
			await request(`/api/users/${id}/compensation`, {
				as: manager,
				method: "PUT",
				body: { monthlySalary: SALARY, currency: "CUP" },
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
			.delete(employeeCompensation)
			.where(inArray(employeeCompensation.profileId, ids));
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(inArray(profiles.id, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}

	if (departmentIds.length > 0) {
		await db.delete(departments).where(inArray(departments.id, departmentIds));
	}
});

describe("RN-18.5 — la lectura es de superadmin", () => {
	const paths = [
		"/api/audit",
		"/api/audit/resource/profiles/00000000-0000-4000-8000-000000000000",
	];

	test("un gestor global recibe 403, y es un criterio de la §8", async () => {
		// No es prudencia: una entrada de bitácora no tiene departamento, así que
		// "la parte de mi ámbito" no se puede calcular sin etiquetar cada fila al
		// escribirla. Ver la nota de `routes/audit.ts`.
		for (const path of paths) {
			expect((await request(path, { as: manager })).status).toBe(403);
		}
	});

	test("un jefe y un empleado tampoco", async () => {
		for (const who of [head, employee]) {
			for (const path of paths) {
				expect((await request(path, { as: who })).status).toBe(403);
			}
		}
	});

	test("sin sesión, 401", async () => {
		expect((await request("/api/audit")).status).toBe(401);
	});

	test("un superadmin lee", async () => {
		expect((await request("/api/audit", { as: root })).status).toBe(200);
	});
});

describe("RN-18.6 — inmutable", () => {
	test("no existe ningún método de escritura", async () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const res = await request("/api/audit", {
				as: root,
				method,
				body: { action: "config.updated" },
			});
			// 404 porque la ruta no existe para ese método: no hay nada que rechazar.
			expect(`${method} → ${res.status}`).toBe(`${method} → 404`);
		}
	});

	test("el rastro sobrevive al borrado del perfil que lo generó", async () => {
		const ghostId = await profileIdOf(ghost);

		// El fantasma actúa: un cambio de configuración con su nombre encima.
		expect(
			(
				await request("/api/config", {
					as: ghost,
					method: "PATCH",
					body: { late_tolerance_minutes: 7 },
				})
			).status,
		).toBe(200);
		invalidateConfigCache();

		const before = await auditPage(`?actorId=${ghostId}`);
		expect(before.entries.length).toBeGreaterThan(0);
		expect(before.entries[0]?.actorName).toBe(ghost.identityUserId);

		// Y desaparece: primero la baja, que el borrado exige (RN-02.8).
		expect(
			(
				await request(`/api/users/${ghostId}/deactivate`, {
					as: root,
					method: "POST",
					body: { reason: "Prueba de bitácora." },
				})
			).status,
		).toBe(200);
		expect(
			(await request(`/api/users/${ghostId}`, { as: root, method: "DELETE" }))
				.status,
		).toBe(200);

		const after = await auditPage(`?actorId=${ghostId}`);
		expect(after.entries.length).toBe(before.entries.length);
		// Queda el id, se pierde el nombre: no hay a quién preguntárselo, pero la
		// entrada sigue contando qué pasó.
		expect(after.entries[0]?.actorId).toBe(ghostId);
		expect(after.entries[0]?.actorName).toBeNull();

		// Y se limpia aquí: el `afterEach` borra por perfil etiquetado, y este
		// perfil ya no existe — que es justamente lo que la prueba demuestra.
		await db.delete(auditLog).where(eq(auditLog.actorId, ghostId));
	});
});

describe("§8 — el estado anterior", () => {
	test("una modificación registra el valor de antes y el de después", async () => {
		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { late_tolerance_minutes: 11 },
		});
		invalidateConfigCache();
		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { late_tolerance_minutes: 13 },
		});
		invalidateConfigCache();

		const page = await mine("&action=config.updated");
		const latest = page.entries[0];

		expect(latest?.oldData).toMatchObject({ late_tolerance_minutes: 11 });
		expect(latest?.newData).toMatchObject({ late_tolerance_minutes: 13 });
	});
});

describe("RN-18.8 — el identificador de correlación", () => {
	test("la cadena de una ausencia injustificada comparte identificador", async () => {
		const userId = await profileIdOf(employee);
		const res = await request(`/api/absences/${userId}/${ABSENT_DAY}`, {
			as: manager,
			method: "PUT",
			body: { isJustified: false },
		});
		expect(res.status).toBe(200);

		const page = await mine("&limit=20");
		const chain = page.entries.filter(
			(entry) =>
				entry.action === "absence.reviewed" ||
				entry.action === "payroll_adjustment.created",
		);

		// Las dos escrituras de la cascada, en la misma transacción.
		expect(chain).toHaveLength(2);
		const ids = new Set(chain.map((entry) => entry.metadata?.correlationId));
		expect(ids.size).toBe(1);

		// Y la cadena **se puede leer**, que es lo que la regla pide. Sin filtro, el
		// identificador estaría guardado y no serviría para nada.
		const correlationId = [...ids][0] as string;
		expect(correlationId).toBeString();
		const linked = await auditPage(`?correlationId=${correlationId}`);
		expect(linked.entries.map((entry) => entry.action).sort()).toEqual([
			"absence.reviewed",
			"payroll_adjustment.created",
		]);
	});

	test("dos peticiones distintas no comparten identificador", async () => {
		for (const value of [17, 19]) {
			await request("/api/config", {
				as: manager,
				method: "PATCH",
				body: { late_tolerance_minutes: value },
			});
			invalidateConfigCache();
		}

		const page = await mine("&action=config.updated");
		const ids = page.entries.map((entry) => entry.metadata?.correlationId);
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
	});
});

describe("RN-18.2 — sin credenciales", () => {
	test("ninguna entrada lleva contraseñas ni tokens", async () => {
		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { late_tolerance_minutes: 9 },
		});
		invalidateConfigCache();
		const userId = await profileIdOf(employee);
		await request(`/api/absences/${userId}/${ABSENT_DAY}`, {
			as: manager,
			method: "PUT",
			body: { isJustified: false },
		});

		const page = await mine("&limit=100");
		expect(page.entries.length).toBeGreaterThan(0);

		const forbidden = /password|contrase|token|secret|cookie|authorization/i;
		for (const entry of page.entries) {
			const dump = JSON.stringify({
				oldData: entry.oldData,
				newData: entry.newData,
				metadata: entry.metadata,
			});
			expect(dump).not.toMatch(forbidden);
		}
	});
});

describe("§6 — filtros y paginación", () => {
	async function seed(): Promise<string> {
		const userId = await profileIdOf(employee);
		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { late_tolerance_minutes: 12 },
		});
		invalidateConfigCache();
		await request(`/api/absences/${userId}/${ABSENT_DAY}`, {
			as: manager,
			method: "PUT",
			body: { isJustified: false },
		});
		return userId;
	}

	test("por acción, por dominio y por actor", async () => {
		await seed();

		expect(
			(await mine("&action=config.updated")).entries.every(
				(entry) => entry.action === "config.updated",
			),
		).toBe(true);

		// Un dominio entero: creación y reversión de ajustes con un solo filtro.
		const payroll = await mine("&domain=payroll_adjustment");
		expect(payroll.entries.length).toBeGreaterThan(0);
		expect(
			payroll.entries.every((entry) =>
				entry.action.startsWith("payroll_adjustment."),
			),
		).toBe(true);

		expect(
			(await auditPage(`?actorId=${managerId}&limit=100`)).entries.every(
				(entry) => entry.actorId === managerId,
			),
		).toBe(true);
	});

	test("por registro concreto, con su propio endpoint", async () => {
		const userId = await seed();
		const [review] = await db
			.select()
			.from(attendanceAbsenceReviews)
			.where(eq(attendanceAbsenceReviews.userId, userId));
		expect(review).toBeDefined();

		const res = await request(
			`/api/audit/resource/attendance_absence_reviews/${review?.id}`,
			{ as: root },
		);
		expect(res.status).toBe(200);
		const page = (await res.json()) as AuditPage;

		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]?.action).toBe("absence.reviewed");
		expect(page.entries[0]?.recordId).toBe(review?.id ?? "");
	});

	test("un rango de fechas que no incluye hoy no devuelve lo de hoy", async () => {
		await seed();
		const old = addDays(TODAY, -400);

		expect(
			(await mine(`&from=${old}&to=${addDays(old, 1)}`)).entries,
		).toHaveLength(0);
		expect(
			(await mine(`&from=${TODAY}&to=${TODAY}`)).entries.length,
		).toBeGreaterThan(0);
	});

	test("el cursor recorre las páginas sin repetir ni saltarse nada", async () => {
		await seed();

		const all = await mine("&limit=100");
		expect(all.entries.length).toBeGreaterThan(2);
		expect(all.nextCursor).toBeNull();

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 20; page += 1) {
			const current: AuditPage = await mine(
				`&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			seen.push(...current.entries.map((entry) => entry.id));
			cursor = current.nextCursor;
			if (!cursor) break;
		}

		expect(seen).toEqual(all.entries.map((entry) => entry.id));
		expect(new Set(seen).size).toBe(seen.length);
	});

	test("un cursor con basura dentro es un 400, no una página rara", async () => {
		expect(
			(await request("/api/audit?cursor=pura-basura", { as: root })).status,
		).toBe(400);
	});
});
