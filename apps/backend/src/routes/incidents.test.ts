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
 * Pruebas de incidencias (spec 12 §8) contra la base de desarrollo.
 *
 * Lo que sólo se puede probar con la base delante: la autorización por endpoint
 * y el **ámbito** de la bandeja (RN-12.6, incluidos los departamentos
 * adicionales), RN-12.5 —que vive en un índice único parcial y no en una
 * comprobación previa—, el plazo configurable de RN-12.4, la irreversibilidad
 * de RN-12.8, las notificaciones de RN-12.10 y, sobre todo, el criterio de
 * aceptación que dice que **aprobar no altera ningún marcaje** (RN-12.9): eso no
 * se demuestra leyendo el código, se demuestra contando filas antes y después.
 *
 * Las reglas puras (motivo por tipo, fechas admitidas, asimetría del rechazo) se
 * prueban en `services/incident-rules.test.ts`.
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
	attendanceIncidents,
	attendanceMarks,
	auditLog,
	departments,
	notifications,
	profiles,
	userDepartmentResponsibilities,
	workLocations,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-inc-${crypto.randomUUID().slice(0, 8)}`;

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
/** En otro departamento: fuera del ámbito propio de `head`. */
const outsider = testUser("outsider", ["employee"]);
/** Jefe cuyo **propio** departamento es el del equipo — ámbito por RN-03.2. */
const head = testUser("head", ["department_head"]);
/**
 * Jefe cuyo propio departamento es el ajeno, con responsabilidad **adicional**
 * sobre el del equipo (spec 03 §3): el caso que el criterio de aceptación de la
 * §8 pide comprobar ("incluidos departamentos adicionales asignados") y el único
 * jefe al que `additionalHeadsOf` puede avisar por notificación.
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

const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);
const YESTERDAY = addDays(TODAY, -1);

const CENTER = { latitude: 23.1136, longitude: -82.3666 };

let departmentId = "";
let otherDepartmentId = "";
let locationId = "";
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

type Incident = {
	id: string;
	userId: string;
	userFullName: string;
	userEmail: string;
	departmentId: string | null;
	departmentName: string | null;
	incidentType: string;
	date: string;
	reason: string;
	status: "pending" | "approved" | "rejected";
	managerNotes: string | null;
	attendanceMarkId: string | null;
	reviewedBy: string | null;
	reviewedAt: string | null;
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

async function setConfigKeys(patch: Record<string, unknown>) {
	const res = await request("/api/config", {
		as: manager,
		method: "PATCH",
		body: patch,
	});
	expect(res.status).toBe(200);
	invalidateConfigCache();
}

type ReportInput = {
	incidentType?: string;
	date?: string;
	reason?: string;
	attendanceMarkId?: string | null;
};

function report(who: TestUser, input: ReportInput = {}) {
	return request("/api/incidents", {
		as: who,
		method: "POST",
		body: {
			incidentType: "forgot_to_mark",
			date: YESTERDAY,
			reason: "Se me quedó el teléfono en casa.",
			...input,
		},
	});
}

async function reported(who: TestUser, input: ReportInput = {}) {
	const res = await report(who, input);
	expect(res.status).toBe(201);
	return (await res.json()) as Incident;
}

async function list(who: TestUser, query = ""): Promise<Incident[]> {
	const res = await request(`/api/incidents${query}`, { as: who });
	expect(res.status).toBe(200);
	return (await res.json()) as Incident[];
}

async function pendingCount(who: TestUser, scope = "own"): Promise<number> {
	const res = await request(`/api/incidents/pending-count?scope=${scope}`, {
		as: who,
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { count: number }).count;
}

/**
 * Un intento de marcaje **rechazado** (RN-09.8) sembrado directo en la base: es
 * la evidencia que RN-12.2 enlaza. Sembrarlo es más fiable que provocarlo por la
 * API, que exigiría dejar la geocerca o el horario en un estado concreto para
 * cada motivo.
 */
async function seedBlockedMark(
	who: TestUser,
	workDate: string,
	blockReason = "OUTSIDE_GEOFENCE",
): Promise<string> {
	const [row] = await db
		.insert(attendanceMarks)
		.values({
			userId: await profileIdOf(who),
			markType: "IN",
			markedAt: new Date(`${workDate}T12:00:00.000Z`),
			workDate,
			latitude: CENTER.latitude,
			longitude: CENTER.longitude,
			accuracy: 10,
			blocked: true,
			blockReason,
		})
		.returning({ id: attendanceMarks.id });
	if (!row) throw new Error("No se pudo sembrar el marcaje bloqueado");
	return row.id;
}

async function clearIncidentRows() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length === 0) return;
	await db
		.delete(attendanceIncidents)
		.where(inArray(attendanceIncidents.userId, ids));
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

	// La zona del horario es la que fija el "hoy" contra el que se miden RN-12.3
	// y RN-12.4 (`todayForDepartment`): en UTC coincide con el `TODAY` de estas
	// pruebas.
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

	await request(`/api/departments/${departmentId}/calendar`, {
		as: manager,
		method: "PUT",
		body: {
			entries: [
				{ date: TODAY, isWorkday: true, lateToleranceMinutes: 240 },
				{ date: YESTERDAY, isWorkday: true, lateToleranceMinutes: 240 },
			],
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
	await clearIncidentRows();
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
			.delete(attendanceIncidents)
			.where(inArray(attendanceIncidents.userId, ids));
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

describe("autorización (spec 12 §7)", () => {
	test("sin sesión, los endpoints responden 401", async () => {
		expect((await request("/api/incidents")).status).toBe(401);
		expect((await request("/api/incidents/pending-count")).status).toBe(401);
		expect(
			(
				await request("/api/incidents", {
					method: "POST",
					body: { incidentType: "gps_issue", date: TODAY },
				})
			).status,
		).toBe(401);
	});

	test("un empleado no accede a la bandeja de gestión ni a su conteo", async () => {
		expect(
			(await request("/api/incidents?scope=managed", { as: employee })).status,
		).toBe(403);
		expect(
			(
				await request("/api/incidents/pending-count?scope=managed", {
					as: employee,
				})
			).status,
		).toBe(403);
	});

	test("una incidencia se crea siempre a nombre de quien la reporta (§8)", async () => {
		// No hay campo de persona en el cuerpo; enviarlo no cambia el dueño.
		const res = await request("/api/incidents", {
			as: employee,
			method: "POST",
			body: {
				incidentType: "gps_issue",
				date: TODAY,
				userId: await profileIdOf(mate),
			},
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as Incident).userId).toBe(
			await profileIdOf(employee),
		);

		// Y no aparece entre las de la otra persona.
		expect(await list(mate)).toHaveLength(0);
	});

	test("la lista propia trae persona, correo y departamento resueltos (§6)", async () => {
		await reported(employee, { incidentType: "gps_issue", reason: "" });
		const [item] = await list(employee);
		expect(item?.userEmail).toBe(`${employee.identityUserId}@test.local`);
		expect(item?.departmentId).toBe(departmentId);
		expect(item?.departmentName).toBe(name("equipo"));
	});
});

describe("RN-12.1 — motivo obligatorio en los tipos críticos", () => {
	test("un tipo crítico sin motivo se rechaza con 400 (§8)", async () => {
		const res = await request("/api/incidents", {
			as: employee,
			method: "POST",
			body: { incidentType: "forgot_to_mark", date: YESTERDAY },
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"expliques qué pasó",
		);
	});

	test("un tipo técnico sin motivo pasa: el sistema ya tiene la evidencia", async () => {
		const created = await reported(employee, {
			incidentType: "geofence_issue",
			reason: "",
		});
		expect(created.reason).toBe("");
		expect(created.status).toBe("pending");
	});
});

describe("RN-12.3 y RN-12.4 — fechas admitidas y plazo", () => {
	test("hoy se admite y mañana no", async () => {
		expect((await report(employee, { date: TODAY })).status).toBe(201);

		const future = await report(employee, { date: addDays(TODAY, 1) });
		expect(future.status).toBe(400);
		expect(((await future.json()) as { error: string }).error).toContain(
			"ya pasó",
		);
	});

	test("sin plazo configurado, una fecha muy vieja se admite", async () => {
		expect(
			(await report(employee, { date: addDays(TODAY, -200) })).status,
		).toBe(201);
	});

	test("con plazo de 7 días, un día de hace un mes se rechaza", async () => {
		await setConfigKeys({ incident_report_window_days: 7 });

		const res = await report(employee, { date: addDays(TODAY, -30) });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("plazo");

		// Y dentro del plazo sigue entrando.
		expect((await report(employee, { date: addDays(TODAY, -3) })).status).toBe(
			201,
		);
	});

	test("el plazo llega a la interfaz por la configuración pública", async () => {
		await setConfigKeys({ incident_report_window_days: 5 });
		const res = await request("/api/config/public", { as: employee });
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { incident_report_window_days: number })
				.incident_report_window_days,
		).toBe(5);
	});
});

describe("RN-12.5 — una por día y tipo mientras esté pendiente", () => {
	test("el duplicado pendiente se rechaza con 409", async () => {
		await reported(employee);

		const again = await report(employee);
		expect(again.status).toBe(409);
		expect(((await again.json()) as { error: string }).error).toContain(
			"pendiente",
		);
	});

	test("otro tipo el mismo día sí entra", async () => {
		await reported(employee);
		expect(
			(
				await report(employee, {
					incidentType: "late_arrival",
					reason: "Guagua.",
				})
			).status,
		).toBe(201);
	});

	test("una vez revisada se puede reportar otra igual (RN-12.8)", async () => {
		const first = await reported(employee);
		expect(
			(
				await request(`/api/incidents/${first.id}/review`, {
					as: head,
					method: "POST",
					body: { approved: true },
				})
			).status,
		).toBe(200);

		expect((await report(employee)).status).toBe(201);
	});
});

describe("RN-12.2 — el marcaje enlazado", () => {
	test("se enlaza el intento rechazado del mismo día", async () => {
		const markId = await seedBlockedMark(employee, YESTERDAY);
		const created = await reported(employee, {
			incidentType: "geofence_issue",
			reason: "",
			attendanceMarkId: markId,
		});
		expect(created.attendanceMarkId).toBe(markId);
	});

	test("un marcaje de otra persona no se distingue de uno que no existe", async () => {
		const markId = await seedBlockedMark(mate, YESTERDAY);
		const res = await report(employee, { attendanceMarkId: markId });
		expect(res.status).toBe(404);
	});

	test("un marcaje de otro día se rechaza por incoherente", async () => {
		const markId = await seedBlockedMark(employee, addDays(TODAY, -5));
		const res = await report(employee, {
			date: YESTERDAY,
			attendanceMarkId: markId,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"no pertenece al día",
		);
	});
});

describe("RN-12.6 y RN-12.7 — la revisión", () => {
	test("el jefe del ámbito aprueba, y queda quién y cuándo", async () => {
		const created = await reported(employee);
		const res = await request(`/api/incidents/${created.id}/review`, {
			as: head,
			method: "POST",
			body: {
				approved: true,
				notes: "Confirmado con el registro de la puerta.",
			},
		});
		expect(res.status).toBe(200);

		// La respuesta trae la incidencia **y** el efecto sobre la ausencia del día
		// (spec 12 §9 decisión 1, cerrada con la spec 13): nulo si no se pidió.
		const body = (await res.json()) as {
			incident: Incident;
			absence: unknown | null;
		};
		expect(body.absence).toBeNull();

		const reviewed = body.incident;
		expect(reviewed.status).toBe("approved");
		expect(reviewed.managerNotes).toContain("registro de la puerta");
		expect(reviewed.reviewedBy).toBe(await profileIdOf(head));
		expect(reviewed.reviewedAt).not.toBeNull();
	});

	test("rechazar sin notas falla (§8)", async () => {
		const created = await reported(employee);
		const res = await request(`/api/incidents/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: false },
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("notas");
	});

	test("nadie revisa la suya propia, ni siquiera un jefe", async () => {
		const own = await reported(head);
		const res = await request(`/api/incidents/${own.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toContain(
			"tu propia incidencia",
		);
	});

	test("un jefe no revisa una de fuera de su ámbito, aunque conozca el id", async () => {
		const created = await reported(outsider);
		const res = await request(`/api/incidents/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});
		expect(res.status).toBe(403);
	});

	test("un empleado no revisa la de un compañero", async () => {
		const created = await reported(mate);
		expect(
			(
				await request(`/api/incidents/${created.id}/review`, {
					as: employee,
					method: "POST",
					body: { approved: true },
				})
			).status,
		).toBe(403);
	});

	test("RN-12.8 — una revisada no se reabre", async () => {
		const created = await reported(employee);
		expect(
			(
				await request(`/api/incidents/${created.id}/review`, {
					as: head,
					method: "POST",
					body: { approved: true },
				})
			).status,
		).toBe(200);

		const again = await request(`/api/incidents/${created.id}/review`, {
			as: manager,
			method: "POST",
			body: { approved: false, notes: "Me lo repienso." },
		});
		expect(again.status).toBe(409);
		expect(((await again.json()) as { error: string }).error).toContain(
			"no se reabre",
		);
	});
});

