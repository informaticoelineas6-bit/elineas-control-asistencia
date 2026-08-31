import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { eq, inArray, like, sql } from "drizzle-orm";

/**
 * Pruebas de departamentos (spec 01) contra la base de desarrollo.
 *
 * **Por qué son de integración y no unitarias.** Con Supabase fuera, la RLS ya no
 * atrapa un fallo de autorización (RN-00.1): el handler de Hono es la única
 * barrera. Una prueba con la autorización simulada no probaría nada — comprobaría
 * el simulacro. Así que lo único que se sustituye es el **Identity Server**, y todo
 * lo demás (middleware de sesión, roles, ámbito, transacciones, bitácora) corre de
 * verdad.
 *
 * Requiere el Postgres del compose (`docker compose up -d postgres` y
 * `bun run db:migrate`).
 */

// El stub del IS se instala antes de importar cualquier cosa que lo use. La
// identidad y los roles viajan dentro de los propios tokens de prueba, así que no
// hay estado compartido entre casos.
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
	appConfig,
	auditLog,
	departments,
	employeeCompensation,
	notifications,
	profiles,
} = await import("#/db/schema");
const { invalidateConfigCache, setConfig } = await import(
	"#/services/config.ts"
);

const GM_KEY = "global_manager_department_id";

/**
 * Copia de la configuración real antes de tocarla: esta base se comparte con el
 * entorno de desarrollo, así que la clave se restaura tal como estaba en vez de
 * quedar borrada (ver el mismo comentario en `users.test.ts`).
 */
let savedConfigRow: typeof appConfig.$inferSelect | null = null;

async function saveConfig() {
	const [row] = await db
		.select()
		.from(appConfig)
		.where(eq(appConfig.key, GM_KEY));
	savedConfigRow = row ?? null;
}

async function restoreConfig() {
	await db.delete(appConfig).where(eq(appConfig.key, GM_KEY));
	if (savedConfigRow) await db.insert(appConfig).values(savedConfigRow);
	invalidateConfigCache();
}

const app = createApp();

/** Marca común para poder limpiar exactamente lo que crean estas pruebas. */
const TAG = `zz-test-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	const session = `sess|${identityUserId}|${roles.join(",")}`;
	return {
		identityUserId,
		cookie: `ca_session=${session}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
const head = testUser("head", ["department_head"]);
const manager = testUser("manager", ["global_manager"]);
const superadmin = testUser("superadmin", ["superadmin"]);
const outsiderHead = testUser("outsider-head", ["department_head"]);

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

/** Crea un departamento por la API, como gestor global. */
async function createDepartment(suffix: string): Promise<string> {
	const res = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: name(suffix) },
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { id: string };
	return body.id;
}

async function profileIdOf(testUser: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, testUser.identityUserId),
	});
	if (!row)
		throw new Error(`El perfil de ${testUser.identityUserId} no existe`);
	return row.id;
}

beforeAll(async () => {
	await saveConfig();

	// Un ingreso de cada persona crea su perfil (RN-00.46): a partir de aquí ya
	// existen en nuestra base, como pasaría en producción.
	for (const who of [employee, head, manager, superadmin, outsiderHead]) {
		const res = await request("/api/me/permissions", { as: who });
		expect(res.status).toBe(200);
	}
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

	// La bitácora es inmutable para la aplicación (RN-18.6); borrarla aquí es una
	// licencia de las pruebas, y por eso se limita a las entradas sobre registros
	// de prueba: las escritas por el sistema con actor nulo se van por `recordId`.
	const touchedRecords = [...testProfileIds, ...testDepartmentIds];
	if (touchedRecords.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.recordId, touchedRecords));
	}
	if (testProfileIds.length > 0) {
		await db
			.delete(notifications)
			.where(inArray(notifications.userId, testProfileIds));
		await db.delete(auditLog).where(inArray(auditLog.actorId, testProfileIds));
		await db.delete(profiles).where(inArray(profiles.id, testProfileIds));
	}
	await db.delete(departments).where(like(departments.name, `${TAG}%`));
	// Cualquier perfil que apunte a un departamento de prueba se desvincula antes
	// de borrarlo: si RN-03.6 movió dentro a un gestor real, esto lo deshace.
	if (testDepartmentIds.length > 0) {
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(inArray(profiles.departmentId, testDepartmentIds));
	}
	// Los avisos sobre personas de prueba se borran **por patrón**, no por lista de
	// perfiles: los que van dirigidos a un gestor real sobreviven al borrado del
	// perfil del que hablan —y algunas pruebas borran ese perfil a propósito—, así
	// que enumerarlos por id dejaría rastro en una bandeja ajena. El cuerpo empieza
	// por el nombre de la persona, que lleva la marca de esta ejecución.
	await db
		.delete(notifications)
		.where(sql`${notifications.body} like ${`${TAG}%`}`);

	await restoreConfig();
});

