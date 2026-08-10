import { authSpec } from "@elineas/contracts";
import { getHighestRole } from "@elineas/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
	clearAuthCookies,
	readSessionToken,
	setJwtCookie,
	setSessionCookie,
} from "#/lib/cookies";
import { IdentityError, signIn, signOut } from "#/lib/identity";
import { getRoles, invalidateRoles } from "#/lib/roles-cache";
import {
	findOrCreateProfile,
	getManagedDepartmentIds,
	toSessionProfile,
	touchLastConnection,
} from "#/services/profiles";

export const auth = new Hono();

/**
 * Login (spec 04 §4.1). El navegador manda las credenciales aquí, nunca al IS
 * (RN-00.35); este handler es quien recibe y custodia los tokens.
 */
auth.post("/login", zValidator("json", authSpec.login.body), async (c) => {
	const { email, password } = c.req.valid("json");

	let result: Awaited<ReturnType<typeof signIn>>;
	try {
		result = await signIn(email, password);
	} catch (error) {
		if (error instanceof IdentityError) {
			throw new HTTPException(error.status as 401 | 403 | 502 | 503, {
				message: error.message,
			});
		}
		throw error;
	}

	const profile = await findOrCreateProfile(result.user);

	// RN-00.30 + RN-00.38: si el perfil está desactivado no abrimos sesión aquí,
	// y además revocamos en el IS los tokens que acaba de emitir. Si no, cada
	// intento de alguien desactivado dejaría una sesión huérfana viva allí.
	if (!profile.isActive) {
		await signOut(result.sessionToken);
		throw new HTTPException(403, {
			message: "Tu cuenta está desactivada en Control de Asistencia.",
		});
	}

	const roles = await getRoles(result.sessionToken);
	const effectiveRole = roles ? getHighestRole(roles) : null;

	// El IS ya rechaza con 403 a quien no tiene rol (RN-00.33). Esto cubre el
	// caso raro de que autentique y aun así no devuelva ninguno conocido.
	if (!roles || !effectiveRole) {
		await signOut(result.sessionToken);
		throw new HTTPException(403, {
			message: "Tu cuenta no tiene un rol asignado en Control de Asistencia.",
		});
	}

	setSessionCookie(c, result.sessionToken);
	setJwtCookie(c, result.jwt);
	await touchLastConnection(profile.id);

	return c.json(
		authSpec.login.response.parse({
			user: result.user,
			profile: toSessionProfile(profile),
			roles,
			effectiveRole,
			managedDepartmentIds: await getManagedDepartmentIds(profile),
		}),
	);
});

/**
 * Cierre de sesión (RN-00.38): revoca en el IS **y** limpia nuestras cookies.
 * Sin lo primero, la sesión sigue viva allí.
 */
auth.post("/logout", async (c) => {
	const sessionToken = readSessionToken(c);
	if (sessionToken) {
		await signOut(sessionToken);
		invalidateRoles(sessionToken);
	}
	clearAuthCookies(c);
	return c.json({ ok: true } as const);
});
