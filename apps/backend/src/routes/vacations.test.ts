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
 * Pruebas de vacaciones (spec 11 §8) contra la base de desarrollo.
 *
 * Lo que sólo se puede probar con la base delante: el saldo real (marcas →
 * `earned`, solicitudes → `used`/`pending`), la autorización de la §5 por
 * endpoint, RN-11.7 (sólo a futuro), RN-11.6 (solapamiento), RN-11.8 (nadie
 * revisa la suya), RN-11.10 (cancelación) y, sobre todo, RN-11.1 **bajo
 * concurrencia** — el criterio de aceptación que exige que dos solicitudes
 * simultáneas que juntas exceden el saldo dejen pasar sólo una.
 *
 * La aritmética pura (`computeBalance`, `rangesOverlap`, `countWorkableDays`)
 * se prueba en `services/vacation-rules.test.ts`.
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
	attendanceMarks,
	auditLog,
	departments,
	notifications,
	profiles,
	userDepartmentResponsibilities,
	vacationRequests,
	workLocations,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-vac-${crypto.randomUUID().slice(0, 8)}`;

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
/** En otro departamento: fuera del ámbito de `head`. */
const outsider = testUser("outsider", ["employee"]);
/** Jefe cuyo **propio** departamento es el del equipo — ámbito por RN-03.2. */
const head = testUser("head", ["department_head"]);
/**
 * Jefe cuyo propio departamento es **otro**, con responsabilidad adicional
 * sobre el del equipo (spec 03 §3) — el único tipo de jefe que
 * `additionalHeadsOf` puede avisar por notificación (ver la nota de cabecera
 * de `services/vacations.ts`).
 */
const additionalHead = testUser("additional-head", ["department_head"]);
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

// ── Fechas ancladas a "hoy" (zona UTC del horario de prueba) ──────────────────

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - 86_400_000)
	.toISOString()
	.slice(0, 10);
const addDays = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);

const CENTER = { latitude: 23.1136, longitude: -82.3666 };

let departmentId = "";
let otherDepartmentId = "";
let locationId = "";
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

const markIn = (who: TestUser) =>
	request("/api/attendance/marks", {
		as: who,
		method: "POST",
		body: {
			markType: "IN",
			latitude: CENTER.latitude,
			longitude: CENTER.longitude,
			accuracy: 10,
			workLocationId: locationId,
		},
	});

/**
 * Siembra `count` días **ya trabajados** (aceptados, un `work_date` distinto
 * cada uno) directamente en la base, muy en el pasado para no chocar con
 * ninguna fecha de solicitud de estas pruebas.
 *
 * Con `vacation_days_per_worked_day` en su tope de 1 (spec 06 §3.4), `earned`
 * es exactamente `count` — la tasa se lee **al pedir**, no al marcar
 * (`earnedDays = díasTrabajados × tasa vigente`), así que a rate=1 sembrar N
 * días es la forma directa de dejar a alguien con un saldo conocido, sin pasar
 * por `markIn` una vez por día que se necesite.
 */
async function seedEarnedDays(who: TestUser, count: number): Promise<void> {
	const userId = await profileIdOf(who);
	await db.insert(attendanceMarks).values(
		Array.from({ length: count }, (_, i) => {
			const workDate = addDays(TODAY, -(30 + i));
			return {
				userId,
				markType: "IN" as const,
				// El índice único de antirrebote (spec 09 RN-09.10) es por minuto de
				// `marked_at`, no por `work_date`: sin fijarlo, todas las filas
				// nacerían con el `now()` por defecto y chocarían entre sí.
				markedAt: new Date(`${workDate}T12:00:00.000Z`),
				workDate,
				latitude: CENTER.latitude,
				longitude: CENTER.longitude,
				accuracy: 10,
				blocked: false,
			};
		}),
	);
}

type Balance = {
	userId: string;
	earned: number;
	used: number;
	pending: number;
	available: number;
};

type Request_ = {
	id: string;
	userId: string;
	userFullName: string;
	startDate: string;
	endDate: string;
	requestedDays: number;
	status: "pending" | "approved" | "rejected" | "cancelled";
	reviewComment: string | null;
	cancelledBy: string | null;
};

async function setConfigKeys(patch: Record<string, unknown>) {
	const res = await request("/api/config", {
		as: manager,
		method: "PATCH",
		body: patch,
	});
	expect(res.status).toBe(200);
	invalidateConfigCache();
}

async function myBalance(who: TestUser): Promise<Balance> {
	const res = await request("/api/me/vacations/balance", { as: who });
	expect(res.status).toBe(200);
	return (await res.json()) as Balance;
}

async function clearVacationRows() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length === 0) return;
	await db
		.delete(vacationRequests)
		.where(inArray(vacationRequests.userId, ids));
	await db.delete(attendanceMarks).where(inArray(attendanceMarks.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, mate, outsider, head, additionalHead, manager]) {
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
	await moveTo(mate, departmentId);
	await moveTo(head, departmentId);
	await moveTo(outsider, otherDepartmentId);
	await moveTo(additionalHead, otherDepartmentId);

	// `additionalHead` gestiona el departamento del equipo como responsabilidad
	// **adicional** — la única forma en que este sistema puede saber, sin que se
	// autentique, que es jefe de algo (ver la nota de cabecera del servicio).
	const additionalHeadId = await profileIdOf(additionalHead);
	expect(
		(
			await request(
				`/api/users/${additionalHeadId}/department-responsibilities`,
				{
					as: manager,
					method: "PUT",
					body: { departmentIds: [departmentId] },
				},
			)
		).status,
	).toBe(200);

	expect(
		(
			await request(`/api/departments/${departmentId}/schedule`, {
				as: manager,
				method: "PUT",
				body: windowAroundNow(),
			})
		).status,
	).toBe(200);

	await request(`/api/departments/${departmentId}/calendar`, {
		as: manager,
		method: "PUT",
		body: {
			entries: [{ date: TODAY, isWorkday: true, lateToleranceMinutes: 240 }],
		},
	});

	const location = await request("/api/work-locations", {
		as: manager,
		method: "POST",
		body: {
			name: name("sede"),
			centerLat: CENTER.latitude,
			centerLng: CENTER.longitude,
			radiusMeters: 100,
			accuracyThreshold: 100,
			blockOnPoorAccuracy: false,
		},
	});
	expect(location.status).toBe(201);
	locationId = ((await location.json()) as { id: string }).id;

	for (const who of [employee, mate]) {
		expect(
			(
				await request("/api/me/work-location", {
					as: who,
					method: "PUT",
					body: { workLocationId: locationId },
				})
			).status,
		).toBe(200);
	}
});

afterEach(async () => {
	await clearVacationRows();
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
		await db
			.delete(vacationRequests)
			.where(inArray(vacationRequests.userId, ids));
		await db
			.delete(attendanceMarks)
			.where(inArray(attendanceMarks.userId, ids));
		await db.delete(notifications).where(inArray(notifications.userId, ids));
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
	await db.delete(workLocations).where(like(workLocations.name, `${TAG}%`));
	await db.delete(departments).where(like(departments.name, `${TAG}%`));

	await db.delete(appConfig);
	for (const row of savedConfig) await db.insert(appConfig).values(row);
	invalidateConfigCache();
});

describe("autorización (spec 11 §5)", () => {
	test("sin sesión, los endpoints responden 401", async () => {
		expect((await request("/api/me/vacations/balance")).status).toBe(401);
		expect((await request("/api/vacations/requests")).status).toBe(401);
		expect(
			(
				await request("/api/vacations/requests", {
					method: "POST",
					body: { startDate: TODAY, endDate: TODAY },
				})
			).status,
		).toBe(401);
	});

	test("un empleado no ve el saldo de otro ni la bandeja de gestión", async () => {
		const mateId = await profileIdOf(mate);
		expect(
			(
				await request(`/api/users/${mateId}/vacations/balance`, {
					as: employee,
				})
			).status,
		).toBe(403);
		expect(
			(
				await request("/api/vacations/requests?scope=managed", {
					as: employee,
				})
			).status,
		).toBe(403);
	});

	test("un jefe no ve el saldo de alguien fuera de su ámbito (RN-03.2)", async () => {
		const outsiderId = await profileIdOf(outsider);
		expect(
			(
				await request(`/api/users/${outsiderId}/vacations/balance`, {
					as: head,
				})
			).status,
		).toBe(403);
	});

	test("un jefe sí ve el saldo de su ámbito", async () => {
		const employeeId = await profileIdOf(employee);
		expect(
			(
				await request(`/api/users/${employeeId}/vacations/balance`, {
					as: head,
				})
			).status,
		).toBe(200);
	});
});

describe("saldo (§2)", () => {
	test("sin marcas ni tasa, el saldo es cero", async () => {
		const balance = await myBalance(employee);
		expect(balance).toEqual({
			userId: await profileIdOf(employee),
			earned: 0,
			used: 0,
			pending: 0,
			available: 0,
		});
	});

	test("un día trabajado con tasa 1 gana un día (RN-11.4)", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });

		const mark = await markIn(employee);
		expect(((await mark.json()) as { accepted: boolean }).accepted).toBe(true);

		const balance = await myBalance(employee);
		expect(balance.earned).toBe(1);
		expect(balance.available).toBe(1);
	});

	test("una solicitud pendiente reduce el disponible; el gestor global no acumula", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await markIn(employee);

		const res = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: addDays(TODAY, 10), endDate: addDays(TODAY, 10) },
		});
		expect(res.status).toBe(201);

		const balance = await myBalance(employee);
		expect(balance.pending).toBe(1);
		expect(balance.available).toBe(0);

		// RN-03.4: `global_manager` no marca, así que su saldo es siempre cero, y
		// el servicio lo rechaza antes de escribir nada.
		const managerAttempt = await request("/api/vacations/requests", {
			as: manager,
			method: "POST",
			body: { startDate: addDays(TODAY, 20), endDate: addDays(TODAY, 20) },
		});
		expect(managerAttempt.status).toBe(403);
	});
});

describe("RN-11.5 — sólo los días laborables consumen saldo", () => {
	test("un rango de un fin de semana no laborable no se puede pedir (0 días)", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await markIn(employee);

		// Dos días consecutivos marcados explícitamente como no laborables: pase lo
		// que pase con el día de la semana, el rango completo consume 0.
		const from = addDays(TODAY, 30);
		const to = addDays(TODAY, 31);
		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [
					{ date: from, isWorkday: false, lateToleranceMinutes: null },
					{ date: to, isWorkday: false, lateToleranceMinutes: null },
				],
			},
		});

		const res = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: from, endDate: to },
		});
		expect(res.status).toBe(400);
	});

	test("requested_days cuenta sólo los laborables del rango, congelado al crear", async () => {
		// earned = 1 con un solo marcaje: alcanza exactamente para un rango de dos
		// días donde uno es no laborable — si `requested_days` contara los dos, la
		// solicitud fallaría por saldo, y si el saldo se recalculara después de
		// aprobada no habría forma de distinguir "1" congelado de "2" recalculado.
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await markIn(employee);

		const notWorkable = addDays(TODAY, 40);
		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [
					{ date: notWorkable, isWorkday: false, lateToleranceMinutes: null },
				],
			},
		});

		const from = addDays(TODAY, 39);
		const to = addDays(TODAY, 40);
		const res = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: from, endDate: to },
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as Request_).requestedDays).toBe(1);
	});
});

describe("RN-11.6 — sin solapamiento", () => {
	test("dos solicitudes solapadas: la segunda falla", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 6);

		const first = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: addDays(TODAY, 50), endDate: addDays(TODAY, 55) },
		});
		expect(first.status).toBe(201);

		const second = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: addDays(TODAY, 53), endDate: addDays(TODAY, 58) },
		});
		expect(second.status).toBe(409);
	});

	test("una de otra persona en las mismas fechas no molesta", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 3);
		await seedEarnedDays(mate, 3);

		const first = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: addDays(TODAY, 50), endDate: addDays(TODAY, 52) },
		});
		expect(first.status).toBe(201);

		const second = await request("/api/vacations/requests", {
			as: mate,
			method: "POST",
			body: { startDate: addDays(TODAY, 50), endDate: addDays(TODAY, 52) },
		});
		expect(second.status).toBe(201);
	});
});

describe("RN-11.7 — sólo a futuro, sin excepción de rol", () => {
	test("un empleado no puede pedir desde ayer", async () => {
		// RN-11.7 se comprueba antes que el saldo, así que no hace falta sembrar
		// ninguno para que esto falle por fecha.
		const res = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: YESTERDAY, endDate: TODAY },
		});
		expect(res.status).toBe(400);
	});

	/**
	 * A diferencia de los descansos (RN-10.7 sí exime al rol administrativo),
	 * aquí no hay excepción: una regularización hacia atrás es una incidencia
	 * (spec 12), no un cambio de fecha. `department_head` marca y solicita como
	 * cualquiera, así que sirve para probarlo — `global_manager`, el único rol
	 * "administrativo" de RN-11.10, no llega ni a esta comprobación: lo detiene
	 * antes `roleCanMark` (ver "una solicitud pendiente…" en §2), así que no hay
	 * ningún rol de este sistema que pueda saltarse RN-11.7.
	 */
	test("un department_head tampoco puede pedir desde ayer", async () => {
		// RN-11.7 se comprueba antes que el saldo (ver el orden en
		// `requestVacation`), así que ni hace falta que `head` tenga días
		// ganados para que esto falle por fecha.
		const res = await request("/api/vacations/requests", {
			as: head,
			method: "POST",
			body: { startDate: YESTERDAY, endDate: TODAY },
		});
		expect(res.status).toBe(400);
	});
});

describe("RN-11.10 — cancelación", () => {
	async function createRequest(who: TestUser, from: string, to: string) {
		const res = await request("/api/vacations/requests", {
			as: who,
			method: "POST",
			body: { startDate: from, endDate: to },
		});
		expect(res.status).toBe(201);
		return (await res.json()) as Request_;
	}

	test("pendiente: el propio solicitante la cancela", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(
			employee,
			addDays(TODAY, 60),
			addDays(TODAY, 61),
		);

		const res = await request(`/api/vacations/requests/${created.id}/cancel`, {
			as: employee,
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as Request_).status).toBe("cancelled");

		const balance = await myBalance(employee);
		expect(balance.pending).toBe(0);
	});

	test("aprobada y a futuro: el solicitante también puede", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(
			employee,
			addDays(TODAY, 60),
			addDays(TODAY, 61),
		);
		await request(`/api/vacations/requests/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});

		const res = await request(`/api/vacations/requests/${created.id}/cancel`, {
			as: employee,
			method: "POST",
		});
		expect(res.status).toBe(200);

		const balance = await myBalance(employee);
		expect(balance.used).toBe(0);
	});

	test("aprobada y ya empezada: el solicitante no puede, un administrativo sí", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(employee, TODAY, addDays(TODAY, 1));
		await request(`/api/vacations/requests/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});

		const denied = await request(
			`/api/vacations/requests/${created.id}/cancel`,
			{ as: employee, method: "POST" },
		);
		expect(denied.status).toBe(403);

		const allowed = await request(
			`/api/vacations/requests/${created.id}/cancel`,
			{ as: manager, method: "POST" },
		);
		expect(allowed.status).toBe(200);
	});

	test("otra persona sin rol administrativo no puede cancelarla", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(
			employee,
			addDays(TODAY, 60),
			addDays(TODAY, 61),
		);

		const res = await request(`/api/vacations/requests/${created.id}/cancel`, {
			as: mate,
			method: "POST",
		});
		expect(res.status).toBe(403);
	});

	test("una ya rechazada no se puede volver a cancelar", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(
			employee,
			addDays(TODAY, 60),
			addDays(TODAY, 61),
		);
		await request(`/api/vacations/requests/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: false, comment: "Sin cobertura esa semana." },
		});

		const res = await request(`/api/vacations/requests/${created.id}/cancel`, {
			as: employee,
			method: "POST",
		});
		expect(res.status).toBe(409);
	});
});