describe("autorización (spec 01 §2)", () => {
	test("sin sesión, todo responde 401", async () => {
		expect((await request("/api/departments")).status).toBe(401);
		expect(
			(
				await request("/api/departments", {
					method: "POST",
					body: { name: name("sin sesión") },
				})
			).status,
		).toBe(401);
	});

	test("cualquier autenticado ve la lista", async () => {
		const res = await request("/api/departments", { as: employee });
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	test("un empleado no puede crear, renombrar, pausar ni eliminar", async () => {
		const id = await createDepartment("empleado sin permiso");

		const cases = [
			{ path: "/api/departments", method: "POST", body: { name: name("x") } },
			{
				path: `/api/departments/${id}`,
				method: "PATCH",
				body: { name: name("y") },
			},
			{
				path: `/api/departments/${id}/pause`,
				method: "POST",
				body: { reason: "porque" },
			},
			{ path: `/api/departments/${id}/resume`, method: "POST" },
			{ path: `/api/departments/${id}`, method: "DELETE" },
		];

		for (const testCase of cases) {
			const res = await request(testCase.path, { as: employee, ...testCase });
			expect(res.status).toBe(403);
		}
	});

	test("un empleado no ve el detalle ni los miembros de un departamento", async () => {
		const id = await createDepartment("detalle vedado");

		expect(
			(await request(`/api/departments/${id}`, { as: employee })).status,
		).toBe(403);
		expect(
			(await request(`/api/departments/${id}/members`, { as: employee }))
				.status,
		).toBe(403);
	});

	test("un jefe ve el detalle de su departamento pero no el de other (RN-03.2)", async () => {
		const mine = await createDepartment("ámbito propio");
		const other = await createDepartment("ámbito ajeno");

		// El ámbito de un jefe es su propio departamento más los adicionales; se le
		// asigna el suyo como haría la gestión de usuarios (spec 02).
		await db
			.update(profiles)
			.set({ departmentId: mine })
			.where(eq(profiles.id, await profileIdOf(head)));

		expect(
			(await request(`/api/departments/${mine}`, { as: head })).status,
		).toBe(200);
		expect(
			(await request(`/api/departments/${other}`, { as: head })).status,
		).toBe(403);
		expect(
			(await request(`/api/departments/${mine}/members`, { as: head })).status,
		).toBe(200);
		expect(
			(await request(`/api/departments/${other}/members`, { as: head })).status,
		).toBe(403);
	});

	test("un jefe sin departamento no tiene ámbito sobre ninguno", async () => {
		const id = await createDepartment("sin ámbito");
		expect(
			(await request(`/api/departments/${id}`, { as: outsiderHead })).status,
		).toBe(403);
	});

	test("un jefe no puede crear ni pausar", async () => {
		const id = await createDepartment("jefe sin gestión");

		expect(
			(
				await request("/api/departments", {
					as: head,
					method: "POST",
					body: { name: name("jefe crea") },
				})
			).status,
		).toBe(403);
		expect(
			(
				await request(`/api/departments/${id}/pause`, {
					as: head,
					method: "POST",
					body: { reason: "porque" },
				})
			).status,
		).toBe(403);
	});

	test("un superadmin hereda todo lo del gestor global", async () => {
		const res = await request("/api/departments", {
			as: superadmin,
			method: "POST",
			body: { name: name("creado por superadmin") },
		});
		expect(res.status).toBe(201);
	});

	test("los miembros nunca traen el dato salarial (spec 02 §6)", async () => {
		const id = await createDepartment("sin salarios");
		const profileId = await profileIdOf(employee);
		await db
			.update(profiles)
			.set({ departmentId: id })
			.where(eq(profiles.id, profileId));
		await db
			.insert(employeeCompensation)
			.values({ profileId, monthlySalary: "3500.00" })
			.onConflictDoUpdate({
				target: employeeCompensation.profileId,
				set: { monthlySalary: "3500.00" },
			});

		const res = await request(`/api/departments/${id}/members`, {
			as: manager,
		});
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).not.toContain("3500");
		expect(body).not.toContain("monthlySalary");
		expect(body).not.toContain("salary");

		await db
			.delete(employeeCompensation)
			.where(eq(employeeCompensation.profileId, profileId));
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(eq(profiles.id, profileId));
	});
});

describe("criterios de aceptación (spec 01 §8)", () => {
	test("crear con nombre duplicado falla con un error legible (RN-01.1)", async () => {
		await createDepartment("duplicado");

		const res = await request("/api/departments", {
			as: manager,
			method: "POST",
			body: { name: name("duplicado") },
		});
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(409);
		expect(body.error).toContain("Ya existe un departamento");
		expect(body.error).toContain(name("duplicado"));
	});

	test("el nombre duplicado se detecta sin distinguir mayúsculas", async () => {
		await createDepartment("Mayúsculas");

		const res = await request("/api/departments", {
			as: manager,
			method: "POST",
			body: { name: name("Mayúsculas").toUpperCase() },
		});
		expect(res.status).toBe(409);
	});

	test("el nombre vacío se rechaza (RN-01.1)", async () => {
		const res = await request("/api/departments", {
			as: manager,
			method: "POST",
			body: { name: "   " },
		});
		expect(res.status).toBe(400);
	});

	test("eliminar un departamento con miembros falla y no borra nada (RN-01.2)", async () => {
		const id = await createDepartment("con miembros");
		const profileId = await profileIdOf(employee);
		await db
			.update(profiles)
			.set({ departmentId: id })
			.where(eq(profiles.id, profileId));

		const res = await request(`/api/departments/${id}`, {
			as: manager,
			method: "DELETE",
		});
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(409);
		expect(body.error).toContain("No se puede eliminar");

		// Y sigue existiendo: no hay borrado parcial ni en cascada.
		const still = await db.query.departments.findFirst({
			where: eq(departments.id, id),
		});
		expect(still).toBeTruthy();

		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(eq(profiles.id, profileId));
	});

	test("un perfil desactivado también bloquea el borrado", async () => {
		const id = await createDepartment("con inactivo");
		const [ghost] = await db
			.insert(profiles)
			.values({
				identityUserId: `${TAG}-ghost`,
				email: `${TAG}-ghost@test.local`,
				fullName: "Persona desactivada",
				departmentId: id,
				isActive: false,
			})
			.returning();

		const res = await request(`/api/departments/${id}`, {
			as: manager,
			method: "DELETE",
		});
		expect(res.status).toBe(409);

		if (ghost) await db.delete(profiles).where(eq(profiles.id, ghost.id));
	});

	test("un departamento vacío sí se elimina, y queda en la bitácora", async () => {
		const id = await createDepartment("vacío");

		const res = await request(`/api/departments/${id}`, {
			as: manager,
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		const gone = await db.query.departments.findFirst({
			where: eq(departments.id, id),
		});
		expect(gone).toBeUndefined();

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, id));
		expect(entries.map((entry) => entry.action)).toContain(
			"department.deleted",
		);
	});

	test("pausar exige motivo (RN-01.3)", async () => {
		const id = await createDepartment("pausa sin motivo");

		expect(
			(
				await request(`/api/departments/${id}/pause`, {
					as: manager,
					method: "POST",
					body: { reason: "" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await request(`/api/departments/${id}/pause`, {
					as: manager,
					method: "POST",
					body: {},
				})
			).status,
		).toBe(400);
	});

	test("pausar guarda motivo e instante, avisa a los miembros y queda en la bitácora", async () => {
		const id = await createDepartment("pausa completa");
		const profileId = await profileIdOf(employee);
		await db
			.update(profiles)
			.set({ departmentId: id })
			.where(eq(profiles.id, profileId));

		const res = await request(`/api/departments/${id}/pause`, {
			as: manager,
			method: "POST",
			body: { reason: "Inventario anual" },
		});
		const body = (await res.json()) as {
			isPaused: boolean;
			pauseReason: string;
			pausedAt: string;
		};

		expect(res.status).toBe(200);
		expect(body.isPaused).toBe(true);
		expect(body.pauseReason).toBe("Inventario anual");
		expect(body.pausedAt).not.toBeNull();

		// Bitácora, con el motivo (criterio de aceptación: "la pausa queda
		// registrada en la bitácora").
		const paused = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, id));
		const entry = paused.find((row) => row.action === "department.paused");
		expect(entry).toBeTruthy();
		expect(entry?.metadata).toMatchObject({ reason: "Inventario anual" });
		expect(entry?.actorId).toBe(await profileIdOf(manager));

		// Y el miembro tiene su aviso (spec 01 §5.1 paso 4).
		const avisos = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, profileId));
		expect(avisos.map((row) => row.type)).toContain("department.paused");
		expect(
			avisos.find((row) => row.type === "department.paused")?.body,
		).toContain("Inventario anual");

		// Reanudar limpia los tres campos (RN-01.5) y también se audita.
		const resumed = await request(`/api/departments/${id}/resume`, {
			as: manager,
			method: "POST",
		});
		const resumedBody = (await resumed.json()) as {
			isPaused: boolean;
			pauseReason: string | null;
			pausedAt: string | null;
		};

		expect(resumed.status).toBe(200);
		expect(resumedBody.isPaused).toBe(false);
		expect(resumedBody.pauseReason).toBeNull();
		expect(resumedBody.pausedAt).toBeNull();

		const afterResume = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, id));
		expect(afterResume.map((row) => row.action)).toContain(
			"department.resumed",
		);

		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(eq(profiles.id, profileId));
	});

	test("no se puede pausar dos veces ni reanudar lo que no está en pausa", async () => {
		const id = await createDepartment("doble pausa");

		expect(
			(
				await request(`/api/departments/${id}/resume`, {
					as: manager,
					method: "POST",
				})
			).status,
		).toBe(409);

		await request(`/api/departments/${id}/pause`, {
			as: manager,
			method: "POST",
			body: { reason: "una vez" },
		});
		expect(
			(
				await request(`/api/departments/${id}/pause`, {
					as: manager,
					method: "POST",
					body: { reason: "otra vez" },
				})
			).status,
		).toBe(409);
	});

	test("un departamento en pausa se distingue en la lista, con su motivo (RN-01.7)", async () => {
		const id = await createDepartment("visible en pausa");
		await request(`/api/departments/${id}/pause`, {
			as: manager,
			method: "POST",
			body: { reason: "Obra en el almacén" },
		});

		const res = await request("/api/departments", { as: employee });
		const list = (await res.json()) as {
			id: string;
			isPaused: boolean;
			pauseReason: string | null;
		}[];
		const found = list.find((row) => row.id === id);

		expect(found?.isPaused).toBe(true);
		expect(found?.pauseReason).toBe("Obra en el almacén");

		// Y con `includePaused=false` desaparece.
		const filtered = await request("/api/departments?includePaused=false", {
			as: employee,
		});
		const visible = (await filtered.json()) as { id: string }[];
		expect(visible.some((row) => row.id === id)).toBe(false);
	});
});