describe("la bandeja (§6, RN-03.2)", () => {
	test("un jefe sólo ve las de su ámbito (§8)", async () => {
		await reported(employee);
		await reported(outsider);

		const mine = await list(head, "?scope=managed");
		expect(mine).toHaveLength(1);
		expect(mine[0]?.userId).toBe(await profileIdOf(employee));
	});

	test("los departamentos adicionales cuentan como ámbito (§8)", async () => {
		await reported(employee);
		await reported(outsider);

		// El propio de `additionalHead` es el ajeno y el añadido es el del equipo:
		// ve las dos.
		const both = await list(additionalHead, "?scope=managed");
		expect(both).toHaveLength(2);
	});

	test("un gestor global ve todo su ámbito y puede acotarlo por departamento", async () => {
		await reported(employee);
		await reported(outsider);

		expect(
			(await list(manager, "?scope=managed")).filter((item) =>
				[departmentId, otherDepartmentId].includes(item.departmentId ?? ""),
			),
		).toHaveLength(2);

		const only = await list(
			manager,
			`?scope=managed&departmentId=${otherDepartmentId}`,
		);
		expect(only).toHaveLength(1);
		expect(only[0]?.userId).toBe(await profileIdOf(outsider));
	});

	test("un jefe no puede acotar a un departamento fuera de su ámbito", async () => {
		expect(
			(
				await request(
					`/api/incidents?scope=managed&departmentId=${otherDepartmentId}`,
					{ as: head },
				)
			).status,
		).toBe(403);
	});

	test("ordena pendientes primero y, dentro, por fecha descendente (§8)", async () => {
		const old = await reported(employee, {
			date: addDays(TODAY, -1),
			incidentType: "forgot_to_mark",
		});
		await request(`/api/incidents/${old.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});

		await reported(employee, {
			date: addDays(TODAY, -3),
			incidentType: "late_arrival",
			reason: "Guagua.",
		});
		await reported(employee, {
			date: addDays(TODAY, -2),
			incidentType: "gps_issue",
			reason: "",
		});

		const tray = await list(head, "?scope=managed");
		expect(tray.map((item) => [item.status, item.date])).toEqual([
			["pending", addDays(TODAY, -2)],
			["pending", addDays(TODAY, -3)],
			["approved", addDays(TODAY, -1)],
		]);
	});

	test("filtra por estado, por tipo y por texto (§6)", async () => {
		await reported(employee, { incidentType: "gps_issue", reason: "" });
		await reported(outsider, {
			incidentType: "late_arrival",
			reason: "Tarde.",
		});

		expect(
			await list(manager, "?scope=managed&incidentType=gps_issue"),
		).toHaveLength(1);
		expect(
			(await list(manager, "?scope=managed&status=pending")).length,
		).toBeGreaterThanOrEqual(2);

		// Por nombre de la persona…
		const byName = await list(
			manager,
			`?scope=managed&search=${encodeURIComponent(employee.identityUserId)}`,
		);
		expect(byName).toHaveLength(1);

		// …y por nombre del departamento.
		const byDepartment = await list(
			manager,
			`?scope=managed&search=${encodeURIComponent(name("ajeno"))}`,
		);
		expect(byDepartment).toHaveLength(1);
		expect(byDepartment[0]?.userId).toBe(await profileIdOf(outsider));
	});
});

describe("pending-count (§7, el badge de RN-05.8)", () => {
	test("propias: cuenta sólo las sin revisar", async () => {
		const first = await reported(employee);
		await reported(employee, {
			incidentType: "gps_issue",
			date: addDays(TODAY, -2),
			reason: "",
		});
		expect(await pendingCount(employee)).toBe(2);

		await request(`/api/incidents/${first.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});
		expect(await pendingCount(employee)).toBe(1);
	});

	test("de gestión: cuenta el ámbito, no la plantilla entera", async () => {
		await reported(employee);
		await reported(outsider);

		expect(await pendingCount(head, "managed")).toBe(1);
		expect(await pendingCount(additionalHead, "managed")).toBe(2);
	});
});

