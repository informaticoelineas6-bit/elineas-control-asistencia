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
 * Pruebas de justificación de ausencias (spec 13 §8) contra la base de
 * desarrollo.
 *
 * Es el flujo con más impacto económico del sistema —un clic aquí mueve dinero—
 * y **casi nada de eso se puede demostrar sin la base delante**: que se cree
 * exactamente un ajuste, con el monto exacto, que reclasificar lo revierta sin
 * borrarlo, que repetir la decisión no duplique nada y que dos revisiones
 * simultáneas tampoco. Todos esos criterios se comprueban contando y comparando
 * filas de `payroll_adjustments`.
 *
 * La asimetría de las notas (RN-13.6) y el periodo de nómina se prueban puros en
 * `services/absence-rules.test.ts`; la superposición AJ/ANJ, en
 * `services/daily-status.test.ts`.
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
	attendanceIncidents,
	attendanceMarks,
	auditLog,
	departments,
	employeeCompensation,
	notifications,
	payrollAdjustments,
	profiles,
	userDepartmentResponsibilities,
} = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-abs-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
/** Sin sueldo configurado: el caso de RN-17.7. */
const unpaid = testUser("unpaid", ["employee"]);
/** En otro departamento: fuera del ámbito de `head`. */
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

/** El día que se clasifica en casi todas las pruebas: ausente y ya cerrado. */
const ABSENT_DAY = addDays(TODAY, -3);
const SECOND_ABSENT_DAY = addDays(TODAY, -4);

const CENTER = { latitude: 23.1136, longitude: -82.3666 };
/** 3000 / 30 = 100.00 exactos: el monto esperado no depende del redondeo. */
const SALARY = "3000.00";

let departmentId = "";
let otherDepartmentId = "";
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

type PayrollEffect = {
	effect: "created" | "reverted" | "unchanged" | "skipped_no_salary";
	amount: string | null;
	currency: string | null;
	effectivePeriod: string | null;
};

type ReviewResult = {
	review: {
		id: string;
		userId: string;
		date: string;
		isJustified: boolean;
		notes: string | null;
		reviewedBy: string;
	};
	payrollAdjustment: PayrollEffect;
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

function review(
	who: TestUser,
	target: string,
	date: string,
	body: { isJustified: boolean; notes?: string },
) {
	return request(`/api/absences/${target}/${date}`, {
		as: who,
		method: "PUT",
		body,
	});
}

async function reviewed(
	who: TestUser,
	target: string,
	date: string,
	body: { isJustified: boolean; notes?: string },
): Promise<ReviewResult> {
	const res = await review(who, target, date, body);
	expect(res.status).toBe(200);
	return (await res.json()) as ReviewResult;
}

async function adjustmentsOf(who: TestUser) {
	return db
		.select()
		.from(payrollAdjustments)
		.where(eq(payrollAdjustments.userId, await profileIdOf(who)));
}

async function clearAbsenceRows() {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length === 0) return;
	await db
		.delete(payrollAdjustments)
		.where(inArray(payrollAdjustments.userId, ids));
	await db
		.delete(attendanceAbsenceReviews)
		.where(inArray(attendanceAbsenceReviews.userId, ids));
	await db
		.delete(attendanceIncidents)
		.where(inArray(attendanceIncidents.userId, ids));
	await db.delete(attendanceMarks).where(inArray(attendanceMarks.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
	await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, unpaid, outsider, head, manager]) {
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
	await moveTo(unpaid, departmentId);
	await moveTo(head, departmentId);
	await moveTo(outsider, otherDepartmentId);

	// Zona UTC en los dos departamentos: así el "hoy" del servidor coincide con el
	// de estas pruebas y `ABSENT_DAY` está inequívocamente cerrado.
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

		// Los días que se clasifican tienen que ser laborables **explícitamente**:
		// si cayeran en un día no laborable del calendario, RN-13.1 los rechazaría
		// y la prueba mediría otra cosa.
		expect(
			(
				await request(`/api/departments/${id}/calendar`, {
					as: manager,
					method: "PUT",
					body: {
						entries: [
							{ date: ABSENT_DAY, isWorkday: true },
							{ date: SECOND_ABSENT_DAY, isWorkday: true },
							{ date: TODAY, isWorkday: true },
						],
					},
				})
			).status,
		).toBe(200);
	}

	// Sin sede: en estas pruebas nadie marca por la API — una ausencia se produce
	// justamente por no hacerlo — y los pocos marcajes que hacen falta se siembran
	// directo en la base.

	// Sueldo sólo para `employee` y `outsider`: `unpaid` se queda sin él a
	// propósito (RN-17.7).
	for (const who of [employee, outsider]) {
		const id = await profileIdOf(who);
		expect(
			(
				await request(`/api/users/${id}/compensation`, {
					as: manager,
					method: "PUT",
					body: { monthlySalary: SALARY, currency: "CUP" },
				})
			).status,
		).toBe(200);
	}
});

