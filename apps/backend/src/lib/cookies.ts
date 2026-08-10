import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "#/lib/config";

/**
 * Custodia de los tokens del Identity Server.
 *
 * Los dos van en cookies httpOnly: el navegador nunca los ve desde JavaScript
 * (RN-00.36). El session token es de larga duración y se trata como una
 * contraseña; el JWT dura ~15 min y se renueva solo (RN-00.37).
 *
 * `sameSite: "None"` es obligatorio mientras frontend (:3004) y backend (:3001)
 * vivan en orígenes distintos — decisión abierta §C.9.1 de la spec 00. Si algún
 * día se sirven bajo el mismo origen, esto debe volver a "Lax".
 */

export const SESSION_COOKIE = "ca_session";
export const JWT_COOKIE = "ca_jwt";

const baseOptions = {
	httpOnly: true,
	secure: true,
	sameSite: "None",
	path: "/",
} as const;

export function setSessionCookie(c: Context, sessionToken: string) {
	setCookie(c, SESSION_COOKIE, sessionToken, {
		...baseOptions,
		maxAge: 60 * 60 * 24 * 30,
	});
}

export function setJwtCookie(c: Context, jwt: string) {
	// Sin maxAge: cookie de sesión del navegador. Su vida útil real la marca la
	// expiración del propio JWT, que se verifica en cada petición.
	setCookie(c, JWT_COOKIE, jwt, baseOptions);
}

export function readSessionToken(c: Context): string | undefined {
	return getCookie(c, SESSION_COOKIE);
}

export function readJwt(c: Context): string | undefined {
	return getCookie(c, JWT_COOKIE);
}

export function clearAuthCookies(c: Context) {
	deleteCookie(c, SESSION_COOKIE, { ...baseOptions });
	deleteCookie(c, JWT_COOKIE, { ...baseOptions });
}

/** Sólo para diagnóstico: nunca registrar el token entero. */
export const maskToken = (token: string) =>
	config.isProduction ? "***" : `${token.slice(0, 6)}…`;