describe("RN-11.8 — revisión", () => {
	async function createRequest(from: string, to: string) {
		const res = await request("/api/vacations/requests", {
			as: employee,
			method: "POST",
			body: { startDate: from, endDate: to },
		});
		expect(res.status).toBe(201);
		return (await res.json()) as Request_;
	}

	test("nadie revisa su propia solicitud", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(addDays(TODAY, 60), addDays(TODAY, 61));

		const res = await request(`/api/vacations/requests/${created.id}/review`, {
			as: employee,
			method: "POST",
			body: { approved: true },
		});
		expect(res.status).toBe(403);
	});

	test("quien no tiene rol de gestión no puede revisar, aunque conozca el id", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(addDays(TODAY, 60), addDays(TODAY, 61));

		// `outsider` es `employee`: `canManage` rechaza antes incluso de mirar a
		// qué departamento pertenece, porque `hasScope` exige `department_head` o
		// más (RN-03.2). El ámbito **entre** jefes ya lo prueba "un jefe sí ve el
		// saldo de su ámbito" / "no ve el de otro" para descansos y usuarios; aquí
		// no hace falta repetirlo con un segundo jefe de mentira.
		const res = await request(`/api/vacations/requests/${created.id}/review`, {
			as: outsider,
			method: "POST",
			body: { approved: true },
		});
		expect(res.status).toBe(403);
	});

	test("rechazar exige comentario (RN-11.10 en su asimetría)", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(addDays(TODAY, 60), addDays(TODAY, 61));

		const res = await request(`/api/vacations/requests/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: false },
		});
		expect(res.status).toBe(400);
	});

	test("aprobar bloquea el marcaje de hoy (RN-11.9, la costura con la spec 09)", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });

		// `mate` necesita saldo ganado **antes** de hoy para poder pedir hoy libre
		// sin haber marcado todavía hoy — si marcara hoy primero, ya no serviría
		// para probar que el marcaje de hoy queda bloqueado.
		await seedEarnedDays(mate, 1);

		const res = await request("/api/vacations/requests", {
			as: mate,
			method: "POST",
			body: { startDate: TODAY, endDate: TODAY },
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as Request_;

		const reviewed = await request(
			`/api/vacations/requests/${created.id}/review`,
			{ as: head, method: "POST", body: { approved: true } },
		);
		expect(reviewed.status).toBe(200);

		const status = await request("/api/attendance/status", { as: mate });
		const statusBody = (await status.json()) as {
			canCheckIn: boolean;
			reason: string | null;
		};
		expect(statusBody.canCheckIn).toBe(false);
		expect(statusBody.reason).toBe("ON_VACATION");

		const attempt = await markIn(mate);
		const attemptBody = (await attempt.json()) as {
			accepted: boolean;
			reason: string | null;
		};
		expect(attemptBody.accepted).toBe(false);
		expect(attemptBody.reason).toBe("ON_VACATION");
	});

	test("un jefe con responsabilidad adicional recibe el aviso al crear (§5.1)", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		await createRequest(addDays(TODAY, 60), addDays(TODAY, 61));

		const rows = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, await profileIdOf(additionalHead)));
		expect(rows.some((row) => row.type === "vacation.requested")).toBe(true);
	});

	test("aprobar y rechazar notifican al solicitante", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(employee, 2);
		const created = await createRequest(addDays(TODAY, 60), addDays(TODAY, 61));

		await request(`/api/vacations/requests/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});

		const rows = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, await profileIdOf(employee)));
		expect(rows.some((row) => row.type === "vacation.reviewed")).toBe(true);
	});
});

