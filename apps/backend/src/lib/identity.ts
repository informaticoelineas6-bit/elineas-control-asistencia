import { type AppRole, appRoleSchema } from "@elineas/validations";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "#/lib/config";

/**
 * Cliente del Identity Server de Elineas.
 *
 * Referencia normativa: packages/docs/identity-server-usage.md. Este módulo es
 * el ÚNICO que hace peticiones al IS; el resto del backend habla con estas
 * funciones. Ante cualquier diferencia, manda el documento de integración.
 */

const authUrl = (path: string) => new URL(path, config.authApiUrl);

/**
 * JWKS público del IS. `jose` lo cachea en memoria, así que la verificación del
 * JWT es local: no hay un viaje al IS por petición (RN-00.36).
 */
const jwks = createRemoteJWKSet(authUrl("/api/auth/jwks"));

export type IdentityUser = {
	/** `sub` del JWT: el id de usuario en el IS (RN-00.44). */
	identityUserId: string;
	email: string;
	name: string | null;
};

export type SignInResult = {
	user: IdentityUser;
	/** Larga duración (días). Se trata como una contraseña (RN-00.36). */
	sessionToken: string;
	/** ~15 minutos. Prueba identidad, no permisos (RN-00.39). */
	jwt: string;
};

export class IdentityError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "IdentityError";
	}
}

/**
 * `POST /api/auth/sign-in`. El session token viaja en la cabecera
 * `set-auth-token`, no en el cuerpo.
 *
 * Un usuario sin ningún rol en `control-asistencia` es rechazado aquí por el
 * propio IS con 403 (RN-00.33): no llega ni a tener sesión.
 */
export async function signIn(
	email: string,
	password: string,
): Promise<SignInResult> {
	let res: Response;
	try {
		res = await fetch(authUrl("/api/auth/sign-in"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password, systemSlug: config.systemSlug }),
		});
	} catch (cause) {
		throw new IdentityError(
			503,
			`No se pudo contactar con el Identity Server: ${String(cause)}`,
		);
	}

	if (!res.ok) {
		// 403 = autenticado pero sin rol en este sistema; 401 = credenciales
		// incorrectas. Se distinguen porque el mensaje al usuario es distinto.
		throw new IdentityError(
			res.status === 403 ? 403 : 401,
			res.status === 403
				? "Tu cuenta no tiene un rol asignado en Control de Asistencia."
				: "Correo o contraseña incorrectos.",
		);
	}

	const sessionToken = res.headers.get("set-auth-token");
	if (!sessionToken) {
		throw new IdentityError(
			502,
			"El Identity Server no devolvió la cabecera set-auth-token.",
		);
	}

	const body = (await res.json()) as {
		user?: { id?: string; email?: string; name?: string | null };
		token?: string;
	};

	if (!body.token || !body.user?.email) {
		throw new IdentityError(502, "Respuesta inesperada del Identity Server.");
	}

	// El `sub` del JWT es la clave de vínculo (RN-00.45): se toma de ahí y no
	// del cuerpo, para que sea exactamente el mismo valor que veremos en cada
	// petición posterior.
	const claims = await verifyJwt(body.token);
	if (!claims) {
		throw new IdentityError(
			502,
			"El Identity Server devolvió un JWT que no supera la verificación.",
		);
	}

	return {
		user: {
			identityUserId: claims.identityUserId,
			email: body.user.email,
			name: body.user.name ?? null,
		},
		sessionToken,
		jwt: body.token,
	};
}

/** `POST /api/auth/sign-out`. Revoca la sesión en el IS (RN-00.38). */
export async function signOut(sessionToken: string): Promise<void> {
	try {
		await fetch(authUrl("/api/auth/sign-out"), {
			method: "POST",
			headers: { Authorization: `Bearer ${sessionToken}` },
		});
	} catch {
		// Si el IS no responde no podemos hacer nada más: nuestras cookies se
		// limpian igual. Lo que no se puede es dejar de intentarlo.
	}
}

/**
 * `GET /api/auth/token`. Emite un JWT nuevo con el session token, sin volver a
 * pedir credenciales (RN-00.37).
 */
export async function refreshJwt(sessionToken: string): Promise<string | null> {
	try {
		const res = await fetch(authUrl("/api/auth/token"), {
			headers: { Authorization: `Bearer ${sessionToken}` },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { token?: string };
		return body.token ?? null;
	} catch {
		return null;
	}
}

export type JwtClaims = {
	identityUserId: string;
	email: string | null;
	name: string | null;
};

/**
 * Verificación local contra el JWKS: firma y expiración, sin llamar al IS.
 *
 * Devuelve sólo identidad **a propósito**. Un eventual `payload.role` no se lee
 * jamás: el JWT prueba identidad, no permisos (RN-00.39).
 */
export async function verifyJwt(token: string): Promise<JwtClaims | null> {
	try {
		const { payload } = await jwtVerify(token, jwks);
		if (!payload.sub) return null;
		return {
			identityUserId: payload.sub,
			email: typeof payload.email === "string" ? payload.email : null,
			name: typeof payload.name === "string" ? payload.name : null,
		};
	} catch {
		return null;
	}
}

/**
 * `GET /api/user-roles/me?systemSlug=…`, con el **session token** como Bearer
 * (no con el JWT) (RN-00.40).
 *
 * Devuelve `null` si el IS no responde, para distinguirlo de "responde y no
 * tiene roles" — que es un array vacío y significa que no debe entrar.
 */
export async function fetchRoles(
	sessionToken: string,
): Promise<AppRole[] | null> {
	const url = authUrl("/api/user-roles/me");
	url.searchParams.set("systemSlug", config.systemSlug);

	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${sessionToken}` },
		});
		if (!res.ok) return null;

		const body = (await res.json()) as { roles?: { name?: string }[] };
		const roles: AppRole[] = [];
		for (const role of body.roles ?? []) {
			const parsed = appRoleSchema.safeParse(role.name);
			// Un rol del IS que no conocemos se ignora en vez de reventar: el IS
			// puede tener roles de otros sistemas o nombres nuevos.
			if (parsed.success) roles.push(parsed.data);
		}
		return roles;
	} catch {
		return null;
	}
}
