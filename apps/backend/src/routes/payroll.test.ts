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
	appRoleSchema,
	buildPayrollGrid,
	type PayrollAdjustment,
	type PayrollSalary,
	type PayrollSummary,
	toValueMatrix,
} from "@elineas/validations";
import { eq, inArray, like } from "drizzle-orm";
import { readXlsx } from "hucre/xlsx";

/**
 * Pruebas de la superficie de administración de nómina (spec 17 §8), contra la
 * base de desarrollo.
 *
 * Lo que aquí se comprueba y en ningún otro sitio se puede:
 *
 * - **RN-17.1** — los seis endpoints rechazan a un jefe y a un empleado. Es la
 *   otra mitad de la barrera de RN-13.5: el jefe *sí* provoca ajustes, llamando
 *   a `/absences`, y *no* puede leer ni escribir nómina. Hasta que estas rutas
 *   existieron, la prueba decía 404 —"aquí no hay nada"—; ahora dice 403.
 * - **RN-17.4** — revertir no borra: la fila sigue ahí, con autor, fecha y
 *   motivo. Se comprueba contando filas, no leyendo la respuesta.
 * - **RN-17.9 y RN-17.10** — cada ajuste manual deja bitácora y notifica a quien
 *   lo sufre. Los dos son huecos del legacy (punto 76).
 * - **El criterio de los totales** — que cuadren con la suma de los activos, y
 *   **moneda a moneda**: dos personas cobrando en monedas distintas no se suman.
 * - **RN-17.11** — el XLSX de ajustes se escribe, se vuelve a leer y se compara
 *   celda a celda con la cuadrícula, igual que el reporte mensual de la spec 16.
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
	auditLog,
	departments,
	employeeCompensation,
	notifications,
	payrollAdjustments,
	profiles,
} = await import("#/db/schema");

const app = createApp();
const TAG = `zz-pay-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
/** En otro departamento y cobrando en otra moneda: los totales no se mezclan. */
const outsider = testUser("outsider", ["employee"]);
/** Sin sueldo configurado: el caso de RN-17.7 en el listado de sueldos. */
const unpaid = testUser("unpaid", ["employee"]);
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

/** Un mes cerrado y propio de estas pruebas: no compite con datos reales. */
const PERIOD = "2026-04";
const OTHER_PERIOD = "2026-05";

let departmentId = "";
let otherDepartmentId = "";

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

type NewAdjustment = {
	userId: string;
	amount: string;
	category: "unjustified_absence" | "vacation" | "other";
	description: string;
	period?: string;
	currency?: string;
};

async function create(
	body: NewAdjustment,
	as: TestUser = manager,
): Promise<PayrollAdjustment> {
	const res = await request("/api/payroll/adjustments", {
		as,
		method: "POST",
		body,
	});
	expect(res.status).toBe(201);
	return (await res.json()) as PayrollAdjustment;
}

