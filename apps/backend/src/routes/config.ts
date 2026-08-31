import { configSpec } from "@elineas/contracts";
import { updateConfigInputSchema } from "@elineas/validations";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth, requireRole } from "#/middleware/auth";
import {
	ConfigValidationError,
	getConfig,
	getPublicConfig,
	setConfig,
} from "#/services/config.ts";

/**
 * Configuración global (spec 06 §5). Montado en `/api/config`.
 *
 * RN-06.1: sólo `global_manager` y `superadmin` leen y escriben la configuración
 * completa; la tabla no se expone entera a nadie más. Lo que sí ve cualquier rol
 * es el subconjunto seguro de `/config/public` — zona horaria, tolerancia y modo
 * de salida—, porque sin él la interfaz no puede aplicar las mismas reglas que el
 * servidor.
 */
export const config = new Hono();

config.use("*", requireAuth);

/**
 * Antes del `requireRole`, y antes de `/`: cualquier autenticado la lee. Las
 * claves que devuelve son una lista blanca explícita en `@elineas/validations`,
 * no un "todo menos", para que añadir una clave al catálogo no la exponga por
 * descuido.
 */
config.get("/public", async (c) => {
	return c.json(configSpec.getPublic.response.parse(await getPublicConfig()));
});

config.use("*", requireRole("global_manager"));

config.get("/", async (c) => {
	return c.json(configSpec.get.response.parse(await getConfig()));
});

config.patch("/", validate("json", updateConfigInputSchema), async (c) => {
	const auth = getAuth(c);

	try {
		const updated = await setConfig(c.req.valid("json"), {
			profileId: auth.profile.id,
			sourceIp: clientIp(c),
		});
		return c.json(configSpec.update.response.parse(updated));
	} catch (error) {
		if (error instanceof ConfigValidationError) {
			throw new HTTPException(400, { message: error.message });
		}
		throw error;
	}
});