afterEach(async () => {
	await clearAbsenceRows();
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
		await clearAbsenceRows();
		await db
			.delete(employeeCompensation)
			.where(inArray(employeeCompensation.profileId, ids));
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

describe("autorización (spec 13 §6, RN-13.3)", () => {
	test("sin sesión, todo responde 401", async () => {
		expect((await request("/api/absences/pending")).status).toBe(401);
		expect(
			(await request(`/api/absences?from=${ABSENT_DAY}&to=${TODAY}`)).status,
		).toBe(401);
	});

	test("un empleado no entra a ningún endpoint de este router", async () => {
		// La puerta está en la entrada del router y no por ruta: aquí no hay
		// ninguna operación que un empleado pueda hacer, ni de lectura.
		expect(
			(await request("/api/absences/pending", { as: employee })).status,
		).toBe(403);
		expect(
			(
				await request(`/api/absences?from=${ABSENT_DAY}&to=${TODAY}`, {
					as: employee,
				})
			).status,
		).toBe(403);
		expect(
			(
				await review(employee, await profileIdOf(unpaid), ABSENT_DAY, {
					isJustified: false,
				})
			).status,
		).toBe(403);
	});

	test("un jefe no clasifica a alguien fuera de su ámbito", async () => {
		const res = await review(head, await profileIdOf(outsider), ABSENT_DAY, {
			isJustified: false,
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toContain("ámbito");
	});

	test("nadie clasifica sus propias ausencias (RN-13.3)", async () => {
		const res = await review(head, await profileIdOf(head), ABSENT_DAY, {
			isJustified: false,
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toContain(
			"tus propias ausencias",
		);
	});
});

describe("RN-13.1 — sólo días efectivamente ausentes (§8)", () => {
	test("un día con marcaje no se puede clasificar", async () => {
		// La marca lo convierte en PRESENTE (RN-15.2), así que deja de ser ausencia.
		await db.insert(attendanceMarks).values({
			userId: await profileIdOf(employee),
			markType: "IN",
			markedAt: new Date(`${ABSENT_DAY}T12:00:00.000Z`),
			workDate: ABSENT_DAY,
			latitude: CENTER.latitude,
			longitude: CENTER.longitude,
			accuracy: 10,
			blocked: false,
		});

		const res = await review(head, await profileIdOf(employee), ABSENT_DAY, {
			isJustified: false,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"PRESENTE",
		);
	});

	test("un día no laborable tampoco", async () => {
		const holiday = addDays(TODAY, -5);
		await request(`/api/departments/${departmentId}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: holiday, isWorkday: false }] },
		});

		const res = await review(head, await profileIdOf(employee), holiday, {
			isJustified: false,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"NO_LABORABLE",
		);
	});

	test("hoy no se clasifica: la jornada todavía puede completarse", async () => {
		const res = await review(head, await profileIdOf(employee), TODAY, {
			isJustified: false,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"puede completarse",
		);
	});
});

describe("RN-13.4 — la cadena de nómina (§8, los criterios críticos)", () => {
	test("no justificada crea exactamente un ajuste con el monto correcto", async () => {
		const result = await reviewed(
			manager,
			await profileIdOf(employee),
			ABSENT_DAY,
			{ isJustified: false },
		);

		expect(result.payrollAdjustment.effect).toBe("created");
		// 3000.00 / 30 = 100.00, con signo negativo porque es un descuento.
		expect(result.payrollAdjustment.amount).toBe("-100.00");
		expect(result.payrollAdjustment.currency).toBe("CUP");
		// §7: el periodo es el del mes de la **ausencia**.
		expect(result.payrollAdjustment.effectivePeriod).toBe(
			`${ABSENT_DAY.slice(0, 7)}-01`,
		);

		const rows = await adjustmentsOf(employee);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("active");
		expect(rows[0]?.category).toBe("unjustified_absence");
		expect(rows[0]?.sourceType).toBe("absence_review");
		expect(rows[0]?.sourceId).toBe(result.review.id);
	});

	test("el divisor sale de la configuración, no de un 30 fijo (RN-17.3)", async () => {
		await setConfigKeys({ payroll_daily_divisor: 24 });

		const result = await reviewed(
			manager,
			await profileIdOf(employee),
			ABSENT_DAY,
			{ isJustified: false },
		);
		// 3000 / 24 = 125.00
		expect(result.payrollAdjustment.amount).toBe("-125.00");
	});

	test("el redondeo es a dos decimales, media al alza (RN-17.12)", async () => {
		const id = await profileIdOf(employee);
		await request(`/api/users/${id}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "1000.00", currency: "CUP" },
		});
		await setConfigKeys({ payroll_daily_divisor: 3 });

		// 1000 / 3 = 333.3333… → 333.33
		const result = await reviewed(manager, id, ABSENT_DAY, {
			isJustified: false,
		});
		expect(result.payrollAdjustment.amount).toBe("-333.33");

		// Y vuelta al sueldo de las demás pruebas.
		await request(`/api/users/${id}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: SALARY, currency: "CUP" },
		});
	});

	test("reclasificar a justificada revierte el ajuste sin borrarlo (§8)", async () => {
		const id = await profileIdOf(employee);
		const first = await reviewed(manager, id, ABSENT_DAY, {
			isJustified: false,
		});

		const second = await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Trajo el certificado médico.",
		});
		expect(second.payrollAdjustment.effect).toBe("reverted");

		const rows = await adjustmentsOf(employee);
		// Sigue habiendo **una** fila: la misma, revertida. Nada borrado (RN-17.4).
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe((await adjustmentsOf(employee))[0]?.id ?? "");
		expect(rows[0]?.status).toBe("reverted");
		expect(rows[0]?.revertedBy).toBe(await profileIdOf(manager));
		expect(rows[0]?.revertedAt).not.toBeNull();
		expect(rows[0]?.sourceId).toBe(first.review.id);
	});

	test("volver a no justificada crea un ajuste nuevo, no resucita el anterior", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado.",
		});
		const third = await reviewed(manager, id, ABSENT_DAY, {
			isJustified: false,
		});
		expect(third.payrollAdjustment.effect).toBe("created");

		const rows = await adjustmentsOf(employee);
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
		expect(rows.filter((row) => row.status === "reverted")).toHaveLength(1);
	});

	test("repetir la misma decisión no duplica ajustes (§8)", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		const again = await reviewed(manager, id, ABSENT_DAY, {
			isJustified: false,
		});

		expect(again.payrollAdjustment.effect).toBe("unchanged");
		expect(await adjustmentsOf(employee)).toHaveLength(1);
	});

	test("repetir «justificada» tampoco cambia nada", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado.",
		});
		const again = await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado.",
		});
		expect(again.payrollAdjustment.effect).toBe("unchanged");
		expect(await adjustmentsOf(employee)).toHaveLength(0);
	});

	test("dos revisiones simultáneas no crean dos descuentos (RN-17.5)", async () => {
		const id = await profileIdOf(employee);
		const [a, b] = await Promise.all([
			review(manager, id, ABSENT_DAY, { isJustified: false }),
			review(manager, id, ABSENT_DAY, { isJustified: false }),
		]);

		// Las dos pueden responder 200 —es un upsert idempotente— pero el índice
		// único parcial garantiza que sólo una fila activa exista.
		expect([a.status, b.status].every((status) => status === 200)).toBe(true);
		const rows = await adjustmentsOf(employee);
		expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
	});

	test("sin sueldo configurado no se crea ajuste y se avisa (RN-17.7, §8)", async () => {
		const result = await reviewed(
			manager,
			await profileIdOf(unpaid),
			ABSENT_DAY,
			{ isJustified: false },
		);

		expect(result.payrollAdjustment.effect).toBe("skipped_no_salary");
		expect(await adjustmentsOf(unpaid)).toHaveLength(0);
		// Pero la clasificación **sí** quedó tomada: el flujo no se rompe.
		expect(result.review.isJustified).toBe(false);
	});
});

describe("RN-13.5 — la barrera de privilegios (§8)", () => {
	test("un jefe clasifica pero no ve el importe del descuento", async () => {
		const result = await reviewed(
			head,
			await profileIdOf(employee),
			ABSENT_DAY,
			{ isJustified: false },
		);

		// Ve **el hecho**: se aplicó un descuento.
		expect(result.payrollAdjustment.effect).toBe("created");
		// Pero no la cifra, que es el sueldo dividido por el divisor (RN-17.1, H-3).
		expect(result.payrollAdjustment.amount).toBeNull();
		expect(result.payrollAdjustment.currency).toBeNull();

		// Y el ajuste existe igual, escrito por el servidor.
		expect(await adjustmentsOf(employee)).toHaveLength(1);
	});

	test("un rol administrativo sí ve el importe", async () => {
		const result = await reviewed(
			manager,
			await profileIdOf(employee),
			ABSENT_DAY,
			{ isJustified: false },
		);
		expect(result.payrollAdjustment.amount).toBe("-100.00");
	});

	test("no existe ningún endpoint de nómina que un jefe pueda tocar", async () => {
		// La barrera de hoy es que la superficie **no existe**: la spec 17 no está
		// construida y nada en `routes/` monta `/api/payroll`. Cuando exista, este
		// caso pasa de 404 a 403 y hay que actualizarlo.
		for (const path of [
			"/api/payroll/adjustments",
			"/api/payroll/salaries",
			"/api/payroll/summary",
		]) {
			expect((await request(path, { as: head })).status).toBe(404);
		}
	});
});

describe("RN-13.2 — una decisión por día", () => {
	test("dos clasificaciones del mismo día dejan una sola fila", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado.",
		});

		const rows = await db
			.select()
			.from(attendanceAbsenceReviews)
			.where(eq(attendanceAbsenceReviews.userId, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.isJustified).toBe(true);
		expect(rows[0]?.notes).toContain("Certificado");
	});

	test("días distintos son decisiones distintas", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		await reviewed(manager, id, SECOND_ABSENT_DAY, { isJustified: false });

		expect(
			await db
				.select()
				.from(attendanceAbsenceReviews)
				.where(eq(attendanceAbsenceReviews.userId, id)),
		).toHaveLength(2);
	});
});

describe("RN-13.8 — bitácora con el valor anterior (§8)", () => {
	test("la decisión y su cambio quedan registrados, y también el ajuste", async () => {
		const id = await profileIdOf(employee);
		const managerId = await profileIdOf(manager);

		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado.",
		});

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.actorId, managerId));

		const reviews = entries.filter((row) => row.action === "absence.reviewed");
		expect(reviews).toHaveLength(2);

		// El segundo lleva el valor anterior, que es lo que se querrá leer si
		// alguien pregunta por qué cambió una clasificación.
		const change = reviews.find(
			(row) =>
				(row.oldData as { isJustified?: boolean } | null)?.isJustified ===
				false,
		);
		expect(change).toBeDefined();
		expect((change?.newData as { isJustified: boolean }).isJustified).toBe(
			true,
		);

		// RN-17.9: los ajustes también, que en el legacy no llegaban (punto 76).
		expect(
			entries.filter((row) => row.action === "payroll_adjustment.created"),
		).toHaveLength(1);
		expect(
			entries.filter((row) => row.action === "payroll_adjustment.reverted"),
		).toHaveLength(1);
	});
});

describe("RN-13.7 — notificación al empleado (§8)", () => {
	test("la clasificación le llega, con el importe de su propio descuento", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });

		const rows = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, id),
					eq(notifications.type, "absence.reviewed"),
				),
			);
		expect(rows).toHaveLength(1);
		// Su propio sueldo sí: es el dato que necesita para reclamar.
		expect(rows[0]?.body).toContain("-100.00");
	});

	test("al justificar, el aviso dice que se revirtió", async () => {
		const id = await profileIdOf(employee);
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		await reviewed(manager, id, ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado.",
		});

		const rows = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, id),
					eq(notifications.type, "absence.reviewed"),
				),
			);
		expect(rows).toHaveLength(2);
		expect(rows.some((row) => row.body.includes("revirtió"))).toBe(true);
	});
});

describe("AJ/ANJ en el historial propio (§8, sustituto del reporte)", () => {
	test("sin revisar, el día ausente sale ANJ y sin descuento (RN-13.10)", async () => {
		const res = await request(
			`/api/attendance/me?from=${ABSENT_DAY}&to=${ABSENT_DAY}`,
			{ as: employee },
		);
		expect(res.status).toBe(200);

		const days = (await res.json()) as {
			status: string;
			absence: { code: string; reviewed: boolean; notes: string | null } | null;
		}[];
		expect(days[0]?.status).toBe("AUSENTE");
		expect(days[0]?.absence).toEqual({
			code: "ANJ",
			reviewed: false,
			notes: null,
		});
		expect(await adjustmentsOf(employee)).toHaveLength(0);
	});

	test("justificada, el mismo día sale AJ con las notas", async () => {
		await reviewed(manager, await profileIdOf(employee), ABSENT_DAY, {
			isJustified: true,
			notes: "Certificado médico.",
		});

		const res = await request(
			`/api/attendance/me?from=${ABSENT_DAY}&to=${ABSENT_DAY}`,
			{ as: employee },
		);
		const days = (await res.json()) as {
			absence: { code: string; reviewed: boolean; notes: string | null } | null;
		}[];
		expect(days[0]?.absence).toEqual({
			code: "AJ",
			reviewed: true,
			notes: "Certificado médico.",
		});
	});
});

describe("la bandeja de pendientes (§5)", () => {
	test("trae los días ausentes sin decisión del ámbito, y sólo del ámbito", async () => {
		const res = await request(
			`/api/absences/pending?from=${SECOND_ABSENT_DAY}&to=${ABSENT_DAY}`,
			{ as: head },
		);
		expect(res.status).toBe(200);

		const pending = (await res.json()) as {
			userId: string;
			date: string;
			departmentName: string | null;
		}[];

		// `employee`, `unpaid` y `head` están en el departamento del jefe: dos días
		// cada uno. `outsider` no aparece.
		const outsiderId = await profileIdOf(outsider);
		expect(pending.some((row) => row.userId === outsiderId)).toBe(false);
		expect(pending.length).toBe(6);
		expect(pending.every((row) => row.departmentName === name("equipo"))).toBe(
			true,
		);
		// Las más recientes primero.
		expect(pending[0]?.date).toBe(ABSENT_DAY);
	});

	test("una vez clasificado, el día deja la bandeja", async () => {
		const id = await profileIdOf(employee);
		const before = await request(
			`/api/absences/pending?from=${ABSENT_DAY}&to=${ABSENT_DAY}`,
			{ as: head },
		);
		const beforeRows = (await before.json()) as { userId: string }[];
		expect(beforeRows.some((row) => row.userId === id)).toBe(true);

		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });

		const after = await request(
			`/api/absences/pending?from=${ABSENT_DAY}&to=${ABSENT_DAY}`,
			{ as: head },
		);
		const afterRows = (await after.json()) as { userId: string }[];
		expect(afterRows.some((row) => row.userId === id)).toBe(false);
	});

	test("el conteo del badge coincide con la lista", async () => {
		const range = `from=${ABSENT_DAY}&to=${ABSENT_DAY}`;
		const list = (await (
			await request(`/api/absences/pending?${range}`, { as: head })
		).json()) as unknown[];
		const count = (await (
			await request(`/api/absences/pending-count?${range}`, { as: head })
		).json()) as { count: number };

		expect(count.count).toBe(list.length);
	});

	test("un jefe no puede acotar a un departamento fuera de su ámbito", async () => {
		expect(
			(
				await request(
					`/api/absences/pending?from=${ABSENT_DAY}&to=${ABSENT_DAY}&departmentId=${otherDepartmentId}`,
					{ as: head },
				)
			).status,
		).toBe(403);
	});
});

describe("las decisiones tomadas (§6)", () => {
	test("se listan por rango y se pueden acotar a una persona", async () => {
		const employeeId = await profileIdOf(employee);
		const unpaidId = await profileIdOf(unpaid);
		await reviewed(manager, employeeId, ABSENT_DAY, { isJustified: false });
		await reviewed(manager, unpaidId, ABSENT_DAY, { isJustified: false });

		const all = (await (
			await request(`/api/absences?from=${ABSENT_DAY}&to=${ABSENT_DAY}`, {
				as: head,
			})
		).json()) as { userId: string }[];
		expect(all).toHaveLength(2);

		const mine = (await (
			await request(
				`/api/absences?from=${ABSENT_DAY}&to=${ABSENT_DAY}&userId=${employeeId}`,
				{ as: head },
			)
		).json()) as { userId: string }[];
		expect(mine).toHaveLength(1);
		expect(mine[0]?.userId).toBe(employeeId);
	});

	test("un jefe no ve las decisiones de fuera de su ámbito", async () => {
		await reviewed(manager, await profileIdOf(outsider), ABSENT_DAY, {
			isJustified: false,
		});

		const rows = (await (
			await request(`/api/absences?from=${ABSENT_DAY}&to=${ABSENT_DAY}`, {
				as: head,
			})
		).json()) as unknown[];
		expect(rows).toHaveLength(0);
	});
});

describe("la acción combinada (spec 12 §9 decisión 1, cerrada)", () => {
	async function reportIncident(date: string, incidentType = "forgot_to_mark") {
		const res = await request("/api/incidents", {
			as: employee,
			method: "POST",
			body: {
				incidentType,
				date,
				reason: "Se me quedó el teléfono en casa.",
			},
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string };
	}

	test("aprobar sin pedirlo no justifica nada (RN-12.9 sigue en pie)", async () => {
		const incident = await reportIncident(ABSENT_DAY);
		const res = await request(`/api/incidents/${incident.id}/review`, {
			as: manager,
			method: "POST",
			body: { approved: true },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { absence: unknown }).absence).toBeNull();

		expect(
			await db
				.select()
				.from(attendanceAbsenceReviews)
				.where(
					eq(attendanceAbsenceReviews.userId, await profileIdOf(employee)),
				),
		).toHaveLength(0);
	});

	test("aprobar y justificar deja el día AJ y revierte el descuento", async () => {
		const id = await profileIdOf(employee);
		// Primero el descuento, para que haya algo que revertir.
		await reviewed(manager, id, ABSENT_DAY, { isJustified: false });
		expect(await adjustmentsOf(employee)).toHaveLength(1);

		const incident = await reportIncident(ABSENT_DAY);
		const res = await request(`/api/incidents/${incident.id}/review`, {
			as: manager,
			method: "POST",
			body: { approved: true, justifyAbsence: true },
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			absence: { date: string; payrollAdjustment: PayrollEffect } | null;
		};
		expect(body.absence?.date).toBe(ABSENT_DAY);
		expect(body.absence?.payrollAdjustment.effect).toBe("reverted");

		const rows = await adjustmentsOf(employee);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("reverted");

		// Y la decisión quedó registrada con su procedencia.
		const reviews = await db
			.select()
			.from(attendanceAbsenceReviews)
			.where(eq(attendanceAbsenceReviews.userId, id));
		expect(reviews).toHaveLength(1);
		expect(reviews[0]?.isJustified).toBe(true);
		// RN-13.6: hay notas, compuestas si el revisor no escribió ninguna.
		expect(reviews[0]?.notes).toContain("incidencia");
	});

	test("si ese día no es una ausencia, la aprobación sigue adelante sin tocar nada", async () => {
		// Una tardanza es un día **presente**: no hay ausencia que justificar. Es la
		// razón principal por la que la justificación no es automática.
		await db.insert(attendanceMarks).values({
			userId: await profileIdOf(employee),
			markType: "IN",
			markedAt: new Date(`${ABSENT_DAY}T12:00:00.000Z`),
			workDate: ABSENT_DAY,
			latitude: CENTER.latitude,
			longitude: CENTER.longitude,
			accuracy: 10,
			blocked: false,
			isLate: true,
			lateMinutes: 15,
		});

		const incident = await reportIncident(ABSENT_DAY, "late_arrival");
		const res = await request(`/api/incidents/${incident.id}/review`, {
			as: manager,
			method: "POST",
			body: { approved: true, justifyAbsence: true },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { absence: unknown }).absence).toBeNull();
		expect(await adjustmentsOf(employee)).toHaveLength(0);
	});

	test("rechazar y justificar a la vez no valida", async () => {
		const incident = await reportIncident(ABSENT_DAY);
		const res = await request(`/api/incidents/${incident.id}/review`, {
			as: manager,
			method: "POST",
			body: { approved: false, notes: "No cuadra.", justifyAbsence: true },
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"rechazada",
		);
	});
});