describe("grupos de descanso y conteos", () => {
	test("apagar los grupos de descanso no borra nada y se audita (RN-01.6)", async () => {
		const id = await createDepartment("grupos");

		await request(`/api/departments/${id}`, {
			as: manager,
			method: "PATCH",
			body: { restGroupsEnabled: true },
		});
		const off = await request(`/api/departments/${id}`, {
			as: manager,
			method: "PATCH",
			body: { restGroupsEnabled: false },
		});
		const body = (await off.json()) as { restGroupsEnabled: boolean };

		expect(off.status).toBe(200);
		expect(body.restGroupsEnabled).toBe(false);

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, id));
		expect(
			entries.filter((row) => row.action === "department.rest_groups_changed")
				.length,
		).toBe(2);
	});

	test("el detalle cuenta miembros totales y activos por separado", async () => {
		const id = await createDepartment("conteos");
		const activo = await profileIdOf(employee);
		await db
			.update(profiles)
			.set({ departmentId: id })
			.where(eq(profiles.id, activo));
		const [inactivo] = await db
			.insert(profiles)
			.values({
				identityUserId: `${TAG}-conteo-inactivo`,
				email: `${TAG}-conteo-inactivo@test.local`,
				fullName: "Inactivo",
				departmentId: id,
				isActive: false,
			})
			.returning();

		const res = await request(`/api/departments/${id}`, { as: manager });
		const body = (await res.json()) as {
			memberCount: number;
			activeMemberCount: number;
		};

		expect(body.memberCount).toBe(2);
		expect(body.activeMemberCount).toBe(1);

		if (inactivo) await db.delete(profiles).where(eq(profiles.id, inactivo.id));
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(eq(profiles.id, activo));
	});
});