async function list(query = ""): Promise<PayrollAdjustment[]> {
	const res = await request(`/api/payroll/adjustments${query}`, {
		as: manager,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as PayrollAdjustment[];
}

async function summary(query = `?period=${PERIOD}`): Promise<PayrollSummary> {
	const res = await request(`/api/payroll/summary${query}`, { as: manager });
	expect(res.status).toBe(200);
	return (await res.json()) as PayrollSummary;
}

async function notificationsOf(who: TestUser) {
	return db
		.select()
		.from(notifications)
		.where(eq(notifications.userId, await profileIdOf(who)));
}

async function taggedProfileIds(): Promise<string[]> {
	const rows = await db
		.select({ id: profiles.id })
		.from(profiles)
		.where(like(profiles.identityUserId, `${TAG}%`));
	return rows.map((row) => row.id);
}

async function clearPayrollRows() {
	const ids = await taggedProfileIds();
	if (ids.length === 0) return;
	await db
		.delete(payrollAdjustments)
		.where(inArray(payrollAdjustments.userId, ids));
	await db.delete(notifications).where(inArray(notifications.userId, ids));
	await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
}

beforeAll(async () => {
	for (const who of [employee, outsider, unpaid, head, manager]) {
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
	expect(second.status).toBe(201);
	otherDepartmentId = ((await second.json()) as { id: string }).id;

	await moveTo(employee, departmentId);
	await moveTo(unpaid, departmentId);
	await moveTo(head, departmentId);
	await moveTo(outsider, otherDepartmentId);

	// `unpaid` se queda sin sueldo a propósito.
	for (const [who, salary, currency] of [
		[employee, "3000.00", "CUP"],
		[outsider, "1500.00", "USD"],
	] as const) {
		const id = await profileIdOf(who);
		expect(
			(
				await request(`/api/users/${id}/compensation`, {
					as: manager,
					method: "PUT",
					body: { monthlySalary: salary, currency },
				})
			).status,
		).toBe(200);
	}
});

afterEach(clearPayrollRows);

afterAll(async () => {
	const ids = await taggedProfileIds();
	const departmentIds = (
		await db
			.select({ id: departments.id })
			.from(departments)
			.where(like(departments.name, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length > 0) {
		await clearPayrollRows();
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

describe("RN-17.1 — acceso exclusivo", () => {
	/** Los seis endpoints de la §6, con el cuerpo mínimo que cada uno pide. */
	const endpoints = (id: string) =>
		[
			{ method: "GET", path: "/api/payroll/adjustments" },
			{ method: "GET", path: "/api/payroll/adjustments/export" },
			{
				method: "POST",
				path: "/api/payroll/adjustments",
				body: {
					userId: id,
					amount: "-10.00",
					category: "other",
					description: "prueba",
				},
			},
			{
				method: "POST",
				path: `/api/payroll/adjustments/${id}/revert`,
				body: { reason: "prueba" },
			},
			{ method: "GET", path: "/api/payroll/summary" },
			{ method: "GET", path: "/api/payroll/salaries" },
		] as const;

	test("un jefe recibe 403 en todos, no 404 (§8)", async () => {
		const id = await profileIdOf(employee);
		for (const endpoint of endpoints(id)) {
			const res = await request(endpoint.path, { as: head, ...endpoint });
			expect(`${endpoint.method} ${endpoint.path} → ${res.status}`).toBe(
				`${endpoint.method} ${endpoint.path} → 403`,
			);
		}
	});

	test("un empleado tampoco entra", async () => {
		const id = await profileIdOf(employee);
		for (const endpoint of endpoints(id)) {
			const res = await request(endpoint.path, { as: employee, ...endpoint });
			expect(res.status).toBe(403);
		}
	});

	test("sin sesión, 401", async () => {
		expect((await request("/api/payroll/adjustments")).status).toBe(401);
	});
});

describe("RN-17.8 — ajustes manuales", () => {
	test("se crea activo, con su periodo y su moneda heredada del sueldo", async () => {
		const adjustment = await create({
			userId: await profileIdOf(employee),
			amount: "-250.50",
			category: "other",
			description: "Anticipo de mayo",
			period: PERIOD,
		});

		expect(adjustment.amount).toBe("-250.50");
		expect(adjustment.status).toBe("active");
		expect(adjustment.effectivePeriod).toBe(`${PERIOD}-01`);
		// No se indicó moneda: la del sueldo de esa persona, como en el automático.
		expect(adjustment.currency).toBe("CUP");
		// Y sin origen, que es lo que lo distingue de un descuento por ausencia.
		expect(adjustment.sourceType).toBeNull();
		expect(adjustment.sourceId).toBeNull();
	});

	test("una bonificación es el mismo ajuste con otro signo", async () => {
		const adjustment = await create({
			userId: await profileIdOf(employee),
			amount: "1200",
			category: "other",
			description: "Estímulo por resultados",
			period: PERIOD,
		});
		expect(adjustment.amount).toBe("1200.00");
	});

	test("la moneda se puede forzar cuando no es la del sueldo", async () => {
		const adjustment = await create({
			userId: await profileIdOf(employee),
			amount: "-40.00",
			category: "other",
			description: "Descuento en divisa",
			period: PERIOD,
			currency: "USD",
		});
		expect(adjustment.currency).toBe("USD");
	});

	test("sin motivo no se crea (§4.2)", async () => {
		const res = await request("/api/payroll/adjustments", {
			as: manager,
			method: "POST",
			body: {
				userId: await profileIdOf(employee),
				amount: "-10.00",
				category: "other",
			},
		});
		expect(res.status).toBe(400);
	});

	test("un ajuste de cero no ajusta nada", async () => {
		const res = await request("/api/payroll/adjustments", {
			as: manager,
			method: "POST",
			body: {
				userId: await profileIdOf(employee),
				amount: "0",
				category: "other",
				description: "Nada",
			},
		});
		expect(res.status).toBe(400);
	});

	test("sobre un perfil que no existe, 404", async () => {
		const res = await request("/api/payroll/adjustments", {
			as: manager,
			method: "POST",
			body: {
				userId: crypto.randomUUID(),
				amount: "-10.00",
				category: "other",
				description: "Fantasma",
			},
		});
		expect(res.status).toBe(404);
	});

	test("dos ajustes manuales del mismo mes conviven (RN-17.5 no les aplica)", async () => {
		const userId = await profileIdOf(employee);
		await create({
			userId,
			amount: "-10.00",
			category: "other",
			description: "Uno",
			period: PERIOD,
		});
		await create({
			userId,
			amount: "-20.00",
			category: "other",
			description: "Otro",
			period: PERIOD,
		});

		expect(await list(`?period=${PERIOD}`)).toHaveLength(2);
	});
});

describe("RN-17.9 y RN-17.10 — bitácora y aviso", () => {
	test("crear deja entrada de bitácora y notifica a quien lo sufre", async () => {
		const adjustment = await create({
			userId: await profileIdOf(employee),
			amount: "-250.00",
			category: "other",
			description: "Rotura de equipo",
			period: PERIOD,
		});

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, adjustment.id));
		expect(entries.map((row) => row.action)).toContain(
			"payroll_adjustment.created",
		);

		const avisos = await notificationsOf(employee);
		expect(avisos).toHaveLength(1);
		expect(avisos[0]?.type).toBe("payroll_adjustment.applied");
		// El importe **sí** va en el cuerpo: es su propio dinero, y es el dato que
		// necesita para reclamar.
		expect(avisos[0]?.body).toContain("-250.00");
		expect(avisos[0]?.body).toContain("Rotura de equipo");
	});

	test("revertir también avisa, con su propio tipo", async () => {
		const adjustment = await create({
			userId: await profileIdOf(employee),
			amount: "-250.00",
			category: "other",
			description: "Rotura de equipo",
			period: PERIOD,
		});

		const res = await request(
			`/api/payroll/adjustments/${adjustment.id}/revert`,
			{ as: manager, method: "POST", body: { reason: "Se pagó aparte." } },
		);
		expect(res.status).toBe(200);

		const tipos = (await notificationsOf(employee)).map((row) => row.type);
		expect(tipos).toContain("payroll_adjustment.applied");
		expect(tipos).toContain("payroll_adjustment.reverted");
	});
});

describe("RN-17.4 — reversión, nunca borrado", () => {
	test("la fila sigue ahí, con autor, fecha y motivo", async () => {
		const created = await create({
			userId: await profileIdOf(employee),
			amount: "-250.00",
			category: "other",
			description: "Rotura de equipo",
			period: PERIOD,
		});

		const res = await request(`/api/payroll/adjustments/${created.id}/revert`, {
			as: manager,
			method: "POST",
			body: { reason: "El descuento no correspondía." },
		});
		expect(res.status).toBe(200);
		const reverted = (await res.json()) as PayrollAdjustment;

		expect(reverted.status).toBe("reverted");
		expect(reverted.revertReason).toBe("El descuento no correspondía.");
		expect(reverted.revertedBy).toBe(await profileIdOf(manager));
		expect(reverted.revertedAt).not.toBeNull();
		// Y **el importe no cambió**: el historial económico es inmutable.
		expect(reverted.amount).toBe(created.amount);

		const rows = await db
			.select()
			.from(payrollAdjustments)
			.where(eq(payrollAdjustments.id, created.id));
		expect(rows).toHaveLength(1);
	});

	test("sin motivo no se revierte", async () => {
		const created = await create({
			userId: await profileIdOf(employee),
			amount: "-250.00",
			category: "other",
			description: "Rotura de equipo",
			period: PERIOD,
		});

		const res = await request(`/api/payroll/adjustments/${created.id}/revert`, {
			as: manager,
			method: "POST",
			body: {},
		});
		expect(res.status).toBe(400);
	});

	test("revertir dos veces es 409, no un segundo autor", async () => {
		const created = await create({
			userId: await profileIdOf(employee),
			amount: "-250.00",
			category: "other",
			description: "Rotura de equipo",
			period: PERIOD,
		});

		const body = { reason: "Motivo suficiente." };
		const path = `/api/payroll/adjustments/${created.id}/revert`;
		expect(
			(await request(path, { as: manager, method: "POST", body })).status,
		).toBe(200);
		expect(
			(await request(path, { as: manager, method: "POST", body })).status,
		).toBe(409);
	});

	test("un ajuste que no existe es 404", async () => {
		const res = await request(
			`/api/payroll/adjustments/${crypto.randomUUID()}/revert`,
			{ as: manager, method: "POST", body: { reason: "Motivo suficiente." } },
		);
		expect(res.status).toBe(404);
	});
});

describe("§6 — el listado", () => {
	test("filtra por periodo, empleado, departamento, estado y categoría", async () => {
		const mine = await profileIdOf(employee);
		const theirs = await profileIdOf(outsider);

		const revertable = await create({
			userId: mine,
			amount: "-10.00",
			category: "other",
			description: "Uno",
			period: PERIOD,
		});
		await create({
			userId: mine,
			amount: "-20.00",
			category: "vacation",
			description: "Dos",
			period: PERIOD,
		});
		await create({
			userId: theirs,
			amount: "-30.00",
			category: "other",
			description: "Tres",
			period: PERIOD,
		});
		await create({
			userId: mine,
			amount: "-40.00",
			category: "other",
			description: "Cuatro",
			period: OTHER_PERIOD,
		});

		await request(`/api/payroll/adjustments/${revertable.id}/revert`, {
			as: manager,
			method: "POST",
			body: { reason: "Motivo suficiente." },
		});

		expect(await list(`?period=${PERIOD}`)).toHaveLength(3);
		expect(await list(`?period=${OTHER_PERIOD}`)).toHaveLength(1);
		expect(await list(`?period=${PERIOD}&userId=${mine}`)).toHaveLength(2);
		expect(
			await list(`?period=${PERIOD}&departmentId=${otherDepartmentId}`),
		).toHaveLength(1);
		expect(await list(`?period=${PERIOD}&status=active`)).toHaveLength(2);
		expect(await list(`?period=${PERIOD}&status=reverted`)).toHaveLength(1);
		expect(await list(`?period=${PERIOD}&category=vacation`)).toHaveLength(1);
	});

	test("sin periodo, el mes en curso", async () => {
		// No se compara contra una fecha calculada aquí: el mes en curso lo decide
		// la zona configurada (RN-06.6), y recalcularla en la prueba sería copiar la
		// implementación. Lo que se comprueba es la consecuencia: un ajuste sin
		// periodo cae en el listado sin periodo, y uno de otro mes no.
		await create({
			userId: await profileIdOf(employee),
			amount: "-15.00",
			category: "other",
			description: "De este mes",
		});
		await create({
			userId: await profileIdOf(employee),
			amount: "-25.00",
			category: "other",
			description: "De otro mes",
			period: PERIOD,
		});

		const rows = await list();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.description).toBe("De este mes");
	});

	test("trae el nombre de quien lo registró y el de quien lo revirtió", async () => {
		const created = await create({
			userId: await profileIdOf(employee),
			amount: "-10.00",
			category: "other",
			description: "Uno",
			period: PERIOD,
		});
		await request(`/api/payroll/adjustments/${created.id}/revert`, {
			as: manager,
			method: "POST",
			body: { reason: "Motivo suficiente." },
		});

		const [row] = await list(`?period=${PERIOD}`);
		expect(row?.createdByName).toBe(manager.identityUserId);
		expect(row?.revertedByName).toBe(manager.identityUserId);
		expect(row?.userFullName).toBe(employee.identityUserId);
	});

	test("un descuento automático se distingue por su origen (§5)", async () => {
		// El descuento por ausencia lo escribe `services/absences.ts` y su cadena
		// completa se prueba allí; lo que importa aquí es que el listado deje ver
		// **de dónde vino**, que es lo que la §5 pide para poder revertirlo.
		const reviewId = crypto.randomUUID();
		await db.insert(payrollAdjustments).values({
			userId: await profileIdOf(employee),
			amount: "-100.00",
			currency: "CUP",
			category: "unjustified_absence",
			description: "Ausencia injustificada del 2026-04-03",
			status: "active",
			sourceType: "absence_review",
			sourceId: reviewId,
			effectivePeriod: `${PERIOD}-01`,
		});

		const [row] = await list(`?period=${PERIOD}&category=unjustified_absence`);
		expect(row?.sourceType).toBe("absence_review");
		expect(row?.sourceId).toBe(reviewId);
		// Lo escribió el sistema dentro de la revisión, no una persona desde aquí.
		expect(row?.createdBy).toBeNull();
	});
});

describe("§6 — los totales", () => {
	test("cuadran con la suma de los activos, y no cuentan los revertidos", async () => {
		const mine = await profileIdOf(employee);
		await create({
			userId: mine,
			amount: "-100.00",
			category: "other",
			description: "Uno",
			period: PERIOD,
		});
		await create({
			userId: mine,
			amount: "-50.25",
			category: "other",
			description: "Dos",
			period: PERIOD,
		});
		const revertable = await create({
			userId: mine,
			amount: "-999.00",
			category: "other",
			description: "Tres",
			period: PERIOD,
		});
		await request(`/api/payroll/adjustments/${revertable.id}/revert`, {
			as: manager,
			method: "POST",
			body: { reason: "Motivo suficiente." },
		});

		const totals = await summary();
		expect(totals.totals).toHaveLength(1);
		expect(totals.totals[0]?.total).toBe("-150.25");
		expect(totals.totals[0]?.count).toBe(2);

		const employee1 = totals.byEmployee.find((row) => row.userId === mine);
		expect(employee1?.total).toBe("-150.25");

		const department = totals.byDepartment.find(
			(row) => row.departmentId === departmentId,
		);
		expect(department?.total).toBe("-150.25");
	});

	test("dos monedas no se suman en una cifra sin significado", async () => {
		await create({
			userId: await profileIdOf(employee),
			amount: "-100.00",
			category: "other",
			description: "En pesos",
			period: PERIOD,
		});
		await create({
			userId: await profileIdOf(outsider),
			amount: "-40.00",
			category: "other",
			description: "En divisa",
			period: PERIOD,
		});

		const totals = await summary();
		expect(totals.totals).toHaveLength(2);
		expect(totals.totals.find((row) => row.currency === "CUP")?.total).toBe(
			"-100.00",
		);
		expect(totals.totals.find((row) => row.currency === "USD")?.total).toBe(
			"-40.00",
		);
	});

	test("una bonificación resta del descuento, porque el importe lleva signo", async () => {
		const mine = await profileIdOf(employee);
		await create({
			userId: mine,
			amount: "-100.00",
			category: "other",
			description: "Descuento",
			period: PERIOD,
		});
		await create({
			userId: mine,
			amount: "30.00",
			category: "other",
			description: "Bonificación",
			period: PERIOD,
		});

		expect((await summary()).totals[0]?.total).toBe("-70.00");
	});

	test("un periodo sin ajustes no es un error, es una lista vacía", async () => {
		const totals = await summary("?period=2019-01");
		expect(totals.totals).toEqual([]);
		expect(totals.byDepartment).toEqual([]);
		expect(totals.byEmployee).toEqual([]);
	});
});

describe("§5 — los sueldos", () => {
	test("se ven todos, con su departamento, y quien no tiene sale con nulo", async () => {
		const res = await request("/api/payroll/salaries?search=" + TAG, {
			as: manager,
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()) as PayrollSalary[];

		const mine = rows.find((row) => row.email.includes(`${TAG}-employee`));
		expect(mine?.monthlySalary).toBe("3000.00");
		expect(mine?.currency).toBe("CUP");
		expect(mine?.departmentName).toBe(name("equipo"));

		// RN-17.7 — El que no genera descuento se ve, que es justo el sentido de
		// tener la lista: sin ella, "no tiene sueldo" no aparece en ningún sitio.
		const sinSueldo = rows.find((row) => row.email.includes(`${TAG}-unpaid`));
		expect(sinSueldo).toBeDefined();
		expect(sinSueldo?.monthlySalary).toBeNull();
	});

	test("se filtran por departamento", async () => {
		const res = await request(
			`/api/payroll/salaries?departmentId=${otherDepartmentId}`,
			{ as: manager },
		);
		const rows = (await res.json()) as PayrollSalary[];
		expect(rows.every((row) => row.departmentId === otherDepartmentId)).toBe(
			true,
		);
		expect(rows.some((row) => row.email.includes(`${TAG}-outsider`))).toBe(
			true,
		);
	});
});

describe("RN-17.11 — el periodo en una hoja de cálculo", () => {
	test("el XLSX coincide celda a celda con la cuadrícula", async () => {
		const mine = await profileIdOf(employee);
		await create({
			userId: mine,
			amount: "-100.00",
			category: "other",
			description: "Uno",
			period: PERIOD,
		});
		await create({
			userId: mine,
			amount: "250.00",
			category: "vacation",
			description: "Dos",
			period: PERIOD,
		});

		const rows = await list(`?period=${PERIOD}`);
		const expected = toValueMatrix(buildPayrollGrid(PERIOD, rows));

		const res = await request(
			`/api/payroll/adjustments/export?period=${PERIOD}`,
			{ as: manager },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Disposition")).toContain(
			`ajustes-nomina-${PERIOD}.xlsx`,
		);

		const workbook = await readXlsx(new Uint8Array(await res.arrayBuffer()));
		const actual = workbook.sheets[0]?.rows ?? [];

		expect(workbook.sheets[0]?.name).toBe(`Ajustes ${PERIOD}`);
		expect(actual.length).toBe(expected.length);
		for (const [index, expectedRow] of expected.entries()) {
			expect(actual[index]).toEqual(expectedRow);
		}
	});

	test("un periodo vacío exporta la cabecera, no un archivo roto", async () => {
		const res = await request(
			"/api/payroll/adjustments/export?period=2019-01",
			{ as: manager },
		);
		expect(res.status).toBe(200);

		const workbook = await readXlsx(new Uint8Array(await res.arrayBuffer()));
		expect(workbook.sheets[0]?.rows).toHaveLength(1);
	});
});
