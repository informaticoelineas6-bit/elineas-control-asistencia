import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de horarios y calendario laboral (spec 07 §7).
 *
 * De integración, por el mismo motivo que las de las specs 01, 02 y 06: con la RLS
 * fuera del proyecto (RN-00.1) el handler de Hono es la única barrera, así que sólo
 * se sustituye el Identity Server y todo lo demás —sesión, ámbito, transacciones,
 * bitácora y notificaciones— corre de verdad.
 *
 * Las reglas de tiempo no se prueban aquí: son puras y tienen su propio archivo
 * (`services/schedule-rules.test.ts`). Aquí se prueba lo que sólo se puede probar
 * con la base delante — autorización, ámbito, persistencia, avisos y bitácora.
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
const { auditLog, departments, notifications, profiles, workCalendar } =
	await import("#/db/schema");
const { getConfig } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-sched-${crypto.randomUUID().slice(0, 8)}`;

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
const otherHead = testUser("other-head", ["department_head"]);
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

async function createDepartment(suffix: string): Promise<string> {
	const res = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name(suffix) },
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function profileIdOf(who: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, who.identityUserId),
	});
	if (!row) throw new Error(`El perfil de ${who.identityUserId} no existe`);
	return row.id;
}

async function moveTo(who: TestUser, departmentId: string | null) {
	await db
		.update(profiles)
		.set({ departmentId })
		.where(eq(profiles.identityUserId, who.identityUserId));
}

/** Horario diurno de referencia: entra 07:45–08:15, sale 16:00–18:00. */
const dayShift = {
	checkinStartTime: "07:45",
	checkinEndTime: "08:15",
	checkoutStartTime: "16:00",
	checkoutEndTime: "18:00",
};

/** El departamento del jefe y del empleado; `foreign` queda fuera de su ámbito. */
let mine = "";
let foreign = "";

beforeAll(async () => {
	for (const who of [employee, head, otherHead, manager]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}

	mine = await createDepartment("propio");
	foreign = await createDepartment("ajeno");

	await moveTo(head, mine);
	await moveTo(employee, mine);
	await moveTo(otherHead, foreign);
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

	if (testDepartmentIds.length > 0) {
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(inArray(profiles.departmentId, testDepartmentIds));
		await db
			.delete(auditLog)
			.where(inArray(auditLog.recordId, testDepartmentIds));
	}
	if (testProfileIds.length > 0) {
		await db
			.delete(notifications)
			.where(inArray(notifications.userId, testProfileIds));
		await db.delete(auditLog).where(inArray(auditLog.actorId, testProfileIds));
		await db.delete(profiles).where(inArray(profiles.id, testProfileIds));
	}
	// Los horarios y las filas del calendario se van en cascada con su
	// departamento; las entradas de bitácora de un horario se identifican por el id
	// del propio horario, que ya no existe, así que se limpian por actor arriba.
	await db.delete(departments).where(like(departments.name, `${TAG}%`));
});

describe("autorización (spec 07 §5)", () => {
	test("sin sesión no se lee ni se escribe nada", async () => {
		expect((await request(`/api/departments/${mine}/schedule`)).status).toBe(
			401,
		);
		expect(
			(
				await request(`/api/departments/${mine}/schedule`, {
					method: "PUT",
					body: dayShift,
				})
			).status,
		).toBe(401);
		expect((await request("/api/me/schedule")).status).toBe(401);
	});

	test("un empleado no lee el horario ni el calendario de un departamento", async () => {
		expect(
			(await request(`/api/departments/${mine}/schedule`, { as: employee }))
				.status,
		).toBe(403);
		expect(
			(
				await request(
					`/api/departments/${mine}/calendar?from=2026-08-01&to=2026-08-31`,
					{ as: employee },
				)
			).status,
		).toBe(403);
	});

	test("un jefe lee lo de su ámbito y no lo de fuera (RN-03.2)", async () => {
		expect(
			(await request(`/api/departments/${mine}/schedule`, { as: head })).status,
		).toBe(200);
		expect(
			(await request(`/api/departments/${foreign}/schedule`, { as: head }))
				.status,
		).toBe(403);
		expect(
			(
				await request(
					`/api/departments/${foreign}/calendar?from=2026-08-01&to=2026-08-31`,
					{ as: head },
				)
			).status,
		).toBe(403);
	});

	test("un jefe no escribe el horario ni el calendario: es regla de empresa", async () => {
		expect(
			(
				await request(`/api/departments/${mine}/schedule`, {
					as: head,
					method: "PUT",
					body: dayShift,
				})
			).status,
		).toBe(403);
		expect(
			(
				await request(`/api/departments/${mine}/calendar`, {
					as: head,
					method: "PUT",
					body: { entries: [{ date: "2026-08-19", isWorkday: false }] },
				})
			).status,
		).toBe(403);
		expect(
			(
				await request(`/api/departments/${mine}/schedule`, {
					as: head,
					method: "DELETE",
				})
			).status,
		).toBe(403);
	});

	test("un departamento que no existe responde 404, no 500", async () => {
		const ghost = crypto.randomUUID();
		expect(
			(
				await request(`/api/departments/${ghost}/schedule`, {
					as: manager,
					method: "PUT",
					body: dayShift,
				})
			).status,
		).toBe(404);
	});
});

describe("horario del departamento (RN-07.1)", () => {
	test("sin horario configurado, la lectura devuelve null", async () => {
		const id = await createDepartment("sin horario");
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toBeNull();
	});

	test("se crea con la zona global y se puede releer", async () => {
		const id = await createDepartment("horario nuevo");
		const config = await getConfig();

		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.checkinStartTime).toBe("07:45");
		expect(body.checkoutEndTime).toBe("18:00");
		// RN-06.6: la zona del horario gana, y sin indicarla se toma la global.
		expect(body.timezone).toBe(config.global_timezone);
		expect(body.allowEarlyCheckin).toBe(false);

		const read = await request(`/api/departments/${id}/schedule`, {
			as: manager,
		});
		expect(await read.json()).toEqual(body);
	});

	test("el segundo PUT reemplaza, no crea un segundo horario", async () => {
		const id = await createDepartment("un solo horario");

		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});
		const second = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, checkinEndTime: "08:30", allowEarlyCheckin: true },
		});

		expect(second.status).toBe(200);
		const body = (await second.json()) as Record<string, unknown>;
		expect(body.checkinEndTime).toBe("08:30");
		expect(body.allowEarlyCheckin).toBe(true);
	});

	test("omitir la zona en un horario existente conserva la que tenía", async () => {
		const id = await createDepartment("zona conservada");

		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, timezone: "Asia/Tokyo" },
		});
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, checkoutEndTime: "19:00" },
		});

		expect(((await res.json()) as { timezone: string }).timezone).toBe(
			"Asia/Tokyo",
		);
	});

	test("una ventana invertida se rechaza con mensaje legible", async () => {
		const id = await createDepartment("ventana invertida");
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, checkinStartTime: "08:15", checkinEndTime: "07:45" },
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"ventana de entrada",
		);
	});

	test("una hora con formato inválido la para el esquema", async () => {
		const id = await createDepartment("hora inválida");
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, checkinStartTime: "7:45" },
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("HH:mm");
	});

	test("una zona horaria que no existe se rechaza", async () => {
		const id = await createDepartment("zona inexistente");
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, timezone: "America/Nowhere" },
		});

		expect(res.status).toBe(400);
	});

	test("una jornada nocturna se acepta (RN-07.5)", async () => {
		const id = await createDepartment("jornada nocturna");
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: {
				checkinStartTime: "22:00",
				checkinEndTime: "22:30",
				checkoutStartTime: "05:00",
				checkoutEndTime: "06:00",
			},
		});

		expect(res.status).toBe(200);
	});

	test("una jornada de más de 24 horas se rechaza", async () => {
		const id = await createDepartment("jornada imposible");
		// Entrar a las 08:00 y salir entre las 07:00 del día siguiente y las 06:00
		// del otro: la ventana de salida se pasa de la segunda medianoche.
		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: {
				checkinStartTime: "08:00",
				checkinEndTime: "09:00",
				checkoutStartTime: "07:00",
				checkoutEndTime: "06:00",
			},
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"24 horas",
		);
	});
});

describe("aviso a los miembros (RN-07.10)", () => {
	test("cambiar el horario genera una notificación por cada miembro", async () => {
		const id = await createDepartment("con miembros");
		await moveTo(employee, id);
		await moveTo(head, id);

		const memberIds = [await profileIdOf(employee), await profileIdOf(head)];

		await db
			.delete(notifications)
			.where(inArray(notifications.userId, memberIds));

		const res = await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});
		expect(res.status).toBe(200);

		const rows = await db
			.select()
			.from(notifications)
			.where(inArray(notifications.userId, memberIds));

		expect(rows.length).toBe(2);
		expect(new Set(rows.map((row) => row.userId))).toEqual(new Set(memberIds));
		expect(rows.every((row) => row.type === "schedule.changed")).toBe(true);
		// El cuerpo dice la ventana que queda, no "hubo un cambio": el aviso tiene
		// que servir sin abrir nada más.
		expect(rows[0]?.body).toContain("07:45");

		// Guardar exactamente lo mismo no vuelve a avisar: abrir el formulario y
		// darle a guardar no debe llegarle a toda la plantilla.
		await db.update(notifications).set({ readAt: new Date() });
		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});
		const unchanged = await db
			.select()
			.from(notifications)
			.where(inArray(notifications.userId, memberIds));
		expect(unchanged.every((row) => row.readAt !== null)).toBe(true);

		// Un cambio real sí, y **actualiza** el mismo aviso en vez de apilar otro.
		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, checkoutEndTime: "19:00" },
		});
		const afterChange = await db
			.select()
			.from(notifications)
			.where(inArray(notifications.userId, memberIds));
		expect(afterChange.length).toBe(2);
		expect(afterChange.every((row) => row.readAt === null)).toBe(true);

		await moveTo(employee, mine);
		await moveTo(head, mine);
	});
});

describe("calendario laboral (RN-07.6, RN-07.7, RN-07.8)", () => {
	test("el lote crea filas y el rango las devuelve ordenadas", async () => {
		const id = await createDepartment("calendario");

		const res = await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [
					{ date: "2026-12-25", isWorkday: false, note: "Feriado: Navidad" },
					{ date: "2026-12-24", isWorkday: true, lateToleranceMinutes: 30 },
				],
			},
		});
		expect(res.status).toBe(200);

		const saved = (await res.json()) as Array<Record<string, unknown>>;
		expect(saved.map((row) => row.date)).toEqual(["2026-12-24", "2026-12-25"]);

		const read = await request(
			`/api/departments/${id}/calendar?from=2026-12-01&to=2026-12-31`,
			{ as: manager },
		);
		const rows = (await read.json()) as Array<Record<string, unknown>>;
		expect(rows.length).toBe(2);
		expect(rows[0]?.lateToleranceMinutes).toBe(30);
		expect(rows[1]?.isWorkday).toBe(false);
		expect(rows[1]?.note).toBe("Feriado: Navidad");
	});

	test("el rango acota: lo de otro mes no sale", async () => {
		const id = await createDepartment("calendario acotado");
		await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: "2026-07-26", isWorkday: false }] },
		});

		const res = await request(
			`/api/departments/${id}/calendar?from=2026-08-01&to=2026-08-31`,
			{ as: manager },
		);
		expect((await res.json()) as unknown[]).toEqual([]);
	});

	test("el mismo lote reescribe una fecha ya guardada", async () => {
		const id = await createDepartment("calendario reescrito");
		await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: "2026-05-01", isWorkday: false }] },
		});

		const res = await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [
					{ date: "2026-05-01", isWorkday: true, lateToleranceMinutes: 15 },
				],
			},
		});

		const saved = (await res.json()) as Array<Record<string, unknown>>;
		expect(saved.length).toBe(1);
		expect(saved[0]?.isWorkday).toBe(true);
		expect(saved[0]?.lateToleranceMinutes).toBe(15);

		const rows = await db
			.select()
			.from(workCalendar)
			.where(
				and(
					eq(workCalendar.departmentId, id),
					eq(workCalendar.date, "2026-05-01"),
				),
			);
		expect(rows.length).toBe(1);
	});

	test("limpiar una fecha borra la fila: sin fila es laborable por defecto", async () => {
		const id = await createDepartment("calendario limpiado");
		await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: "2026-05-01", isWorkday: false }] },
		});

		const res = await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: { clearDates: ["2026-05-01"] },
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as unknown[]).toEqual([]);

		const rows = await db
			.select()
			.from(workCalendar)
			.where(eq(workCalendar.departmentId, id));
		expect(rows.length).toBe(0);
	});

	test("un lote vacío, con fechas repetidas o contradictorias se rechaza", async () => {
		const id = await createDepartment("calendario inválido");

		const cases = [
			{},
			{
				entries: [
					{ date: "2026-05-01", isWorkday: true },
					{ date: "2026-05-01", isWorkday: false },
				],
			},
			{
				entries: [{ date: "2026-05-01", isWorkday: true }],
				clearDates: ["2026-05-01"],
			},
			{ entries: [{ date: "2026-02-31", isWorkday: true }] },
			{
				entries: [
					{ date: "2026-05-01", isWorkday: true, lateToleranceMinutes: 999 },
				],
			},
		];

		for (const body of cases) {
			const res = await request(`/api/departments/${id}/calendar`, {
				as: manager,
				method: "PUT",
				body,
			});
			expect(res.status).toBe(400);
		}
	});

	test("un rango invertido o desmedido se rechaza", async () => {
		expect(
			(
				await request(
					`/api/departments/${mine}/calendar?from=2026-08-31&to=2026-08-01`,
					{ as: manager },
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/departments/${mine}/calendar?from=2000-01-01&to=2030-01-01`,
					{ as: manager },
				)
			).status,
		).toBe(400);
	});
});