describe("clasificación del día (RN-11.12, la costura con la spec 15)", () => {
	test("un día aprobado sale VACACIONES, no AUSENTE", async () => {
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await seedEarnedDays(mate, 1);

		const from = addDays(TODAY, 70);
		const created = await request("/api/vacations/requests", {
			as: mate,
			method: "POST",
			body: { startDate: from, endDate: from },
		});
		expect(created.status).toBe(201);
		const id = ((await created.json()) as Request_).id;

		await request(`/api/vacations/requests/${id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});

		const res = await request(`/api/attendance/me?from=${from}&to=${from}`, {
			as: mate,
		});
		const days = (await res.json()) as { date: string; status: string }[];
		expect(days[0]?.status).toBe("VACACIONES");
	});
});

describe("RN-11.1 bajo concurrencia (criterio de aceptación de la §8)", () => {
	test("dos solicitudes simultáneas que juntas exceden el saldo: sólo una pasa", async () => {
		// earned = 1: exactamente el saldo para una de las dos solicitudes, cada
		// una de un solo día laborable, en fechas que no se solapan entre sí.
		await setConfigKeys({ vacation_days_per_worked_day: 1 });
		await markIn(employee);

		const bodyA = {
			startDate: addDays(TODAY, 80),
			endDate: addDays(TODAY, 80),
		};
		const bodyB = {
			startDate: addDays(TODAY, 81),
			endDate: addDays(TODAY, 81),
		};

		const [first, second] = await Promise.all([
			request("/api/vacations/requests", {
				as: employee,
				method: "POST",
				body: bodyA,
			}),
			request("/api/vacations/requests", {
				as: employee,
				method: "POST",
				body: bodyB,
			}),
		]);

		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([201, 409]);

		const balance = await myBalance(employee);
		expect(balance.pending).toBe(1);
		expect(balance.available).toBe(0);
	});
});