describe("RN-12.10 — notificaciones", () => {
	test("reportar avisa al jefe localizable; revisar avisa a quien reportó (§8)", async () => {
		const created = await reported(employee);

		const toHead = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, await profileIdOf(additionalHead)));
		expect(toHead.some((row) => row.type === "incident.reported")).toBe(true);

		await request(`/api/incidents/${created.id}/review`, {
			as: head,
			method: "POST",
			body: { approved: true },
		});

		const toEmployee = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, await profileIdOf(employee)));
		const reviewed = toEmployee.find((row) => row.type === "incident.reviewed");
		expect(reviewed).toBeDefined();
		// El cuerpo dice explícitamente que el marcaje no cambia (RN-12.9): sin eso,
		// "aprobada" se lee como "ya está arreglado".
		expect(reviewed?.body).toContain("tu marcaje no cambia");
	});
});

describe("RN-12.9 — aprobar no altera ningún marcaje (§8)", () => {
	test("ni crea, ni edita, ni borra filas de attendance_marks", async () => {
		const employeeId = await profileIdOf(employee);
		const markId = await seedBlockedMark(employee, YESTERDAY);

		const before = await db
			.select()
			.from(attendanceMarks)
			.where(eq(attendanceMarks.userId, employeeId));

		const created = await reported(employee, {
			incidentType: "forgot_to_mark",
			date: YESTERDAY,
			attendanceMarkId: markId,
		});
		expect(
			(
				await request(`/api/incidents/${created.id}/review`, {
					as: head,
					method: "POST",
					body: { approved: true },
				})
			).status,
		).toBe(200);

		const after = await db
			.select()
			.from(attendanceMarks)
			.where(eq(attendanceMarks.userId, employeeId));

		expect(after).toEqual(before);
	});
});

