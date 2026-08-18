import type { Context } from "hono";

/**
 * IP del cliente, para la bitácora (spec 18 §2, `source_ip`).
 *
 * Detrás del proxy de producción la IP real viene en `x-forwarded-for`, que
 * puede traer una cadena de saltos: el cliente es el primero. Devuelve `null`
 * cuando no hay forma de saberlo — es un campo de contexto, no una garantía.
 */
export function clientIp(c: Context): string | null {
	const forwarded = c.req.header("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}
	return c.req.header("x-real-ip") ?? null;
}

export function userAgent(c: Context): string | null {
	return c.req.header("user-agent") ?? null;
}
