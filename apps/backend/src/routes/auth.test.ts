import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppRole } from "@elineas/validations";
import { eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de autenticación y sesión (spec 04 §8).
 *
 * El Identity Server se sustituye por un doble **con estado**: cada prueba
 * decide qué responde `sign-in`, si el JWT verifica y si el `sign-out` llegó. Eso
 * es lo que permite comprobar las reglas que no se ven desde fuera —que un perfil
 * desactivado no deja tokens vivos allí (RN-04.4), que el JWT caducado se renueva
 * solo (RN-00.37)— sin depender de un IS de verdad.
 *
 * Todo lo demás corre real: el middleware, los roles, el perfil, las cookies.
 */

/** Estado del IS de mentira. Cada prueba lo ajusta a lo que necesita. */
const identityServer = {
	/** `null` = las credenciales son válidas; si no, el error que devuelve. */
	signInError: null as { status: number; message: string } | null,
	roles: ["employee"] as AppRole[],
	/** JWTs que `verifyJwt` rechaza, para simular caducidad. */
	expiredJwts: new Set<string>(),
	/** `null` = el IS no sabe emitir uno nuevo. */
	renewedJwt: null as string | null,
	/** Session tokens sobre los que se llamó a `sign-out`. */
	signedOut: [] as string[],
	reset() {
		this.signInError = null;
		this.roles = ["employee"];
		this.expiredJwts = new Set();
		this.renewedJwt = null;
		this.signedOut = [];
	},
};

mock.module("#/lib/identity", () => ({
	IdentityError: class IdentityError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
		}
	},
	signIn: async (email: string) => {
		if (identityServer.signInError) {
			const { IdentityError } = await import("#/lib/identity");
			throw new IdentityError(
				identityServer.signInError.status,
				identityServer.signInError.message,
			);
		}
		const identityUserId = email.split("@")[0] ?? email;
		return {
			user: { identityUserId, email, name: identityUserId },
			sessionToken: `sess|${identityUserId}`,
			jwt: `jwt|${identityUserId}`,
		};
	},
	signOut: async (sessionToken: string) => {
		identityServer.signedOut.push(sessionToken);
	},
	refreshJwt: async () => identityServer.renewedJwt,
	verifyJwt: async (token: string) => {
		if (identityServer.expiredJwts.has(token)) return null;
		const [, identityUserId] = token.split("|");
		if (!identityUserId) return null;
		return {
			identityUserId,
			email: `${identityUserId}@test.local`,
			name: identityUserId,
		};
	},
	fetchRoles: async (): Promise<AppRole[]> => identityServer.roles,
}));

const { createApp } = await import("#/app.ts");
const { db } = await import("#/db");
const { auditLog, notifications, profiles } = await import("#/db/schema");
const { SESSION_COOKIE, JWT_COOKIE } = await import("#/lib/cookies.ts");
const { invalidateRoles } = await import("#/lib/roles-cache.ts");

const app = createApp();
const TAG = `zz-auth-${crypto.randomUUID().slice(0, 8)}`;

const email = (name: string) => `${TAG}-${name}@test.local`;

function login(name: string, password = "correcta") {
	return app.request("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: email(name), password }),
	});
}

/** Las cookies tal como las manda el backend, para inspeccionar sus atributos. */
function setCookies(res: Response): string[] {
	return res.headers.getSetCookie();
}

/** Cabecera `Cookie` equivalente a lo que guardaría el navegador. */
function cookieHeader(res: Response): string {
	return setCookies(res)
		.map((raw) => raw.split(";")[0])
		.join("; ");
}

function get(path: string, cookie?: string) {
	return app.request(path, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

async function profileOf(name: string) {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.email, email(name)),
	});
	if (!row) throw new Error(`Sin perfil: ${email(name)}`);
	return row;
}

beforeEach(() => {
	identityServer.reset();
	// La caché de roles vive por session token y los tokens se repiten entre
	// pruebas: sin esto, una prueba heredaría los roles de la anterior.
	for (const name of ["ana", "beto", "carla", "dario", "elsa"]) {
		invalidateRoles(`sess|${TAG}-${name}`);
	}
});

afterAll(async () => {
	const ids = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.email, `${TAG}%`))
	).map((row) => row.id);

	if (ids.length > 0) {
		await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
		await db.delete(auditLog).where(inArray(auditLog.recordId, ids));
		await db.delete(notifications).where(inArray(notifications.userId, ids));
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
});

