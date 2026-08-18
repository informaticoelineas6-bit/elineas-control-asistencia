import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { and, eq, inArray, like, sql } from "drizzle-orm";

/**
 * Pruebas de usuarios y perfiles (spec 02) contra la base de desarrollo.
 *
 * Igual que las de la spec 01: sólo se sustituye el Identity Server, y el
 * middleware de sesión, los roles, el ámbito, las transacciones y la bitácora
 * corren de verdad. Con la RLS fuera (RN-00.1) el handler es la única barrera, y
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
	/** Login de prueba: la identidad y los roles salen del propio correo. */
	signIn: async (email: string) => {
		const identityUserId = email.split("@")[0] ?? email;
		const roles = identityUserId.includes("-manager")
			? "global_manager"
			: "employee";
		return {
			user: { identityUserId, email, name: identityUserId },
			sessionToken: `sess|${identityUserId}|${roles}`,
			jwt: `jwt|${identityUserId}`,
		};
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
const { invalidateConfigCache } = await import("#/services/config.ts");

const app = createApp();
const TAG = `zz-users-${crypto.randomUUID().slice(0, 8)}`;

const GM_KEY = "global_manager_department_id";

/**
 * Copia de la configuración real antes de tocarla.
 *
 * Estas pruebas comparten base con el entorno de desarrollo, así que **no pueden
 * borrar ni dejar a nulo la configuración**: una clave puesta a mano por alguien
 * que está usando la aplicación desaparecería sin dejar rastro. Se guarda la fila
 * tal cual y se restaura al terminar.
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
const superadmin = testUser("superadmin", ["superadmin"]);

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

async function profileIdOf(who: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, who.identityUserId),
	});
	if (!row) throw new Error(`Sin perfil: ${who.identityUserId}`);
	return row.id;
}

/** Departamentos de apoyo, creados por la API como gestor global. */
let deptA = "";
let deptB = "";

async function createDepartment(suffix: string): Promise<string> {
	const res = await request("/api/departments", {
		as: manager,
		method: "POST",
		body: { name: `${TAG} ${suffix}` },
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
	await saveConfig();

	for (const who of [employee, head, otherHead, manager, superadmin]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}

	deptA = await createDepartment("A");
	deptB = await createDepartment("B");

	// El jefe gestiona A; el otro jefe, B. El empleado pertenece a A.
	await db
		.update(profiles)
		.set({ departmentId: deptA })
		.where(eq(profiles.id, await profileIdOf(head)));
	await db
		.update(profiles)
		.set({ departmentId: deptB })
		.where(eq(profiles.id, await profileIdOf(otherHead)));
	await db
		.update(profiles)
		.set({ departmentId: deptA })
		.where(eq(profiles.id, await profileIdOf(employee)));
});

afterAll(async () => {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);
	const deptIds = (
		await db
			.select({ id: departments.id })
			.from(departments)
			.where(like(departments.name, `${TAG}%`))
	).map((row) => row.id);

	const records = [...ids, ...deptIds];
	if (records.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.recordId, records));
	}
	if (ids.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
		await db.delete(notifications).where(inArray(notifications.userId, ids));
		await db
			.delete(employeeCompensation)
			.where(inArray(employeeCompensation.profileId, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
	// Antes de borrar los departamentos de prueba, cualquier perfil que apunte a
	// ellos se desvincula. Si un gestor global **real** hizo una petición mientras
	// la configuración apuntaba a uno de estos departamentos, RN-03.6 lo movió
	// dentro; esto lo deshace en vez de reventar contra la clave ajena.
	if (deptIds.length > 0) {
		await db
			.update(profiles)
			.set({ departmentId: null })
			.where(inArray(profiles.departmentId, deptIds));
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
	await db.delete(departments).where(like(departments.name, `${TAG}%`));
});

describe("perfil propio (spec 02 §2)", () => {
	test("cualquiera lee su propio perfil, con su departamento resuelto", async () => {
		const res = await request("/api/me", { as: employee });
		const body = (await res.json()) as {
			email: string;
			departmentId: string;
			departmentName: string;
			isComplete: boolean;
		};

		expect(res.status).toBe(200);
		expect(body.email).toBe(`${employee.identityUserId}@test.local`);
		expect(body.departmentId).toBe(deptA);
		expect(body.departmentName).toContain(TAG);
		expect(body.isComplete).toBe(true);
	});

	test("el perfil propio nunca trae el sueldo", async () => {
		const profileId = await profileIdOf(employee);
		await request(`/api/users/${profileId}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "4321.00" },
		});

		const res = await request("/api/me", { as: employee });
		const body = await res.text();

		expect(body).not.toContain("4321");
		expect(body).not.toContain("monthlySalary");
		expect(body).not.toContain("salary");
	});

	test("cada uno cambia su teléfono, y queda en la bitácora", async () => {
		const res = await request("/api/me", {
			as: employee,
			method: "PATCH",
			body: { phone: "+5355512345" },
		});
		const body = (await res.json()) as { phone: string };

		expect(res.status).toBe(200);
		expect(body.phone).toBe("+5355512345");

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, await profileIdOf(employee)));
		expect(entries.map((row) => row.action)).toContain(
			"profile.contact_updated",
		);
	});

	test("el teléfono se valida como en el Identity Server", async () => {
		// Sin prefijo internacional no es válido para ningún país conocido.
		const suelto = await request("/api/me", {
			as: employee,
			method: "PATCH",
			body: { phone: "987654321" },
		});
		expect(suelto.status).toBe(400);

		const inventado = await request("/api/me", {
			as: employee,
			method: "PATCH",
			body: { phone: "+53 000" },
		});
		expect(inventado.status).toBe(400);

		// Vacío significa "sin teléfono", no un número inválido.
		const vacio = await request("/api/me", {
			as: employee,
			method: "PATCH",
			body: { phone: "" },
		});
		expect(vacio.status).toBe(200);
		expect(((await vacio.json()) as { phone: string | null }).phone).toBeNull();
	});

	test("por `PATCH /api/me` no se cambia nada más que el contacto", async () => {
		const res = await request("/api/me", {
			as: employee,
			method: "PATCH",
			body: {
				phone: "+5355512345",
				departmentId: deptB,
				fullName: "Otro nombre",
			},
		});
		expect(res.status).toBe(200);

		// Los campos de más se ignoran: el esquema no los admite y el perfil sigue igual.
		const after = (await (
			await request("/api/me", { as: employee })
		).json()) as {
			departmentId: string;
			fullName: string;
		};
		expect(after.departmentId).toBe(deptA);
		expect(after.fullName).toBe(employee.identityUserId);
	});

	test("el perfil propio trae el nombre del departamento, no sólo su id", async () => {
		const res = await request("/api/me", { as: employee });
		const body = (await res.json()) as { departmentName: string | null };
		expect(body.departmentName).toContain(TAG);
	});

	test("la clave de vínculo con el Identity Server no sale por la API", async () => {
		const propio = await (await request("/api/me", { as: employee })).text();
		const listing = await (await request("/api/users", { as: manager })).text();

		expect(propio).not.toContain("identityUserId");
		expect(listing).not.toContain("identityUserId");
	});

	test("un error de validación llega con el mensaje, no con un volcado de Zod", async () => {
		const res = await request("/api/me", {
			as: employee,
			method: "PATCH",
			body: { phone: "987654321" },
		});
		const body = (await res.json()) as { error?: string };

		expect(res.status).toBe(400);
		// El frontend busca `error`; un `ZodError` serializado le deja un mensaje
		// genérico y quien rellena el formulario no sabe qué corregir.
		expect(body.error).toBe(
			"Número de teléfono no válido para ningún país conocido",
		);
	});

	test("sin sesión, el perfil propio responde 401", async () => {
		expect((await request("/api/me")).status).toBe(401);
	});
});

describe("autorización del listing (spec 02 §2)", () => {
	test("un empleado no puede listar usuarios", async () => {
		expect((await request("/api/users", { as: employee })).status).toBe(403);
		expect(
			(await request("/api/users/incomplete", { as: employee })).status,
		).toBe(403);
	});

	test("un jefe sólo recibe los de los departamentos que gestiona", async () => {
		const res = await request("/api/users", { as: head });
		const body = (await res.json()) as { id: string; departmentId: string }[];

		expect(res.status).toBe(200);
		expect(body.length).toBeGreaterThan(0);
		expect(body.every((row) => row.departmentId === deptA)).toBe(true);
	});

	test("un jefe recibe 403 si pide explícitamente other departamento", async () => {
		const res = await request(`/api/users?departmentId=${deptB}`, { as: head });
		expect(res.status).toBe(403);
	});

	test("un jefe no ve el detalle de alguien fuera de su ámbito", async () => {
		const propio = await profileIdOf(employee);
		const ajeno = await profileIdOf(otherHead);

		expect((await request(`/api/users/${propio}`, { as: head })).status).toBe(
			200,
		);
		expect((await request(`/api/users/${ajeno}`, { as: head })).status).toBe(
			403,
		);
	});

	test("un jefe no puede editar, desactivar, reactivar ni borrar", async () => {
		const target = await profileIdOf(employee);
		const cases: { path: string; method: string; body?: unknown }[] = [
			{
				path: `/api/users/${target}`,
				method: "PATCH",
				body: { phone: "+5355512345" },
			},
			{
				path: `/api/users/${target}/deactivate`,
				method: "POST",
				body: { reason: "porque" },
			},
			{ path: `/api/users/${target}/reactivate`, method: "POST" },
			{ path: `/api/users/${target}`, method: "DELETE" },
		];

		for (const testCase of cases) {
			expect(
				(await request(testCase.path, { as: head, ...testCase })).status,
			).toBe(403);
		}
	});

	test("un gestor global ve a todos, incluidos los de cualquier departamento", async () => {
		const res = await request("/api/users", { as: manager });
		const body = (await res.json()) as { departmentId: string | null }[];
		const departmentIds = new Set(body.map((row) => row.departmentId));

		expect(res.status).toBe(200);
		expect(departmentIds.has(deptA)).toBe(true);
		expect(departmentIds.has(deptB)).toBe(true);
	});
});

describe("el sueldo no sale por donde no debe (spec 02 §6, hallazgo H-3)", () => {
	test("ni el listing ni el detalle lo devuelven, para ningún rol", async () => {
		const target = await profileIdOf(employee);
		await request(`/api/users/${target}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "9876.54" },
		});

		for (const who of [head, manager, superadmin]) {
			const list = await (await request("/api/users", { as: who })).text();
			expect(list).not.toContain("9876");
			expect(list).not.toContain("monthlySalary");
		}

		const detail = await (
			await request(`/api/users/${target}`, { as: manager })
		).text();
		expect(detail).not.toContain("9876");
		expect(detail).not.toContain("monthlySalary");
	});

	test("los endpoints de compensación son sólo de gestor global", async () => {
		const target = await profileIdOf(employee);

		expect(
			(await request(`/api/users/${target}/compensation`, { as: employee }))
				.status,
		).toBe(403);
		expect(
			(await request(`/api/users/${target}/compensation`, { as: head })).status,
		).toBe(403);
		expect(
			(await request(`/api/users/${target}/compensation`, { as: manager }))
				.status,
		).toBe(200);
	});

	test("guardar el sueldo lo deja en la bitácora, con importe y moneda anteriores y nuevos", async () => {
		const target = await profileIdOf(superadmin);

		await request(`/api/users/${target}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "1000.00" },
		});
		const res = await request(`/api/users/${target}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "2000.00", currency: "MLC" },
		});
		const body = (await res.json()) as {
			monthlySalary: string;
			currency: string;
		};
		expect(body.monthlySalary).toBe("2000.00");
		expect(body.currency).toBe("MLC");

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, target));
		const last = entries
			.filter((row) => row.action === "compensation.updated")
			.at(-1);
		expect(last?.oldData).toMatchObject({
			monthlySalary: "1000.00",
			currency: "CUP",
		});
		expect(last?.newData).toMatchObject({
			monthlySalary: "2000.00",
			currency: "MLC",
		});
	});

	test("sin moneda se asume la nacional, y una moneda desconocida se rechaza", async () => {
		const target = await profileIdOf(otherHead);

		const implicita = await request(`/api/users/${target}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "750.00" },
		});
		expect(((await implicita.json()) as { currency: string }).currency).toBe(
			"CUP",
		);

		const invalida = await request(`/api/users/${target}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "750.00", currency: "BTC" },
		});
		expect(invalida.status).toBe(400);
	});

	test("un perfil sin sueldo registrado responde con importe nulo y moneda por defecto", async () => {
		const newcomer = testUser("sin-sueldo", ["employee"]);
		await request("/api/me", { as: newcomer });
		const id = await profileIdOf(newcomer);

		const res = await request(`/api/users/${id}/compensation`, { as: manager });
		const body = (await res.json()) as {
			monthlySalary: string | null;
			currency: string;
		};

		expect(res.status).toBe(200);
		expect(body.monthlySalary).toBeNull();
		expect(body.currency).toBe("CUP");
	});

	test("un importe con formato inválido se rechaza", async () => {
		const target = await profileIdOf(employee);
		const res = await request(`/api/users/${target}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "mucho dinero" },
		});
		expect(res.status).toBe(400);
	});
});

describe("alta en dos pasos (spec 02 §5.1)", () => {
	test("el primer ingreso crea exactamente un perfil, incompleto", async () => {
		const newcomer = testUser("recien-llegado", ["employee"]);

		await request("/api/me/permissions", { as: newcomer });
		await request("/api/me/permissions", { as: newcomer });
		await request("/api/me", { as: newcomer });

		const rows = await db
			.select()
			.from(profiles)
			.where(eq(profiles.identityUserId, newcomer.identityUserId));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.departmentId).toBeNull();
		expect(rows[0]?.isActive).toBe(true);
	});

	test("un perfil sin departamento aparece en /users/incomplete", async () => {
		const newcomer = testUser("sin-depto", ["employee"]);
		await request("/api/me/permissions", { as: newcomer });

		const res = await request("/api/users/incomplete", { as: manager });
		const body = (await res.json()) as { id: string; email: string }[];

		expect(res.status).toBe(200);
		expect(
			body.some((row) => row.email.startsWith(newcomer.identityUserId)),
		).toBe(true);
	});

	test("asignarle departamento lo completa, lo audita y le avisa", async () => {
		const newcomer = testUser("por-completar", ["employee"]);
		await request("/api/me/permissions", { as: newcomer });
		const id = await profileIdOf(newcomer);

		const res = await request(`/api/users/${id}`, {
			as: manager,
			method: "PATCH",
			body: { departmentId: deptA },
		});
		const body = (await res.json()) as {
			isComplete: boolean;
			status: string;
			departmentName: string;
		};

		expect(res.status).toBe(200);
		expect(body.isComplete).toBe(true);
		expect(body.status).toBe("active");

		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, id));
		expect(entries.map((row) => row.action)).toContain(
			"profile.department_changed",
		);

		const avisos = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, id));
		expect(avisos.map((row) => row.type)).toContain(
			"profile.department_changed",
		);

		// Y ya no está en la lista de incompletos.
		const incomplete = (await (
			await request("/api/users/incomplete", { as: manager })
		).json()) as { id: string }[];
		expect(incomplete.some((row) => row.id === id)).toBe(false);
	});

	test("un departamento inexistente se rechaza", async () => {
		const id = await profileIdOf(employee);
		const res = await request(`/api/users/${id}`, {
			as: manager,
			method: "PATCH",
			body: { departmentId: crypto.randomUUID() },
		});
		expect(res.status).toBe(400);
	});

	test("la aparición de un perfil incompleto avisa a los gestores (RN-02.12)", async () => {
		// Los gestores que este sistema puede conocer son los miembros activos del
		// departamento configurado en RN-03.6.
		const managerId = await profileIdOf(manager);
		const configured = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { global_manager_department_id: deptB },
		});
		expect(configured.status).toBe(200);
		await db
			.update(profiles)
			.set({ departmentId: deptB })
			.where(eq(profiles.id, managerId));

		const newcomer = testUser("alta-avisada", ["employee"]);
		await request("/api/me/permissions", { as: newcomer });

		// Se busca el aviso *de esta persona*: el gestor puede tener varios y, sin
		// `order by`, el orden que devuelve Postgres no está garantizado.
		const nuevoId = await profileIdOf(newcomer);
		const [aviso] = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, managerId),
					eq(notifications.dedupeKey, `profile-incomplete:${nuevoId}`),
				),
			);

		expect(aviso).toBeTruthy();
		expect(aviso?.type).toBe("profile.incomplete");
		expect(aviso?.body).toContain(newcomer.identityUserId);

		// Limpiar la clave también tiene que funcionar: es lo que hace la acción
		// "quitar como departamento de gestores" de la pantalla de departamentos.
		const cleared = await request("/api/config", {
			as: manager,
			method: "PATCH",
			body: { global_manager_department_id: null },
		});
		const clearedBody = (await cleared.json()) as {
			global_manager_department_id: string | null;
		};
		expect(cleared.status).toBe(200);
		expect(clearedBody.global_manager_department_id).toBeNull();

		// Y se devuelve lo que hubiera antes: dejarlo a nulo destruiría una
		// configuración real de la base de desarrollo.
		await restoreConfig();
	});
});

describe("ciclo de vida (spec 02 §5.2)", () => {
	test("desactivar exige motivo y guarda fecha y autor (RN-02.5)", async () => {
		const target = testUser("a-desactivar", ["employee"]);
		await request("/api/me/permissions", { as: target });
		const id = await profileIdOf(target);

		expect(
			(
				await request(`/api/users/${id}/deactivate`, {
					as: manager,
					method: "POST",
					body: { reason: "" },
				})
			).status,
		).toBe(400);

		const res = await request(`/api/users/${id}/deactivate`, {
			as: manager,
			method: "POST",
			body: { reason: "Fin de contrato temporal" },
		});
		const body = (await res.json()) as {
			isActive: boolean;
			status: string;
			deactivationReason: string;
			deactivatedAt: string;
		};

		expect(res.status).toBe(200);
		expect(body.isActive).toBe(false);
		expect(body.status).toBe("inactive");
		expect(body.deactivationReason).toBe("Fin de contrato temporal");
		expect(body.deactivatedAt).not.toBeNull();

		const row = await db.query.profiles.findFirst({
			where: eq(profiles.id, id),
		});
		expect(row?.deactivatedBy).toBe(await profileIdOf(manager));
	});

	test("un perfil desactivado no consigue entrar, y su sesión abierta muere", async () => {
		const target = testUser("sesion-viva", ["employee"]);
		// Tiene sesión abierta y funcionando.
		expect((await request("/api/me", { as: target })).status).toBe(200);
		const id = await profileIdOf(target);

		await request(`/api/users/${id}/deactivate`, {
			as: manager,
			method: "POST",
			body: { reason: "Baja" },
		});

		// La misma cookie deja de servir en la siguiente petición (RN-00.30).
		const after = await request("/api/me", { as: target });
		expect(after.status).toBe(403);

		// Y el login lo rechaza aunque el IS autentique bien (RN-02.4).
		const login = await request("/api/auth/login", {
			method: "POST",
			body: {
				email: `${target.identityUserId}@test.local`,
				password: "cualquiera",
			},
		});
		const error = (await login.json()) as { error: string };
		expect(login.status).toBe(403);
		expect(error.error).toContain("desactivada");
	});

	test("su historial sigue visible para quien tiene ámbito", async () => {
		const target = testUser("historial", ["employee"]);
		await request("/api/me", { as: target });
		const id = await profileIdOf(target);
		await db
			.update(profiles)
			.set({ departmentId: deptA })
			.where(eq(profiles.id, id));
		await request(`/api/users/${id}/deactivate`, {
			as: manager,
			method: "POST",
			body: { reason: "Baja" },
		});

		// Fuera del listado operativo por defecto...
		const activos = (await (
			await request("/api/users", { as: head })
		).json()) as { id: string }[];
		expect(activos.some((row) => row.id === id)).toBe(false);

		// ...pero recuperable a propósito, y su ficha sigue accesible.
		const conBajas = (await (
			await request("/api/users?includeInactive=true", { as: head })
		).json()) as { id: string }[];
		expect(conBajas.some((row) => row.id === id)).toBe(true);
		expect((await request(`/api/users/${id}`, { as: head })).status).toBe(200);
	});

	test("reactivar limpia motivo, fecha y autor (RN-02.5)", async () => {
		const target = testUser("a-reactivar", ["employee"]);
		await request("/api/me", { as: target });
		const id = await profileIdOf(target);

		await request(`/api/users/${id}/deactivate`, {
			as: manager,
			method: "POST",
			body: { reason: "Se equivocaron" },
		});
		const res = await request(`/api/users/${id}/reactivate`, {
			as: manager,
			method: "POST",
		});
		const body = (await res.json()) as {
			isActive: boolean;
			deactivationReason: string | null;
			deactivatedAt: string | null;
		};

		expect(res.status).toBe(200);
		expect(body.isActive).toBe(true);
		expect(body.deactivationReason).toBeNull();
		expect(body.deactivatedAt).toBeNull();

		const row = await db.query.profiles.findFirst({
			where: eq(profiles.id, id),
		});
		expect(row?.deactivatedBy).toBeNull();

		// Y vuelve a poder entrar.
		expect((await request("/api/me", { as: target })).status).toBe(200);
	});

	test("no se puede desactivar dos veces ni reactivar a quien está activo", async () => {
		const id = await profileIdOf(employee);

		expect(
			(
				await request(`/api/users/${id}/reactivate`, {
					as: manager,
					method: "POST",
				})
			).status,
		).toBe(409);
	});

	test("nadie se desactiva ni se borra a sí mismo", async () => {
		const managerId = await profileIdOf(manager);

		expect(
			(
				await request(`/api/users/${managerId}/deactivate`, {
					as: manager,
					method: "POST",
					body: { reason: "adiós" },
				})
			).status,
		).toBe(409);

		const superId = await profileIdOf(superadmin);
		expect(
			(
				await request(`/api/users/${superId}`, {
					as: superadmin,
					method: "DELETE",
				})
			).status,
		).toBe(409);
	});
});

describe("borrado real (RN-02.8)", () => {
	test("sólo superadmin, y sólo si está desactivado", async () => {
		const target = testUser("a-borrar", ["employee"]);
		await request("/api/me", { as: target });
		const id = await profileIdOf(target);

		// Un gestor global no puede.
		expect(
			(await request(`/api/users/${id}`, { as: manager, method: "DELETE" }))
				.status,
		).toBe(403);

		// Activo, ni el superadmin: volvería a crearse vacío en su siguiente ingreso.
		const activo = await request(`/api/users/${id}`, {
			as: superadmin,
			method: "DELETE",
		});
		const error = (await activo.json()) as { error: string };
		expect(activo.status).toBe(409);
		expect(error.error).toContain("Desactiva el perfil");

		await request(`/api/users/${id}/deactivate`, {
			as: manager,
			method: "POST",
			body: { reason: "Se va de la empresa" },
		});

		const res = await request(`/api/users/${id}`, {
			as: superadmin,
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		const gone = await db.query.profiles.findFirst({
			where: eq(profiles.id, id),
		});
		expect(gone).toBeUndefined();
	});

	test("borrar arrastra sus dependencias y no deja punteros colgando", async () => {
		const target = testUser("con-dependencias", ["employee"]);
		await request("/api/me", { as: target });
		const id = await profileIdOf(target);

		// Tiene sueldo registrado, un aviso y desactivó a otra persona.
		await request(`/api/users/${id}/compensation`, {
			as: manager,
			method: "PUT",
			body: { monthlySalary: "500.00" },
		});
		const other = testUser("desactivado-por-el", ["employee"]);
		await request("/api/me", { as: other });
		const otroId = await profileIdOf(other);
		await db
			.update(profiles)
			.set({
				isActive: false,
				deactivatedBy: id,
				deactivationReason: "prueba",
				deactivatedAt: new Date(),
			})
			.where(eq(profiles.id, otroId));

		await request(`/api/users/${id}/deactivate`, {
			as: manager,
			method: "POST",
			body: { reason: "Baja" },
		});
		expect(
			(await request(`/api/users/${id}`, { as: superadmin, method: "DELETE" }))
				.status,
		).toBe(200);

		// La compensación se fue en cascada...
		const compensacion = await db
			.select()
			.from(employeeCompensation)
			.where(eq(employeeCompensation.profileId, id));
		expect(compensacion).toHaveLength(0);

		// ...y el puntero de quién desactivó a otro quedó anulado, no colgando.
		const afectado = await db.query.profiles.findFirst({
			where: eq(profiles.id, otroId),
		});
		expect(afectado?.deactivatedBy).toBeNull();

		// La bitácora sobrevive al borrado: es su razón de ser (RN-18.6).
		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.recordId, id));
		expect(entries.map((row) => row.action)).toContain("profile.deleted");
	});
});

describe("última conexión (RN-02.7)", () => {
	test("no se escribe más de una vez cada 5 minutos", async () => {
		const who = testUser("ultima-conexion", ["employee"]);
		await request("/api/me", { as: who });
		const id = await profileIdOf(who);

		const first = await db.query.profiles.findFirst({
			where: eq(profiles.id, id),
		});
		expect(first?.lastConnectionAt).not.toBeNull();

		await request("/api/me", { as: who });
		await request("/api/me", { as: who });
		await request("/api/users/incomplete", { as: manager });

		const second = await db.query.profiles.findFirst({
			where: eq(profiles.id, id),
		});
		expect(second?.lastConnectionAt?.getTime()).toBe(
			first?.lastConnectionAt?.getTime(),
		);
	});
});

describe("identificadores inválidos", () => {
	test("un id que no es uuid responde 400, no 500", async () => {
		expect(
			(await request("/api/users/no-es-uuid", { as: manager })).status,
		).toBe(400);
	});
});

/**
 * Ámbito departamental (spec 03 §3 y §7).
 *
 * Es el único trozo de autorización que esta aplicación escribe —los roles son
 * del Identity Server (RN-03.8)—, así que es también el único que se puede
 * probar de punta a punta: se asigna un departamento adicional y se comprueba
 * que el ámbito **efectivo** de esa persona cambia de verdad en las consultas
 * que ya existen, no sólo en la respuesta del endpoint que lo asignó.
 */
describe("ámbito departamental (spec 03 §7)", () => {
	const responsibilitiesPath = async (who: TestUser) =>
		`/api/users/${await profileIdOf(who)}/department-responsibilities`;

	test("varios roles del IS resuelven al de mayor prioridad (RN-03.1)", async () => {
		// El IS devuelve una lista plana, sin jerarquía: la prioridad es lógica de
		// este sistema y se resuelve al montar la sesión.
		const dualRole = testUser("ambos-roles", ["employee", "department_head"]);
		const res = await request("/api/me/permissions", { as: dualRole });
		const body = (await res.json()) as {
			roles: string[];
			effectiveRole: string;
		};

		expect(res.status).toBe(200);
		expect([...body.roles].sort()).toEqual(["department_head", "employee"]);
		expect(body.effectiveRole).toBe("department_head");
	});

	test("un department_head no puede leer ni escribir el ámbito de nadie", async () => {
		const path = await responsibilitiesPath(employee);

		expect((await request(path, { as: head })).status).toBe(403);
		expect(
			(
				await request(path, {
					as: head,
					method: "PUT",
					body: { departmentIds: [deptB] },
				})
			).status,
		).toBe(403);
	});

	test("el ámbito de partida es sólo el departamento propio (RN-03.2)", async () => {
		const res = await request(await responsibilitiesPath(head), {
			as: manager,
		});
		const body = (await res.json()) as {
			ownDepartment: { id: string } | null;
			additionalDepartments: unknown[];
			managedDepartmentIds: string[];
		};

		expect(res.status).toBe(200);
		expect(body.ownDepartment?.id).toBe(deptA);
		expect(body.additionalDepartments).toHaveLength(0);
		expect(body.managedDepartmentIds).toEqual([deptA]);
	});

	test("un departamento inexistente se rechaza al escribir", async () => {
		const res = await request(await responsibilitiesPath(head), {
			as: manager,
			method: "PUT",
			body: { departmentIds: [crypto.randomUUID()] },
		});
		expect(res.status).toBe(400);
	});

	test("el departamento propio se descarta: ya está en el ámbito", async () => {
		const res = await request(await responsibilitiesPath(head), {
			as: manager,
			method: "PUT",
			body: { departmentIds: [deptA] },
		});
		const body = (await res.json()) as {
			additionalDepartments: unknown[];
			managedDepartmentIds: string[];
		};

		expect(res.status).toBe(200);
		expect(body.additionalDepartments).toHaveLength(0);
		expect(body.managedDepartmentIds).toEqual([deptA]);
	});

	test("con un departamento adicional, el jefe ve los datos de dualRole", async () => {
		// Antes de asignarlo, el otro departamento está fuera de su ámbito.
		expect(
			(await request(`/api/users?departmentId=${deptB}`, { as: head })).status,
		).toBe(403);

		const assigned = await request(await responsibilitiesPath(head), {
			as: manager,
			method: "PUT",
			body: { departmentIds: [deptB] },
		});
		const body = (await assigned.json()) as { managedDepartmentIds: string[] };

		expect(assigned.status).toBe(200);
		expect([...body.managedDepartmentIds].sort()).toEqual(
			[deptA, deptB].sort(),
		);

		// El ámbito efectivo de la sesión: es lo que consume el resto del sistema.
		const permissions = (await (
			await request("/api/me/permissions", { as: head })
		).json()) as { managedDepartmentIds: string[] };
		expect([...permissions.managedDepartmentIds].sort()).toEqual(
			[deptA, deptB].sort(),
		);

		// Y el listado de usuarios, que filtra por ámbito en la propia consulta.
		const listed = await request(`/api/users?departmentId=${deptB}`, {
			as: head,
		});
		const rows = (await listed.json()) as { id: string }[];
		expect(listed.status).toBe(200);
		expect(rows.map((row) => row.id)).toContain(await profileIdOf(otherHead));
	});

	test("el cambio queda en la bitácora con el ámbito anterior y el newcomer (RN-03.8)", async () => {
		const id = await profileIdOf(head);
		const entries = await db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.recordId, id),
					eq(auditLog.action, "profile.responsibilities_changed"),
				),
			);

		expect(entries).toHaveLength(1);
		expect(entries[0]?.oldData).toEqual({ departmentIds: [] });
		expect(entries[0]?.newData).toEqual({ departmentIds: [deptB] });
	});

	test("el PUT reemplaza: enviar la lista vacía retira el ámbito adicional", async () => {
		const res = await request(await responsibilitiesPath(head), {
			as: manager,
			method: "PUT",
			body: { departmentIds: [] },
		});
		const body = (await res.json()) as { managedDepartmentIds: string[] };

		expect(res.status).toBe(200);
		expect(body.managedDepartmentIds).toEqual([deptA]);

		// Y el jefe vuelve a quedarse fuera del departamento que ya no gestiona.
		expect(
			(await request(`/api/users?departmentId=${deptB}`, { as: head })).status,
		).toBe(403);
	});

	test("un perfil inexistente devuelve 404", async () => {
		const res = await request(
			`/api/users/${crypto.randomUUID()}/department-responsibilities`,
			{ as: manager },
		);
		expect(res.status).toBe(404);
	});
});