describe("bitácora (RN-18.4)", () => {
	test("el horario y el calendario dejan rastro con valor anterior y nuevo", async () => {
		const id = await createDepartment("con bitácora");
		const actorId = await profileIdOf(manager);

		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});
		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: { ...dayShift, checkoutEndTime: "19:30" },
		});
		await request(`/api/departments/${id}/calendar`, {
			as: manager,
			method: "PUT",
			body: { entries: [{ date: "2026-09-01", isWorkday: false }] },
		});

		const rows = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.actorId, actorId));

		const created = rows.find(
			(row) =>
				row.action === "schedule.created" &&
				(row.metadata as { departmentId?: string })?.departmentId === id,
		);
		const updated = rows.find(
			(row) =>
				row.action === "schedule.updated" &&
				(row.metadata as { departmentId?: string })?.departmentId === id,
		);
		const calendar = rows.find(
			(row) => row.action === "work_calendar.updated" && row.recordId === id,
		);

		expect(created).toBeDefined();
		expect(created?.oldData).toBeNull();
		expect(updated?.oldData).toMatchObject({ checkoutEndTime: "18:00" });
		expect(updated?.newData).toMatchObject({ checkoutEndTime: "19:30" });
		expect(calendar?.metadata).toMatchObject({ dates: 1 });
	});
});

