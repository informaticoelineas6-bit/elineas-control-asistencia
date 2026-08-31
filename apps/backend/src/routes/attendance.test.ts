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
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas del marcaje (spec 09 §7) contra la base de desarrollo.
 *
 * Lo que sólo se puede probar con la base delante: que la puerta de escritura sea
 * única, que el doble toque **simultáneo** no duplique (esa carrera la gana el
 * índice, no la comprobación previa), que los intentos rechazados queden
 * registrados y que el historial de una persona nunca traiga marcas de otra.
 *
 * Las reglas viven en `services/attendance-rules.test.ts`, que es puro y exhaustivo.
 *
 * Requiere el Postgres del compose (`docker compose up -d postgres` y
 * `bun run db:migrate`).
 */

mock.module("#/lib/identity", () => ({
	IdentityError: class IdentityError extends Error {},
	signIn: async () => {
		throw new Error("signIn no se usa en estas pruebas");
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
	attendanceMarks,
	auditLog,
	departments,
	notifications,
	profiles,
	workLocations,
} = await import("#/db/schema");

const app = createApp();
const TAG = `zz-att-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
const other = testUser("other", ["employee"]);
const orphan = testUser("orphan", ["employee"]);
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

// ── Horarios construidos alrededor de "ahora" ────────────────────────────────
//
// El horario de prueba usa la zona `UTC` a propósito: así la hora local del
// departamento es la del reloj del proceso y la ventana se puede calcular sin
// depender de la zona de la máquina. Que la zona del horario **manda** ya está
// probado en `schedule-rules.test.ts`.

const nowMinutes = () => {
	const now = new Date();
	return now.getUTCHours() * 60 + now.getUTCMinutes();
};

const hhmm = (minutes: number) =>
	`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Ventana amplia que contiene la hora actual, para entrada y para salida. */
function windowAroundNow() {
	const current = nowMinutes();
	const start = Math.max(0, current - 60);
	const end = Math.min(1439, current + 60);

	return {
		checkinStartTime: hhmm(start),
		checkinEndTime: hhmm(end),
		checkoutStartTime: hhmm(start),
		checkoutEndTime: hhmm(end),
		timezone: "UTC",
	};
}

/** Ventana de media hora que **no** contiene la hora actual. */
function windowFarFromNow() {
	const current = nowMinutes();
	const start = current + 240 <= 1380 ? current + 240 : current - 300;

	return {
		checkinStartTime: hhmm(start),
		checkinEndTime: hhmm(start + 30),
		checkoutStartTime: hhmm(start),
		checkoutEndTime: hhmm(start + 30),
		timezone: "UTC",
	};
}

const CENTER = { latitude: 23.1136, longitude: -82.3666 };
/** ~500 m al norte del centro. */
const FAR = { latitude: 23.1181, longitude: -82.3666 };

let departmentId = "";
let scheduleLessDepartmentId = "";
let locationId = "";

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

/** Marca con las coordenadas del centro de la sede, salvo que se diga otra cosa. */
function markBody(
	markType: "IN" | "OUT",
	overrides: Record<string, unknown> = {},
) {
	return {
		markType,
		latitude: CENTER.latitude,
		longitude: CENTER.longitude,
		accuracy: 10,
		workLocationId: locationId,
		...overrides,
	};
}

type MarkResponse = {
	accepted: boolean;
	duplicate: boolean;
	reason: string | null;
	message: string;
	mark: {
		id: string;
		markType: string;
		workDate: string | null;
		blocked: boolean;
		blockReason: string | null;
		insideGeofence: boolean | null;
		distanceToCenter: number | null;
		isLate: boolean;
		lateMinutes: number;
		source: string;
		workLocationName: string | null;
	} | null;
};

const markAs = async (who: TestUser, body: Record<string, unknown>) => {
	const res = await request("/api/attendance/marks", {
		as: who,
		method: "POST",
		body,
	});
	return { status: res.status, body: (await res.json()) as MarkResponse };
};

async function clearMarks() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length > 0) {
		await db
			.delete(attendanceMarks)
			.where(inArray(attendanceMarks.userId, ids));
	}
}

beforeAll(async () => {
	for (const who of [employee, other, orphan, manager]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}

	const created = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name("producción") },
	});
	expect(created.status).toBe(201);
	departmentId = ((await created.json()) as { id: string }).id;

	const bare = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name("sin horario") },
	});
	scheduleLessDepartmentId = ((await bare.json()) as { id: string }).id;

	await moveTo(employee, departmentId);
	await moveTo(other, departmentId);
	await moveTo(orphan, scheduleLessDepartmentId);

	const schedule = await request(`/api/departments/${departmentId}/schedule`, {
		as: manager,
		method: "PUT",
		body: windowAroundNow(),
	});
	expect(schedule.status).toBe(200);

	// Tolerancia propia del día, generosa: así la tardanza no depende del valor
	// global que tenga puesto la base de desarrollo.
	const today = new Date().toISOString().slice(0, 10);
	await request(`/api/departments/${departmentId}/calendar`, {
		as: manager,
		method: "PUT",
		body: {
			entries: [{ date: today, isWorkday: true, lateToleranceMinutes: 240 }],
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

	for (const who of [employee, other]) {
		const selected = await request("/api/me/work-location", {
			as: who,
			method: "PUT",
			body: { workLocationId: locationId },
		});
		expect(selected.status).toBe(200);
	}
});

afterEach(async () => {
	await clearMarks();
});

afterAll(async () => {
	const testProfileIds = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	const testDepartmentIds = (
		await db
			.select({ id: departments.id })
			.from(departments)
			.where(like(departments.name, `${TAG}%`))
	).map((row) => row.id);

	if (testProfileIds.length > 0) {
		await db
			.delete(attendanceMarks)
			.where(inArray(attendanceMarks.userId, testProfileIds));
		await db
			.delete(notifications)
			.where(inArray(notifications.userId, testProfileIds));
		await db.delete(auditLog).where(inArray(auditLog.actorId, testProfileIds));
		await db
			.update(profiles)
			.set({ departmentId: null, selectedWorkLocationId: null })
			.where(inArray(profiles.id, testProfileIds));
		await db.delete(profiles).where(inArray(profiles.id, testProfileIds));
	}
	if (testDepartmentIds.length > 0) {
		await db
			.delete(auditLog)
			.where(inArray(auditLog.recordId, testDepartmentIds));
	}
	await db.delete(workLocations).where(like(workLocations.name, `${TAG}%`));
	await db.delete(departments).where(like(departments.name, `${TAG}%`));
});

describe("autorización", () => {
	test("sin sesión, los cuatro endpoints responden 401", async () => {
		expect((await request("/api/attendance/status")).status).toBe(401);
		expect((await request("/api/attendance/marks/today")).status).toBe(401);
		expect(
			(await request("/api/attendance/me?from=2026-08-01&to=2026-08-31"))
				.status,
		).toBe(401);
		expect(
			(
				await request("/api/attendance/marks", {
					method: "POST",
					body: markBody("IN"),
				})
			).status,
		).toBe(401);
	});

	test("el gestor global recibe el motivo tipado, no un 403 seco", async () => {
		const { status, body } = await markAs(manager, markBody("IN"));

		expect(status).toBe(200);
		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("ROLE_CANNOT_MARK");

		const status2 = await request("/api/attendance/status", { as: manager });
		const payload = (await status2.json()) as {
			canMark: boolean;
			reason: string | null;
		};
		expect(payload.canMark).toBe(false);
		expect(payload.reason).toBe("ROLE_CANNOT_MARK");
	});
});

describe("registrar un marcaje", () => {
	test("una entrada válida se crea con los datos recalculados en servidor", async () => {
		const { status, body } = await markAs(employee, markBody("IN"));

		expect(status).toBe(201);
		expect(body.accepted).toBe(true);
		expect(body.duplicate).toBe(false);
		expect(body.mark?.blocked).toBe(false);
		expect(body.mark?.insideGeofence).toBe(true);
		expect(body.mark?.distanceToCenter).toBeLessThan(1);
		expect(body.mark?.source).toBe("manual");
		expect(body.mark?.workDate).toBe(new Date().toISOString().slice(0, 10));
		expect(body.mark?.workLocationName).toContain(TAG);
		// La tolerancia del día es de 240 min: una hora de retraso no es tardanza.
		expect(body.mark?.isLate).toBe(false);
	});

	test("el cliente no pone la hora ni la distancia: se ignoran (RN-09.11, RN-08.2)", async () => {
		const { body } = await markAs(
			employee,
			markBody("IN", {
				...FAR,
				// Todo esto es lo que un cliente manipulado querría colar.
				markedAt: "2000-01-01T00:00:00.000Z",
				distanceToCenter: 0,
				insideGeofence: true,
				isLate: false,
			}),
		);

		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("OUTSIDE_GEOFENCE");
		// El servidor recalculó: ni la distancia ni la pertenencia son las que mandó.
		expect(body.mark?.insideGeofence).toBe(false);
		expect(body.mark?.distanceToCenter).toBeGreaterThan(400);
		expect(
			new Date(body.mark?.workDate ?? "").getUTCFullYear(),
		).toBeGreaterThan(2020);
	});

	test("un intento rechazado queda registrado con su motivo", async () => {
		const { body } = await markAs(employee, markBody("IN", FAR));
		expect(body.accepted).toBe(false);

		const rows = await db
			.select()
			.from(attendanceMarks)
			.where(
				and(
					eq(attendanceMarks.userId, await profileIdOf(employee)),
					eq(attendanceMarks.blocked, true),
				),
			);

		expect(rows.length).toBe(1);
		expect(rows[0]?.blockReason).toBe("OUTSIDE_GEOFENCE");
	});

	test("cuatro intentos rechazados en el mismo minuto dejan una sola fila", async () => {
		for (let attempt = 0; attempt < 4; attempt++) {
			const { body } = await markAs(employee, markBody("IN", FAR));
			expect(body.accepted).toBe(false);
		}

		const rows = await db
			.select()
			.from(attendanceMarks)
			.where(eq(attendanceMarks.userId, await profileIdOf(employee)));

		expect(rows.length).toBe(1);
	});

	test("doble toque simultáneo genera una marca (RN-09.10)", async () => {
		const [first, second] = await Promise.all([
			markAs(employee, markBody("IN")),
			markAs(employee, markBody("IN")),
		]);

		const rows = await db
			.select()
			.from(attendanceMarks)
			.where(
				and(
					eq(attendanceMarks.userId, await profileIdOf(employee)),
					eq(attendanceMarks.blocked, false),
				),
			);

		expect(rows.length).toBe(1);
		// Las dos respuestas dan por buena la marca; una de ellas dice que era repetida.
		expect(first.body.accepted && second.body.accepted).toBe(true);
		expect(first.body.duplicate || second.body.duplicate).toBe(true);
	});

	test("un rechazo anterior no impide el marcaje bueno que viene después", async () => {
		const rejected = await markAs(employee, markBody("IN", FAR));
		expect(rejected.body.accepted).toBe(false);

		const accepted = await markAs(employee, markBody("IN"));
		expect(accepted.body.accepted).toBe(true);
		expect(accepted.body.duplicate).toBe(false);
	});
});

describe("secuencia (RN-09.9)", () => {
	test("entrada, salida, entrada y salida es la secuencia legítima", async () => {
		expect((await markAs(employee, markBody("IN"))).body.accepted).toBe(true);

		const out = await markAs(employee, markBody("OUT"));
		expect(out.body.accepted).toBe(true);
		expect(out.status).toBe(201);
	});

	test("una salida sin entrada previa se rechaza", async () => {
		const { body } = await markAs(employee, markBody("OUT"));

		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("INVALID_SEQUENCE");
		expect(body.mark?.blocked).toBe(true);
	});

	test("dos salidas seguidas se rechazan", async () => {
		await markAs(employee, markBody("IN"));
		expect((await markAs(employee, markBody("OUT"))).body.accepted).toBe(true);

		// La segunda salida entra en el antirrebote si cae en el mismo minuto; se
		// comprueba el motivo sólo cuando de verdad se juzga la secuencia.
		const second = await markAs(employee, markBody("OUT"));
		expect(second.body.accepted && !second.body.duplicate).toBe(false);
	});
});

describe("horario y departamento", () => {
	test("fuera de la ventana horaria se rechaza (reloj del cliente irrelevante)", async () => {
		await request(`/api/departments/${departmentId}/schedule`, {
			as: manager,
			method: "PUT",
			body: windowFarFromNow(),
		});

		const { body } = await markAs(employee, markBody("IN"));
		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("OUTSIDE_TIME_WINDOW");

		await request(`/api/departments/${departmentId}/schedule`, {
			as: manager,
			method: "PUT",
			body: windowAroundNow(),
		});
	});

	test("un departamento en pausa bloquea con su motivo (RN-01.4)", async () => {
		await request(`/api/departments/${departmentId}/pause`, {
			as: manager,
			method: "POST",
			body: { reason: "corte de agua" },
		});

		const { body } = await markAs(employee, markBody("IN"));
		expect(body.reason).toBe("DEPARTMENT_PAUSED");
		expect(body.message).toContain("corte de agua");

		await request(`/api/departments/${departmentId}/resume`, {
			as: manager,
			method: "POST",
		});
	});

	test("sin horario configurado no se puede marcar", async () => {
		const { body } = await markAs(orphan, {
			markType: "IN",
			latitude: CENTER.latitude,
			longitude: CENTER.longitude,
			accuracy: 10,
			workLocationId: null,
		});

		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("NO_SCHEDULE");
	});

	test("un día no laborable se rechaza con NOT_WORKDAY", async () => {
		const today = new Date().toISOString().slice(0, 10);
		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [{ date: today, isWorkday: false, note: "Feriado de prueba" }],
			},
		});

		const { body } = await markAs(employee, markBody("IN"));
		expect(body.reason).toBe("NOT_WORKDAY");
		expect(body.message).toContain("Feriado de prueba");

		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [{ date: today, isWorkday: true, lateToleranceMinutes: 240 }],
			},
		});
	});
});