describe("intentos rechazados propios (RN-12.2, la materia prima)", () => {
	test("devuelve los del día pedido, y sólo los propios", async () => {
		const markId = await seedBlockedMark(employee, YESTERDAY);
		await seedBlockedMark(mate, YESTERDAY);

		const res = await request(
			`/api/incidents/blocked-marks?date=${YESTERDAY}`,
			{
				as: employee,
			},
		);
		expect(res.status).toBe(200);
		const marks = (await res.json()) as { id: string }[];
		expect(marks.map((mark) => mark.id)).toEqual([markId]);

		// Otro día no trae nada.
		const other = await request(
			`/api/incidents/blocked-marks?date=${addDays(TODAY, -9)}`,
			{ as: employee },
		);
		expect((await other.json()) as unknown[]).toHaveLength(0);
	});

	test("sin fecha, la consulta no valida", async () => {
		expect(
			(await request("/api/incidents/blocked-marks", { as: employee })).status,
		).toBe(400);
	});
});

describe("contexto de la revisión (§6)", () => {
	test("trae el día clasificado y los intentos rechazados de esa jornada", async () => {
		const markId = await seedBlockedMark(employee, YESTERDAY);
		const created = await reported(employee, {
			incidentType: "geofence_issue",
			reason: "",
			attendanceMarkId: markId,
		});

		const res = await request(`/api/incidents/${created.id}/context`, {
			as: head,
		});
		expect(res.status).toBe(200);

		const context = (await res.json()) as {
			incidentId: string;
			day: { date: string; status: string; marks: unknown[] };
			blockedMarks: { id: string; blockReason: string | null }[];
		};
		expect(context.incidentId).toBe(created.id);
		expect(context.day.date).toBe(YESTERDAY);
		// Sin marcas válidas, ese día laborable sale AUSENTE: es el mismo estado que
		// ve la persona en su historial, que es lo que hace útil el contexto.
		expect(context.day.status).toBe("AUSENTE");
		expect(context.day.marks).toHaveLength(0);
		expect(context.blockedMarks.map((mark) => mark.id)).toEqual([markId]);
		expect(context.blockedMarks[0]?.blockReason).toBe("OUTSIDE_GEOFENCE");
	});

	test("quien reportó también puede ver el contexto de la suya", async () => {
		const created = await reported(employee, {
			incidentType: "gps_issue",
			reason: "",
		});
		expect(
			(await request(`/api/incidents/${created.id}/context`, { as: employee }))
				.status,
		).toBe(200);
	});

	test("un compañero no puede ver el contexto de la incidencia de otro", async () => {
		const created = await reported(mate, {
			incidentType: "gps_issue",
			reason: "",
		});
		expect(
			(await request(`/api/incidents/${created.id}/context`, { as: employee }))
				.status,
		).toBe(403);
	});
});