describe("quitar el horario y borrar el departamento (spec 01 §5.2)", () => {
	test("con horario, el departamento no se puede borrar; sin él, sí", async () => {
		const id = await createDepartment("borrado bloqueado");
		await request(`/api/departments/${id}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});

		const blocked = await request(`/api/departments/${id}`, {
			as: manager,
			method: "DELETE",
		});
		expect(blocked.status).toBe(409);
		expect(((await blocked.json()) as { error: string }).error).toContain(
			"horario",
		);

		expect(
			(
				await request(`/api/departments/${id}/schedule`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(200);
		expect(
			(
				await request(`/api/departments/${id}`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(200);
	});

	test("quitar un horario que no existe responde 404", async () => {
		const id = await createDepartment("sin horario que quitar");
		expect(
			(
				await request(`/api/departments/${id}/schedule`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(404);
	});
});

describe("el horario propio (GET /me/schedule)", () => {
	test("un empleado ve el de su departamento, con el calendario del mes", async () => {
		await request(`/api/departments/${mine}/schedule`, {
			as: manager,
			method: "PUT",
			body: dayShift,
		});

		const res = await request("/api/me/schedule", { as: employee });
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			department: { id: string } | null;
			schedule: { checkinStartTime: string } | null;
			timezone: string;
			today: { date: string; isWorkday: boolean; fromDefault: boolean };
			from: string;
			to: string;
			canMark: boolean;
		};

		expect(body.department?.id).toBe(mine);
		expect(body.schedule?.checkinStartTime).toBe("07:45");
		// Por defecto, el mes en curso de la zona del horario.
		expect(body.from.slice(8)).toBe("01");
		expect(body.today.date >= body.from).toBe(true);
		expect(body.today.date <= body.to).toBe(true);
		// Sin fila en el calendario, hoy es laborable (RN-07.7).
		expect(body.today.fromDefault).toBe(true);
		expect(body.today.isWorkday).toBe(true);
		expect(body.canMark).toBe(true);
	});

	test("la tolerancia de la fecha gana sobre la global (RN-07.8)", async () => {
		const res = await request("/api/me/schedule", { as: employee });
		const { today } = (await res.json()) as {
			today: { date: string };
		};

		await request(`/api/departments/${mine}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [
					{
						date: today.date,
						isWorkday: true,
						lateToleranceMinutes: 42,
						note: "Jornada especial",
					},
				],
			},
		});

		const after = await request("/api/me/schedule", { as: employee });
		const body = (await after.json()) as {
			today: {
				lateToleranceMinutes: number;
				toleranceSource: string;
				fromDefault: boolean;
				note: string | null;
			};
			entries: Array<{ date: string }>;
		};

		expect(body.today.lateToleranceMinutes).toBe(42);
		expect(body.today.toleranceSource).toBe("calendar");
		expect(body.today.fromDefault).toBe(false);
		expect(body.today.note).toBe("Jornada especial");
		expect(body.entries.some((entry) => entry.date === today.date)).toBe(true);

		await request(`/api/departments/${mine}/calendar`, {
			as: manager,
			method: "PUT",
			body: { clearDates: [today.date] },
		});
	});

	test("un día no laborable se ve como no laborable", async () => {
		const res = await request("/api/me/schedule", { as: employee });
		const { today } = (await res.json()) as { today: { date: string } };

		await request(`/api/departments/${mine}/calendar`, {
			as: manager,
			method: "PUT",
			body: {
				entries: [
					{ date: today.date, isWorkday: false, note: "Feriado de prueba" },
				],
			},
		});

		const after = await request("/api/me/schedule", { as: employee });
		const body = (await after.json()) as {
			today: { isWorkday: boolean; note: string | null };
		};
		expect(body.today.isWorkday).toBe(false);
		expect(body.today.note).toBe("Feriado de prueba");

		await request(`/api/departments/${mine}/calendar`, {
			as: manager,
			method: "PUT",
			body: { clearDates: [today.date] },
		});
	});

	test("un perfil sin departamento no revienta: devuelve el horario vacío", async () => {
		const orphan = testUser("orphan", ["employee"]);
		expect((await request("/api/me/permissions", { as: orphan })).status).toBe(
			200,
		);

		const res = await request("/api/me/schedule", { as: orphan });
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			department: unknown;
			schedule: unknown;
			entries: unknown[];
		};
		expect(body.department).toBeNull();
		expect(body.schedule).toBeNull();
		expect(body.entries).toEqual([]);
	});

	test("el gestor global no marca, y su horario lo dice (RN-07.12)", async () => {
		const res = await request("/api/me/schedule", { as: manager });
		const body = (await res.json()) as { canMark: boolean };
		expect(body.canMark).toBe(false);
	});

	test("un rango a medias se rechaza", async () => {
		expect(
			(await request("/api/me/schedule?from=2026-08-01", { as: employee }))
				.status,
		).toBe(400);
		expect(
			(
				await request("/api/me/schedule?from=2026-08-31&to=2026-08-01", {
					as: employee,
				})
			).status,
		).toBe(400);
	});

	test("un rango explícito manda sobre el mes en curso", async () => {
		const res = await request(
			"/api/me/schedule?from=2026-12-01&to=2026-12-31",
			{ as: employee },
		);
		const body = (await res.json()) as { from: string; to: string };
		expect(body.from).toBe("2026-12-01");
		expect(body.to).toBe("2026-12-31");
	});
});