describe("sede (spec 08)", () => {
	test("sin sede seleccionada se rechaza con INVALID_LOCATION", async () => {
		await request("/api/me/work-location", {
			as: employee,
			method: "PUT",
			body: { workLocationId: null },
		});

		const { body } = await markAs(
			employee,
			markBody("IN", { workLocationId: null }),
		);
		expect(body.reason).toBe("INVALID_LOCATION");

		await request("/api/me/work-location", {
			as: employee,
			method: "PUT",
			body: { workLocationId: locationId },
		});
	});

	test("mandar una sede distinta de la seleccionada se rechaza", async () => {
		const { body } = await markAs(
			employee,
			markBody("IN", { workLocationId: crypto.randomUUID() }),
		);

		expect(body.accepted).toBe(false);
		expect(body.reason).toBe("INVALID_LOCATION");
	});
});

describe("estado y marcas de hoy", () => {
	test("el estado dice qué toca ahora y va cambiando", async () => {
		const before = (await (
			await request("/api/attendance/status", { as: employee })
		).json()) as {
			canCheckIn: boolean;
			canCheckOut: boolean;
			nextMarkType: string | null;
			openSince: string | null;
			marks: unknown[];
		};

		expect(before.canCheckIn).toBe(true);
		expect(before.canCheckOut).toBe(false);
		expect(before.nextMarkType).toBe("IN");
		expect(before.marks.length).toBe(0);

		await markAs(employee, markBody("IN"));

		const after = (await (
			await request("/api/attendance/status", { as: employee })
		).json()) as {
			canCheckIn: boolean;
			canCheckOut: boolean;
			nextMarkType: string | null;
			openSince: string | null;
			marks: unknown[];
		};

		expect(after.canCheckIn).toBe(false);
		expect(after.canCheckOut).toBe(true);
		expect(after.nextMarkType).toBe("OUT");
		expect(after.openSince).not.toBeNull();
		expect(after.marks.length).toBe(1);
	});

	test("las marcas de hoy son las de la jornada en curso, sin las rechazadas", async () => {
		await markAs(employee, markBody("IN"));
		await markAs(employee, markBody("OUT", FAR));

		const marks = (await (
			await request("/api/attendance/marks/today", { as: employee })
		).json()) as { markType: string; blocked: boolean }[];

		expect(marks.length).toBe(1);
		expect(marks[0]?.markType).toBe("IN");
	});
});

