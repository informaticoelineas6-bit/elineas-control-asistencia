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
 * Pruebas de descansos (spec 10 §8) contra la base de desarrollo.
 *
 * Aquí sólo lo que necesita la base delante: que las reglas estén **conectadas**
 * —el marcaje rechaza con `REST_DAY`, el historial clasifica `DESCANSO`—, que la
 * autorización de la §4 se cumpla endpoint por endpoint, y que las validaciones de
 * RN-10.5, RN-10.6 y RN-10.7 las aplique el servidor y no sólo la interfaz.
 *
 * La resolución en sí (RN-10.1, RN-10.2, RN-10.3) se prueba en
 * `services/rest-rules.test.ts`, que es puro y exhaustivo.
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
	restGroupMembers,
	restGroups,
	userRestSchedule,
	workLocations,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");
const { remindMissingRestSchedule } = await import(
	"#/services/rest-schedules.ts"
);

const app = createApp();
const TAG = `zz-rest-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
/** En el mismo departamento, para probar el ámbito y los grupos. */
const mate = testUser("mate", ["employee"]);
/** En otro departamento: es quien tiene que quedar fuera del ámbito del jefe. */
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

// ── Fechas ancladas a "hoy" ───────────────────────────────────────────────────
//
// El horario de prueba usa la zona `UTC`, así que "hoy en el departamento" es hoy
// en UTC. Los descansos se calculan sobre el día de la semana, y el día en que se
// ejecuten las pruebas no es una constante: todo lo que dependa del calendario se
// deriva de aquí.

const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_DOW = new Date(`${TODAY}T00:00:00.000Z`).getUTCDay();
const TOMORROW_DOW = (TODAY_DOW + 1) % 7;
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - 86_400_000)
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

/** Ventana horaria amplia alrededor de la hora actual, en UTC. */
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

type RestView = {
	resolved: {
		date: string;
		daysOfWeek: number[];
		source: string;
		effectiveFrom: string | null;
		group: { id: string; name: string } | null;
		restGroupsEnabled: boolean;
		isRestDay: boolean;
	};
	schedules: { daysOfWeek: number[]; effectiveFrom: string }[];
	limits: { minSeparationDays: number; minPerWeek: number; maxPerWeek: number };
	canEdit: boolean;
	canBackdate: boolean;
	today: string;
};

type RestGroupResponse = {
	id: string;
	name: string;
	daysOfWeek: number[];
	isActive: boolean;
	members: { userId: string; fullName: string; effectiveFrom: string }[];
};

const putMine = (who: TestUser, body: unknown) =>
	request("/api/me/rest-schedule", { as: who, method: "PUT", body });

async function setConfigKeys(patch: Record<string, unknown>) {
	const res = await request("/api/config", {
		as: manager,
		method: "PATCH",
		body: patch,
	});
	expect(res.status).toBe(200);
	invalidateConfigCache();
}

async function restGroupsEnabled(enabled: boolean) {
	const res = await request(`/api/departments/${departmentId}`, {
		as: manager,
		method: "PATCH",
		body: { restGroupsEnabled: enabled },
	});
	expect(res.status).toBe(200);
}

async function clearRestRows() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length === 0) return;
	await db
		.delete(restGroupMembers)
		.where(inArray(restGroupMembers.userId, ids));
	await db
		.delete(userRestSchedule)
		.where(inArray(userRestSchedule.userId, ids));
	await db.delete(attendanceMarks).where(inArray(attendanceMarks.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
	await db
		.delete(restGroups)
		.where(inArray(restGroups.departmentId, [departmentId, otherDepartmentId]));
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
		body: { name: name("turnos") },
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

	expect(
		(
			await request(`/api/departments/${departmentId}/schedule`, {
				as: manager,
				method: "PUT",
				body: windowAroundNow(),
			})
		).status,
	).toBe(200);

	// Tolerancia generosa: la tardanza no es lo que se prueba aquí y no debe
	// depender del valor global que tenga la base de desarrollo.
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
	await clearRestRows();
	await restGroupsEnabled(false);
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
			.delete(restGroupMembers)
			.where(inArray(restGroupMembers.userId, ids));
		await db
			.delete(userRestSchedule)
			.where(inArray(userRestSchedule.userId, ids));
		await db
			.delete(attendanceMarks)
			.where(inArray(attendanceMarks.userId, ids));
		await db.delete(notifications).where(inArray(notifications.userId, ids));
		await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
		await db
			.update(profiles)
			.set({ departmentId: null, selectedWorkLocationId: null })
			.where(inArray(profiles.id, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
	if (departmentIds.length > 0) {
		await db
			.delete(restGroups)
			.where(inArray(restGroups.departmentId, departmentIds));
		await db.delete(auditLog).where(inArray(auditLog.recordId, departmentIds));
	}
	await db.delete(workLocations).where(like(workLocations.name, `${TAG}%`));
	await db.delete(departments).where(like(departments.name, `${TAG}%`));

	await db.delete(appConfig);
	for (const row of savedConfig) await db.insert(appConfig).values(row);
	invalidateConfigCache();
});

describe("autorización (spec 10 §4)", () => {
	test("sin sesión, todos los endpoints responden 401", async () => {
		expect((await request("/api/me/rest-schedule")).status).toBe(401);
		expect(
			(await request(`/api/departments/${departmentId}/rest-groups`)).status,
		).toBe(401);
		expect(
			(
				await request(`/api/departments/${departmentId}/rest-days`, {
					method: "GET",
				})
			).status,
		).toBe(401);
	});

	test("un empleado no lee ni escribe los descansos de otro", async () => {
		const id = await profileIdOf(mate);
		expect(
			(await request(`/api/users/${id}/rest-schedule`, { as: employee }))
				.status,
		).toBe(403);
		expect(
			(
				await request(`/api/users/${id}/rest-schedule`, {
					as: employee,
					method: "PUT",
					body: { daysOfWeek: [0] },
				})
			).status,
		).toBe(403);
	});

	test("un empleado no ve los grupos ni el calendario del departamento", async () => {
		expect(
			(
				await request(`/api/departments/${departmentId}/rest-groups`, {
					as: employee,
				})
			).status,
		).toBe(403);
		expect(
			(
				await request(
					`/api/departments/${departmentId}/rest-days?from=${TODAY}&to=${TODAY}`,
					{ as: employee },
				)
			).status,
		).toBe(403);
	});

	test("un jefe no toca a alguien de otro departamento (RN-03.2)", async () => {
		const id = await profileIdOf(outsider);
		expect(
			(await request(`/api/users/${id}/rest-schedule`, { as: head })).status,
		).toBe(403);
		expect(
			(
				await request(`/api/departments/${otherDepartmentId}/rest-groups`, {
					as: head,
				})
			).status,
		).toBe(403);
	});

	test("un jefe sí gestiona los de su ámbito", async () => {
		const id = await profileIdOf(employee);
		const res = await request(`/api/users/${id}/rest-schedule`, { as: head });
		expect(res.status).toBe(200);

		const saved = await request(`/api/users/${id}/rest-schedule`, {
			as: head,
			method: "PUT",
			body: { daysOfWeek: [TOMORROW_DOW] },
		});
		expect(saved.status).toBe(200);
		expect(((await saved.json()) as RestView).resolved.daysOfWeek).toEqual([
			TOMORROW_DOW,
		]);
	});

	/**
	 * §4: la fila "elegir sus descansos" tiene `—` para el gestor global. No es un
	 * olvido: no marca (RN-03.4), así que no tiene descansos que configurar. Sí
	 * configura los de otros, y eso lo prueba el caso anterior.
	 */
	test("el gestor global no configura sus propios descansos", async () => {
		const res = await putMine(manager, { daysOfWeek: [TOMORROW_DOW] });
		expect(res.status).toBe(403);

		const view = await request("/api/me/rest-schedule", { as: manager });
		expect(((await view.json()) as RestView).canEdit).toBe(false);
	});

	test("crear y editar grupos es de gestor global, no de jefe", async () => {
		expect(
			(
				await request(`/api/departments/${departmentId}/rest-groups`, {
					as: head,
					method: "POST",
					body: { name: "Grupo A", daysOfWeek: [0] },
				})
			).status,
		).toBe(403);
	});
});

describe("configuración individual", () => {
	test("sin filas: ningún descanso y la fuente es 'none' (RN-10.3)", async () => {
		const res = await request("/api/me/rest-schedule", { as: employee });
		expect(res.status).toBe(200);

		const view = (await res.json()) as RestView;
		expect(view.resolved.daysOfWeek).toEqual([]);
		expect(view.resolved.source).toBe("none");
		expect(view.resolved.isRestDay).toBe(false);
		expect(view.canEdit).toBe(true);
		expect(view.today).toBe(TODAY);
	});

	test("guardar sin fecha rige desde hoy y se normaliza el conjunto", async () => {
		const res = await putMine(employee, { daysOfWeek: [3, 0, 3] });
		expect(res.status).toBe(200);

		const view = (await res.json()) as RestView;
		expect(view.resolved.daysOfWeek).toEqual([0, 3]);
		expect(view.resolved.source).toBe("individual");
		expect(view.resolved.effectiveFrom).toBe(TODAY);
		expect(view.schedules).toHaveLength(1);
	});

	test("volver a guardar con la misma fecha no apila una fila más", async () => {
		await putMine(employee, { daysOfWeek: [0] });
		const res = await putMine(employee, { daysOfWeek: [TOMORROW_DOW] });

		const view = (await res.json()) as RestView;
		expect(view.schedules).toHaveLength(1);
		expect(view.resolved.daysOfWeek).toEqual([TOMORROW_DOW]);
	});

	/**
	 * RN-10.1 y el primer criterio de aceptación: una vigencia futura apila una fila
	 * nueva y **no cambia lo que se resuelve hoy**. Es lo que hace que el reporte de
	 * un mes cerrado siga dando el mismo número.
	 */
	test("una vigencia futura no cambia lo vigente hoy (RN-10.1)", async () => {
		await putMine(employee, { daysOfWeek: [TODAY_DOW] });

		const nextMonth = new Date(
			Date.parse(`${TODAY}T00:00:00.000Z`) + 30 * 86_400_000,
		)
			.toISOString()
			.slice(0, 10);
		const res = await putMine(employee, {
			daysOfWeek: [TOMORROW_DOW],
			effectiveFrom: nextMonth,
		});
		expect(res.status).toBe(200);

		const view = (await res.json()) as RestView;
		expect(view.schedules).toHaveLength(2);
		expect(view.resolved.date).toBe(TODAY);
		expect(view.resolved.daysOfWeek).toEqual([TODAY_DOW]);

		// Y pedida para esa fecha futura, la que gana es la nueva.
		const future = await request(`/api/me/rest-schedule?date=${nextMonth}`, {
			as: employee,
		});
		expect(((await future.json()) as RestView).resolved.daysOfWeek).toEqual([
			TOMORROW_DOW,
		]);
	});

	test("RN-10.7 — un empleado no puede fechar hacia atrás", async () => {
		const res = await putMine(employee, {
			daysOfWeek: [TOMORROW_DOW],
			effectiveFrom: YESTERDAY,
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(TODAY);
	});

	test("RN-10.7 — el gestor global sí, y queda marcado en la bitácora", async () => {
		const id = await profileIdOf(employee);
		const res = await request(`/api/users/${id}/rest-schedule`, {
			as: manager,
			method: "PUT",
			body: { daysOfWeek: [TOMORROW_DOW], effectiveFrom: YESTERDAY },
		});
		expect(res.status).toBe(200);

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.actorId, await profileIdOf(manager)));
		const entry = entries.find((row) => row.action === "rest_schedule.updated");
		expect(entry).toBeDefined();
		expect((entry?.metadata as { backdated: boolean }).backdated).toBe(true);
	});
});

describe("RN-10.5 — separación mínima, validada en el servidor", () => {
	test("con la regla activada, dos descansos pegados se rechazan", async () => {
		await setConfigKeys({ rest_days_min_separation: 2 });

		const res = await putMine(employee, { daysOfWeek: [2, 3] });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"separación",
		);
	});

	/**
	 * Decisión 2 de la §9, cerrada: la **lista vacía significa "todos"**. El número
	 * es el interruptor; la lista sólo acota.
	 */
	test("la lista vacía aplica la regla a todos los departamentos", async () => {
		await setConfigKeys({
			rest_days_min_separation: 2,
			rest_days_min_separation_departments: [],
		});

		expect((await putMine(employee, { daysOfWeek: [2, 3] })).status).toBe(400);
	});

	test("acotada a otro departamento, no aplica a este", async () => {
		await setConfigKeys({
			rest_days_min_separation: 2,
			rest_days_min_separation_departments: [otherDepartmentId],
		});

		expect((await putMine(employee, { daysOfWeek: [2, 3] })).status).toBe(200);
	});

	test("los límites vigentes viajan en la respuesta, para el aviso en vivo", async () => {
		await setConfigKeys({ rest_days_min_separation: 3 });

		const res = await request("/api/me/rest-schedule", { as: employee });
		expect(((await res.json()) as RestView).limits.minSeparationDays).toBe(3);
	});
});

describe("RN-10.9 — número de descansos por semana", () => {
	test("el mínimo configurado se exige", async () => {
		await setConfigKeys({ rest_days_min_per_week: 2 });

		const res = await putMine(employee, { daysOfWeek: [0] });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"al menos 2",
		);
	});

	test("el máximo configurado se exige", async () => {
		await setConfigKeys({ rest_days_max_per_week: 1 });

		const res = await putMine(employee, { daysOfWeek: [0, 3] });
		expect(res.status).toBe(400);
	});

	test("un mínimo por encima del máximo no se puede guardar (RN-06.5)", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { rest_days_min_per_week: 5, rest_days_max_per_week: 2 },
		});
		expect(res.status).toBe(400);
	});
});

describe("RN-10.6 — no se marca como descanso un día ya trabajado", () => {
	test("con asistencia registrada hoy, hoy no puede pasar a descanso", async () => {
		const mark = await markIn(employee);
		expect(((await mark.json()) as { accepted: boolean }).accepted).toBe(true);

		const res = await putMine(employee, { daysOfWeek: [TODAY_DOW] });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain(TODAY);
	});

	test("otro día de la semana sí se puede", async () => {
		await markIn(employee);
		expect(
			(await putMine(employee, { daysOfWeek: [TOMORROW_DOW] })).status,
		).toBe(200);
	});

	/**
	 * Un intento **rechazado** no es trabajo: es un rechazo registrado (RN-09.8).
	 * Si contara, un solo intento fuera de la geocerca impediría para siempre poner
	 * ese día como descanso.
	 */
	test("un intento rechazado no bloquea la configuración", async () => {
		const blocked = await request("/api/attendance/marks", {
			as: employee,
			method: "POST",
			body: {
				markType: "IN",
				latitude: 23.2,
				longitude: -82.5,
				accuracy: 10,
				workLocationId: locationId,
			},
		});
		const body = (await blocked.json()) as { accepted: boolean };
		expect(body.accepted).toBe(false);

		expect((await putMine(employee, { daysOfWeek: [TODAY_DOW] })).status).toBe(
			200,
		);
	});
});

describe("RN-10.4 — el marcaje en día de descanso (la costura de la spec 09)", () => {
	test("intentar marcar devuelve REST_DAY y queda registrado", async () => {
		expect((await putMine(employee, { daysOfWeek: [TODAY_DOW] })).status).toBe(
			200,
		);

		const res = await markIn(employee);
		const body = (await res.json()) as {
			accepted: boolean;
			reason: string | null;
			mark: { blocked: boolean; blockReason: string | null } | null;
		};

		expect(res.status).toBe(200);
		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("REST_DAY");
		// RN-09.8: el intento se guarda, con su motivo.
		expect(body.mark?.blocked).toBe(true);
		expect(body.mark?.blockReason).toBe("REST_DAY");
	});

	test("`GET /attendance/status` dice lo mismo que diría el POST", async () => {
		await putMine(employee, { daysOfWeek: [TODAY_DOW] });

		const res = await request("/api/attendance/status", { as: employee });
		const body = (await res.json()) as {
			canCheckIn: boolean;
			reason: string | null;
		};

		expect(body.canCheckIn).toBe(false);
		expect(body.reason).toBe("REST_DAY");
	});

	test("un día que no es su descanso se marca con normalidad", async () => {
		await putMine(employee, { daysOfWeek: [TOMORROW_DOW] });

		const res = await markIn(employee);
		expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
	});
});

describe("clasificación del día (RN-10.4 en la reportería)", () => {
	test("un día de descanso sin marcas clasifica DESCANSO, nunca AUSENTE", async () => {
		await putMine(employee, { daysOfWeek: [TODAY_DOW] });

		const res = await request(`/api/attendance/me?from=${TODAY}&to=${TODAY}`, {
			as: employee,
		});
		const days = (await res.json()) as { date: string; status: string }[];

		expect(days).toHaveLength(1);
		expect(days[0]?.status).toBe("DESCANSO");
	});

	test("sin descansos configurados, el mismo día sigue siendo AUSENTE", async () => {
		const res = await request(`/api/attendance/me?from=${TODAY}&to=${TODAY}`, {
			as: employee,
		});
		const days = (await res.json()) as { status: string }[];
		expect(days[0]?.status).toBe("AUSENTE");
	});
});

describe("grupos de descanso (RN-10.2, RN-10.8)", () => {
	async function createGroup(groupName: string, daysOfWeek: number[]) {
		const res = await request(`/api/departments/${departmentId}/rest-groups`, {
			as: manager,
			method: "POST",
			body: { name: groupName, daysOfWeek },
		});
		expect(res.status).toBe(201);
		return (await res.json()) as RestGroupResponse;
	}

	async function assign(groupId: string, userIds: string[]) {
		return request(`/api/rest-groups/${groupId}/members`, {
			as: head,
			method: "PUT",
			body: { userIds },
		});
	}

	test("no se repite el nombre de un grupo dentro del departamento", async () => {
		await createGroup("Grupo A", [0]);

		const clash = await request(
			`/api/departments/${departmentId}/rest-groups`,
			{
				as: manager,
				method: "POST",
				body: { name: "grupo a", daysOfWeek: [3] },
			},
		);
		expect(clash.status).toBe(409);
	});

	/**
	 * El cuarto criterio de aceptación: con los grupos activados, la configuración
	 * individual **se ignora** — y sigue ahí, porque apagar el interruptor la tiene
	 * que devolver intacta (RN-01.6).
	 */
	test("con grupos activados, la configuración individual se ignora", async () => {
		await putMine(employee, { daysOfWeek: [TOMORROW_DOW] });
		await restGroupsEnabled(true);

		const group = await createGroup("Grupo A", [TODAY_DOW]);
		expect((await assign(group.id, [await profileIdOf(employee)])).status).toBe(
			200,
		);

		const res = await request("/api/me/rest-schedule", { as: employee });
		const view = (await res.json()) as RestView;

		expect(view.resolved.source).toBe("group");
		expect(view.resolved.daysOfWeek).toEqual([TODAY_DOW]);
		expect(view.resolved.group?.name).toBe("Grupo A");
		// Sigue guardada, sólo que no manda.
		expect(view.schedules).toHaveLength(1);
		expect(view.canEdit).toBe(false);

		// Y el marcaje aplica los días del grupo, no los individuales.
		const mark = await markIn(employee);
		expect(((await mark.json()) as { reason: string | null }).reason).toBe(
			"REST_DAY",
		);

		// Apagado el interruptor, vuelve la individual sin haber tocado nada.
		await restGroupsEnabled(false);
		const back = (await (
			await request("/api/me/rest-schedule", { as: employee })
		).json()) as RestView;
		expect(back.resolved.source).toBe("individual");
		expect(back.resolved.daysOfWeek).toEqual([TOMORROW_DOW]);
	});

	test("con grupos activados no se acepta escribir la configuración individual", async () => {
		await restGroupsEnabled(true);
		const res = await putMine(employee, { daysOfWeek: [TOMORROW_DOW] });
		expect(res.status).toBe(409);
	});

	test("sólo se asigna a personas activas de ese departamento", async () => {
		await restGroupsEnabled(true);
		const group = await createGroup("Grupo A", [TOMORROW_DOW]);

		const res = await assign(group.id, [await profileIdOf(outsider)]);
		expect(res.status).toBe(400);
	});

	test("sacar a alguien del grupo no borra su pasado: apila una fila", async () => {
		await restGroupsEnabled(true);
		const group = await createGroup("Grupo A", [TOMORROW_DOW]);
		const id = await profileIdOf(employee);

		expect((await assign(group.id, [id])).status).toBe(200);
		const emptied = await assign(group.id, []);
		expect(emptied.status).toBe(200);

		const groups = (await emptied.json()) as RestGroupResponse[];
		expect(groups.find((each) => each.id === group.id)?.members).toEqual([]);

		const rows = await db
			.select()
			.from(restGroupMembers)
			.where(eq(restGroupMembers.userId, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.groupId).toBeNull();
	});

	test("RN-10.8 — un grupo con historial no se elimina", async () => {
		await restGroupsEnabled(true);
		const group = await createGroup("Grupo A", [TOMORROW_DOW]);
		await assign(group.id, [await profileIdOf(employee)]);

		const res = await request(`/api/rest-groups/${group.id}`, {
			as: manager,
			method: "DELETE",
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain(
			"desactívalo",
		);
	});

	test("un grupo que nunca tuvo a nadie sí se elimina", async () => {
		const group = await createGroup("Grupo A", [0]);
		expect(
			(
				await request(`/api/rest-groups/${group.id}`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(200);
	});

	test("no se desactiva un grupo con gente dentro", async () => {
		await restGroupsEnabled(true);
		const group = await createGroup("Grupo A", [TOMORROW_DOW]);
		await assign(group.id, [await profileIdOf(employee)]);

		const res = await request(`/api/rest-groups/${group.id}`, {
			as: manager,
			method: "PATCH",
			body: { isActive: false },
		});
		expect(res.status).toBe(409);
	});

	test("los días de un grupo pasan por RN-10.5 igual que los individuales", async () => {
		await setConfigKeys({ rest_days_min_separation: 2 });

		const res = await request(`/api/departments/${departmentId}/rest-groups`, {
			as: manager,
			method: "POST",
			body: { name: "Grupo A", daysOfWeek: [2, 3] },
		});
		expect(res.status).toBe(400);
	});

	test("el departamento no se borra mientras tenga grupos (spec 01 §5.2)", async () => {
		const empty = await request("/api/departments", {
			as: manager,
			method: "POST",
			body: { name: name("desechable") },
		});
		const id = ((await empty.json()) as { id: string }).id;

		await request(`/api/departments/${id}/rest-groups`, {
			as: manager,
			method: "POST",
			body: { name: "Grupo A", daysOfWeek: [0] },
		});

		const res = await request(`/api/departments/${id}`, {
			as: manager,
			method: "DELETE",
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain(
			"grupo de descanso",
		);

		await db.delete(restGroups).where(eq(restGroups.departmentId, id));
		await db.delete(departments).where(eq(departments.id, id));
	});
});

describe("calendario de descansos del equipo (spec 10 §7)", () => {
	test("dice quién descansa cada día y quién no tiene descansos", async () => {
		await putMine(employee, { daysOfWeek: [TODAY_DOW] });

		const res = await request(
			`/api/departments/${departmentId}/rest-days?from=${TODAY}&to=${TODAY}`,
			{ as: head },
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			days: { date: string; people: { userId: string; source: string }[] }[];
			withoutRestDays: { userId: string }[];
		};

		const employeeId = await profileIdOf(employee);
		expect(body.days).toHaveLength(1);
		expect(body.days[0]?.people.map((each) => each.userId)).toContain(
			employeeId,
		);
		expect(body.days[0]?.people[0]?.source).toBe("individual");
		// El compañero no ha configurado nada: es el hueco que recuerda RN-10.10.
		expect(body.withoutRestDays.map((each) => each.userId)).toContain(
			await profileIdOf(mate),
		);
	});

	test("un rango invertido se rechaza antes de tocar la base", async () => {
		const res = await request(
			`/api/departments/${departmentId}/rest-days?from=${TODAY}&to=${YESTERDAY}`,
			{ as: head },
		);
		expect(res.status).toBe(400);
	});
});

describe("RN-10.10 — el recordatorio, generado en el servidor", () => {
	async function reminderCountOf(who: TestUser) {
		const rows = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, await profileIdOf(who)));
		return rows.filter((row) => row.type === "rest_schedule.missing").length;
	}

	test("sin descansos configurados se crea una sola notificación viva", async () => {
		const profile = {
			id: await profileIdOf(employee),
			departmentId,
		};

		await remindMissingRestSchedule(profile, "employee");
		await remindMissingRestSchedule(profile, "employee");
		await remindMissingRestSchedule(profile, "employee");

		expect(await reminderCountOf(employee)).toBe(1);
	});

	test("configurar los descansos retira el recordatorio", async () => {
		const profile = { id: await profileIdOf(employee), departmentId };
		await remindMissingRestSchedule(profile, "employee");
		expect(await reminderCountOf(employee)).toBe(1);

		expect(
			(await putMine(employee, { daysOfWeek: [TOMORROW_DOW] })).status,
		).toBe(200);
		expect(await reminderCountOf(employee)).toBe(0);
	});

	test("al gestor global no se le recuerda: no marca (RN-03.4)", async () => {
		await remindMissingRestSchedule(
			{ id: await profileIdOf(manager), departmentId },
			"global_manager",
		);
		expect(await reminderCountOf(manager)).toBe(0);
	});

	test("sin departamento tampoco: el aviso pendiente es otro (RN-02.12)", async () => {
		await remindMissingRestSchedule(
			{ id: await profileIdOf(outsider), departmentId: null },
			"employee",
		);
		expect(await reminderCountOf(outsider)).toBe(0);
	});
});
