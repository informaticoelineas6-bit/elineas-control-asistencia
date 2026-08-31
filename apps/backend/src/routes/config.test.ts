import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de configuración global (spec 06 §7).
 *
 * Igual que las de las specs 01 y 02: sólo se sustituye el Identity Server. El
 * middleware de sesión, los roles, la caché, la transacción y la bitácora corren
 * de verdad — con la RLS fuera (RN-00.1), el handler es la única barrera y
 * simularla no probaría nada.
 */

mock.module("#/lib/identity", () => ({
	IdentityError: class IdentityError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
		}
	},
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
const { appConfig, auditLog, departments, profiles } = await import(
	"#/db/schema"
);
const { invalidateConfigCache, getConfig } = await import(
	"#/services/config.ts"
);

const app = createApp();
const TAG = `zz-config-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Copia de **toda** la tabla antes de tocarla.
 *
 * Estas pruebas comparten base con el entorno de desarrollo y escriben claves
 * reales: sin esta copia, una tolerancia o una zona horaria puestas a mano por
 * alguien que está usando la aplicación desaparecerían sin dejar rastro.
 */
let savedConfig: (typeof appConfig.$inferSelect)[] = [];

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

/** Escribe una clave saltándose la API, para probar la lectura tolerante. */
async function writeRaw(key: string, value: unknown) {
	await db
		.insert(appConfig)
		.values({ key, value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: appConfig.key,
			set: { value, updatedAt: new Date() },
		});
	invalidateConfigCache();
}

async function clearKey(key: string) {
	await db.delete(appConfig).where(eq(appConfig.key, key));
	invalidateConfigCache();
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);

	for (const who of [employee, head, manager]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}
});

afterAll(async () => {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
	await db.delete(departments).where(like(departments.name, `${TAG}%`));

	// La tabla vuelve exactamente a como estaba, incluida la ausencia de claves.
	await db.delete(appConfig);
	if (savedConfig.length > 0) await db.insert(appConfig).values(savedConfig);
	invalidateConfigCache();
});

describe("autorización (RN-06.1)", () => {
	test("un department_head recibe 403 en GET /config", async () => {
		expect((await request("/api/config", { as: head })).status).toBe(403);
		expect((await request("/api/config", { as: employee })).status).toBe(403);
	});

	test("un department_head recibe 403 al escribir", async () => {
		const res = await request("/api/config", {
			as: head,
			method: "PATCH",
			body: { late_tolerance_minutes: 15 },
		});
		expect(res.status).toBe(403);
	});

	test("sin sesión no se lee ni la parte pública", async () => {
		expect((await request("/api/config/public")).status).toBe(401);
		expect((await request("/api/config")).status).toBe(401);
	});
});

describe("subconjunto público (spec 06 §5)", () => {
	test("cualquier autenticado lo lee, y no trae claves privadas", async () => {
		const res = await request("/api/config/public", { as: employee });
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(Object.keys(body).sort()).toEqual(
			[
				"attendance_auto_checkout_time",
				"attendance_checkout_mode",
				"attendance_geofence_exit_minutes",
				"global_timezone",
				"late_tolerance_minutes",
			].sort(),
		);
		// Lo que no le sirve a quien no gestiona, no viaja.
		expect(body).not.toHaveProperty("global_manager_department_id");
		expect(body).not.toHaveProperty("google_sheets_report_spreadsheet_id");
		expect(body).not.toHaveProperty("report_slo_availability_pct");
	});

	test("refleja lo guardado, no sólo los defaults", async () => {
		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { late_tolerance_minutes: 12 },
		});

		const body = (await (
			await request("/api/config/public", { as: employee })
		).json()) as { late_tolerance_minutes: number };
		expect(body.late_tolerance_minutes).toBe(12);

		await clearKey("late_tolerance_minutes");
	});
});

describe("defaults y tolerancia a valores corruptos (RN-06.2)", () => {
	test("una clave ausente en base devuelve el default de código", async () => {
		await clearKey("global_timezone");

		const body = (await (
			await request("/api/config", { as: manager })
		).json()) as { global_timezone: string };
		expect(body.global_timezone).toBe("America/Havana");
	});

	test("un valor con tipo inválido cae al default sin romper la app", async () => {
		await writeRaw("late_tolerance_minutes", "quince minutos");

		const res = await request("/api/config", { as: manager });
		const body = (await res.json()) as { late_tolerance_minutes: number };

		expect(res.status).toBe(200);
		expect(body.late_tolerance_minutes).toBe(0);

		await clearKey("late_tolerance_minutes");
	});

	test("una clave que ya no está en el catálogo se ignora", async () => {
		await writeRaw("clave_de_una_version_anterior", { lo: "que sea" });

		const res = await request("/api/config", { as: manager });
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body).not.toHaveProperty("clave_de_una_version_anterior");

		await clearKey("clave_de_una_version_anterior");
	});
});

describe("validación cruzada del modo de salida (RN-06.5)", () => {
	test("modo «schedule» sin hora de cierre se rechaza", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { attendance_checkout_mode: "schedule" },
		});

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toEqual({
			error:
				"Con el modo de salida «por horario» hay que indicar la hora de cierre automático.",
		});
	});

	test("modo «geofence_exit» sin minutos se rechaza", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { attendance_checkout_mode: "geofence_exit" },
		});
		expect(res.status).toBe(400);
	});

	test("con los dos valores juntos se acepta", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: {
				attendance_checkout_mode: "schedule",
				attendance_auto_checkout_time: "18:30",
			},
		});
		const body = (await res.json()) as {
			attendance_checkout_mode: string;
			attendance_auto_checkout_time: string;
		};

		expect(res.status).toBe(200);
		expect(body.attendance_checkout_mode).toBe("schedule");
		expect(body.attendance_auto_checkout_time).toBe("18:30");
	});

	test("la coherencia se juzga sobre el resultado, no sobre el parche", async () => {
		// Con el modo ya en `schedule` del test anterior, quitar la hora deja la
		// configuración incoherente aunque el parche por sí solo parezca inocente.
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { attendance_auto_checkout_time: null },
		});
		expect(res.status).toBe(400);

		await clearKey("attendance_checkout_mode");
		await clearKey("attendance_auto_checkout_time");
	});

	test("un formato de hora inválido lo para el esquema, no la regla", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { attendance_auto_checkout_time: "25:00" },
		});
		expect(res.status).toBe(400);
	});

	test("una zona horaria que no existe se rechaza", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { global_timezone: "America/Ciudad_Inventada" },
		});
		expect(res.status).toBe(400);
	});
});

describe("referencias a departamentos", () => {
	test("un departamento inexistente en el acotado de descansos se rechaza", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { rest_days_min_separation_departments: [crypto.randomUUID()] },
		});
		expect(res.status).toBe(400);
	});

	test("uno que existe se acepta y se puede vaciar", async () => {
		const created = await request("/api/departments", {
			as: manager,
			method: "POST",
			body: { name: `${TAG} descansos` },
		});
		const { id } = (await created.json()) as { id: string };

		const set = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { rest_days_min_separation_departments: [id] },
		});
		const body = (await set.json()) as {
			rest_days_min_separation_departments: string[];
		};
		expect(set.status).toBe(200);
		expect(body.rest_days_min_separation_departments).toEqual([id]);

		// Y mientras esté referenciado, no se puede borrar (spec 01 §3).
		expect(
			(
				await request(`/api/departments/${id}`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(409);

		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { rest_days_min_separation_departments: [] },
		});
		expect(
			(
				await request(`/api/departments/${id}`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(200);
	});
});

describe("bitácora y caché", () => {
	test("el cambio se registra con el valor anterior y el newcomer (RN-06.3)", async () => {
		await clearKey("report_slo_availability_pct");

		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { report_slo_availability_pct: 95 },
		});
		expect(res.status).toBe(200);

		const [entry] = await db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "config.updated"),
					eq(auditLog.recordId, "report_slo_availability_pct"),
				),
			);

		expect(entry?.oldData).toEqual({ report_slo_availability_pct: 99 });
		expect(entry?.newData).toEqual({ report_slo_availability_pct: 95 });

		await clearKey("report_slo_availability_pct");
	});

	test("una escritura invalida la caché de inmediato (RN-06.7)", async () => {
		// Se calienta la caché leyendo, y se escribe por la API sin tocarla a mano.
		expect((await getConfig()).include_heads_in_global_reports).toBe(true);

		await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { include_heads_in_global_reports: false },
		});

		// Sin invalidación, esto seguiría devolviendo el valor de hace un instante.
		expect((await getConfig()).include_heads_in_global_reports).toBe(false);

		await clearKey("include_heads_in_global_reports");
	});

	test("un parche vacío no escribe nada", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: {},
		});
		expect(res.status).toBe(400);
	});
});