describe("departamento de los gestores globales (RN-03.6)", () => {
	test("se aplica al iniciar sesión y protege al departamento del borrado", async () => {
		const id = await createDepartment("gestores");
		const managerProfileId = await profileIdOf(manager);

		await setConfig(
			{ global_manager_department_id: id },
			{ profileId: managerProfileId },
		);

		// La siguiente petición del gestor ya lo mueve al departamento configurado.
		const permissions = await request("/api/me/permissions", { as: manager });
		const body = (await permissions.json()) as {
			profile: { departmentId: string | null; isComplete: boolean };
		};
		expect(body.profile.departmentId).toBe(id);
		expect(body.profile.isComplete).toBe(true);

		// Y ese departamento no se puede eliminar mientras lo sea. Primero hay que
		// sacar de él al gestor, para que el bloqueo que responda sea el de la
		// configuración y no el de los miembros.
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(eq(profiles.id, managerProfileId));

		const res = await request(`/api/departments/${id}`, {
			as: superadmin,
			method: "DELETE",
		});
		const error = (await res.json()) as { error: string };
		expect(res.status).toBe(409);
		expect(error.error).toContain("gestores globales");

		await restoreConfig();
	});

	test("se puede quitar la marca dejando la clave en nulo", async () => {
		const id = await createDepartment("gestores quitados");
		const set = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { global_manager_department_id: id },
		});
		expect(set.status).toBe(200);

		const cleared = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { global_manager_department_id: null },
		});
		const body = (await cleared.json()) as {
			global_manager_department_id: string | null;
		};
		expect(cleared.status).toBe(200);
		expect(body.global_manager_department_id).toBeNull();

		// Y con la clave limpia, ese departamento vuelve a poder eliminarse. Antes hay
		// que sacar de él al gestor, que RN-03.6 metió dentro mientras estuvo marcado.
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(eq(profiles.id, await profileIdOf(manager)));

		expect(
			(
				await request(`/api/departments/${id}`, {
					as: manager,
					method: "DELETE",
				})
			).status,
		).toBe(200);
	});

	test("apuntar la configuración a un departamento inexistente se rechaza", async () => {
		const res = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { global_manager_department_id: crypto.randomUUID() },
		});
		expect(res.status).toBe(400);
	});

	test("la configuración no la lee un rol por debajo de gestor global (RN-06.1)", async () => {
		expect((await request("/api/config", { as: head })).status).toBe(403);
		expect((await request("/api/config", { as: employee })).status).toBe(403);
		expect((await request("/api/config", { as: manager })).status).toBe(200);
	});
});

describe("identificadores inválidos", () => {
	test("un id que no es uuid responde 400, no 500", async () => {
		const res = await request("/api/departments/no-es-uuid", { as: manager });
		expect(res.status).toBe(400);
	});
});