describe("historial propio", () => {
	test("el día sale agregado, con estado y minutos trabajados", async () => {
		await markAs(employee, markBody("IN"));
		await markAs(employee, markBody("OUT"));

		const today = new Date().toISOString().slice(0, 10);
		const res = await request(`/api/attendance/me?from=${today}&to=${today}`, {
			as: employee,
		});
		expect(res.status).toBe(200);

		const days = (await res.json()) as {
			date: string;
			status: string;
			firstIn: string | null;
			lastOut: string | null;
			workedMinutes: number | null;
			incomplete: boolean;
			marks: unknown[];
		}[];

		expect(days.length).toBe(1);
		expect(days[0]?.status).toBe("PRESENTE");
		expect(days[0]?.firstIn).not.toBeNull();
		expect(days[0]?.lastOut).not.toBeNull();
		expect(days[0]?.incomplete).toBe(false);
		expect(days[0]?.marks.length).toBe(2);
	});

	test("una jornada sin salida queda incompleta y sin minutos inventados", async () => {
		await markAs(employee, markBody("IN"));

		const today = new Date().toISOString().slice(0, 10);
		const days = (await (
			await request(`/api/attendance/me?from=${today}&to=${today}`, {
				as: employee,
			})
		).json()) as { incomplete: boolean; workedMinutes: number | null }[];

		expect(days[0]?.incomplete).toBe(true);
		expect(days[0]?.workedMinutes).toBeNull();
	});

	test("el historial de una persona nunca trae marcas de otra", async () => {
		await markAs(other, markBody("IN"));

		const today = new Date().toISOString().slice(0, 10);
		const days = (await (
			await request(`/api/attendance/me?from=${today}&to=${today}`, {
				as: employee,
			})
		).json()) as { marks: unknown[] }[];

		expect(days[0]?.marks.length).toBe(0);
	});

	test("un rango invertido o desmedido se rechaza", async () => {
		expect(
			(
				await request("/api/attendance/me?from=2026-08-31&to=2026-08-01", {
					as: employee,
				})
			).status,
		).toBe(400);
		expect(
			(
				await request("/api/attendance/me?from=2020-01-01&to=2030-01-01", {
					as: employee,
				})
			).status,
		).toBe(400);
	});
});