describe("inicio de sesión (spec 04 §4.1)", () => {
	test("con credenciales válidas devuelve el contexto de autorización", async () => {
		const res = await login("ana");
		const body = (await res.json()) as {
			user: { email: string };
			profile: { isComplete: boolean };
			roles: string[];
			effectiveRole: string;
			managedDepartmentIds: string[];
		};

		expect(res.status).toBe(200);
		expect(body.user.email).toBe(email("ana"));
		expect(body.roles).toEqual(["employee"]);
		expect(body.effectiveRole).toBe("employee");
		// RN-04.2 / RN-02.3: entra, pero sin departamento no puede marcar.
		expect(body.profile.isComplete).toBe(false);
	});

	test("los tokens van en cookies httpOnly que el navegador no puede leer", async () => {
		const cookies = setCookies(await login("ana"));

		const session = cookies.find((raw) => raw.startsWith(`${SESSION_COOKIE}=`));
		const jwt = cookies.find((raw) => raw.startsWith(`${JWT_COOKIE}=`));

		for (const cookie of [session, jwt]) {
			expect(cookie).toBeDefined();
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("Secure");
			// Cross-origin entre frontend y backend: sin esto no viajan.
			expect(cookie).toContain("SameSite=None");
		}
	});

	test("credenciales incorrectas: 401 y ninguna cookie", async () => {
		identityServer.signInError = {
			status: 401,
			message: "Correo o contraseña incorrectos.",
		};

		const res = await login("ana", "mala");
		expect(res.status).toBe(401);
		expect(setCookies(res)).toHaveLength(0);
	});

	test("sin rol en el sistema: mensaje propio, no «credenciales inválidas» (RN-04.9)", async () => {
		identityServer.signInError = {
			status: 403,
			message: "Tu cuenta no tiene un rol asignado en Control de Asistencia.",
		};

		const res = await login("beto");
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(403);
		expect(body.error).toContain("rol asignado");
		expect(body.error).not.toContain("contraseña");
	});

	test("si el IS autentica pero no devuelve ningún rol, no se abre sesión", async () => {
		identityServer.roles = [];

		const res = await login("carla");
		expect(res.status).toBe(403);
		expect(setCookies(res)).toHaveLength(0);
		// Y el token que el IS acababa de emitir no se queda vivo allí.
		expect(identityServer.signedOut).toContain(`sess|${TAG}-carla`);
	});
});

describe("perfil desactivado (RN-04.4)", () => {
	test("no obtiene sesión y el mensaje dice que está desactivado", async () => {
		await login("dario");
		const profile = await profileOf("dario");
		await db
			.update(profiles)
			.set({ isActive: false, deactivationReason: "prueba" })
			.where(eq(profiles.id, profile.id));

		identityServer.signedOut = [];
		const res = await login("dario");
		const body = (await res.json()) as { error: string };

		expect(res.status).toBe(403);
		expect(body.error).toContain("desactivada");
		expect(setCookies(res)).toHaveLength(0);
	});

	test("ese rechazo no deja tokens vivos en el IS (RN-00.38)", async () => {
		identityServer.signedOut = [];
		await login("dario");
		expect(identityServer.signedOut).toContain(`sess|${TAG}-dario`);
	});

	test("desactivar a alguien con la app abierta lo expulsa (RN-04.10)", async () => {
		await db
			.update(profiles)
			.set({ isActive: true, deactivationReason: null })
			.where(eq(profiles.email, email("dario")));

		const session = cookieHeader(await login("dario"));
		expect((await get("/api/me/permissions", session)).status).toBe(200);

		await db
			.update(profiles)
			.set({ isActive: false })
			.where(eq(profiles.email, email("dario")));

		// Sin volver a iniciar sesión: la siguiente petición ya lo echa.
		const res = await get("/api/me/permissions", session);
		expect(res.status).toBe(403);
		// Y le limpia las cookies, para que no se quede en un limbo.
		expect(setCookies(res).join(";")).toContain(`${SESSION_COOKIE}=;`);

		await db
			.update(profiles)
			.set({ isActive: true })
			.where(eq(profiles.email, email("dario")));
	});
});

describe("sesión y renovación", () => {
	test("sin cookies, la sonda de sesión responde 401 y no error", async () => {
		const res = await get("/api/me/permissions");
		expect(res.status).toBe(401);
	});

	test("con el JWT caducado la petición se renueva sola (RN-00.37)", async () => {
		const session = cookieHeader(await login("elsa"));

		// El JWT que lleva el navegador ya no verifica; el IS emite uno nuevo.
		identityServer.expiredJwts.add(`jwt|${TAG}-elsa`);
		identityServer.renewedJwt = `renovado|${TAG}-elsa`;

		const res = await get("/api/me/permissions", session);

		// La persona no ve el login: la petición se resuelve igual...
		expect(res.status).toBe(200);
		// ...y la cookie sale reemplazada por el JWT nuevo.
		expect(setCookies(res).join(";")).toContain(`${JWT_COOKIE}=renovado`);
	});

	test("con el JWT caducado y el IS sin poder renovar, se cierra la sesión", async () => {
		const session = cookieHeader(await login("elsa"));

		identityServer.expiredJwts.add(`jwt|${TAG}-elsa`);
		identityServer.renewedJwt = null;

		const res = await get("/api/me/permissions", session);
		expect(res.status).toBe(401);
		expect(setCookies(res).join(";")).toContain(`${JWT_COOKIE}=;`);
	});

	test("el rol efectivo sale del IS, nunca de un campo del JWT", async () => {
		identityServer.roles = ["employee", "global_manager"];
		const session = cookieHeader(await login("elsa"));

		const body = (await (await get("/api/me/permissions", session)).json()) as {
			effectiveRole: string;
		};
		expect(body.effectiveRole).toBe("global_manager");
	});
});

describe("cierre de sesión (§4.3)", () => {
	test("revoca en el IS y borra las cookies", async () => {
		const session = cookieHeader(await login("ana"));
		identityServer.signedOut = [];

		const res = await app.request("/api/auth/logout", {
			method: "POST",
			headers: { Cookie: session },
		});

		expect(res.status).toBe(200);
		expect(identityServer.signedOut).toContain(`sess|${TAG}-ana`);

		const cleared = setCookies(res).join(";");
		expect(cleared).toContain(`${SESSION_COOKIE}=;`);
		expect(cleared).toContain(`${JWT_COOKIE}=;`);
	});

	test("cerrar sesión sin tenerla no es un error", async () => {
		const res = await app.request("/api/auth/logout", { method: "POST" });
		expect(res.status).toBe(200);
	});
});
