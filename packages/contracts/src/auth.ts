import { loginInputSchema, permissionsSchema } from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de autenticación y sesión (specs 03 §7 y 04).
 *
 * Ojo con los prefijos: `/api/auth/*` aquí son rutas de NUESTRO backend, no del
 * Identity Server. El navegador nunca habla directo con el IS (RN-00.35); es el
 * backend quien llama a `sign-in` / `sign-out` / `token` y custodia los tokens
 * en cookies httpOnly.
 */
export const authSpec = {
	login: {
		method: "POST",
		path: "/api/auth/login",
		body: loginInputSchema,
		response: permissionsSchema,
	},
	logout: {
		method: "POST",
		path: "/api/auth/logout",
		response: z.object({ ok: z.literal(true) }),
	},
	/**
	 * Rol efectivo y ámbito del usuario autenticado. El frontend la usa además
	 * como sonda de sesión: 200 = hay sesión, 401 = no la hay.
	 */
	permissions: {
		method: "GET",
		path: "/api/me/permissions",
		response: permissionsSchema,
	},
} as const;
