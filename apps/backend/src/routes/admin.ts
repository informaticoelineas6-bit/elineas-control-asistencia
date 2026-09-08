import { adminSpec } from "@elineas/contracts";
import { setMaintenanceInputSchema } from "@elineas/validations";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth, requireRole } from "#/middleware/auth";
import {
	commitAttendanceImport,
	getAdminStats,
	getMaintenance,
	setMaintenance,
	validateAttendanceImport,
} from "#/services/admin.ts";

/**
 * Panel de superadmin (spec 19 §4). Montado en `/api/admin`.
 *
 * **Un solo `requireRole("superadmin")` para todo el router** (RN-19.7), por lo
 * mismo que en nómina: la barrera no puede depender de que alguien se acuerde de
 * repetir la línea al añadir la siguiente ruta. Y todo lo que escribe deja
 * bitácora (RN-19.8), que es lo que hace que "potente y peligroso" sea al menos
 * *reconstruible*.
 *
 * ⚠️ **No hay `POST /admin/sql`** — decisión 1 de la §6, cerrada por la
 * alternativa (a) que la propia spec recomienda. El razonamiento está en el
 * contrato; lo que hay aquí es una prueba que comprueba que el endpoint no
 * existe, para que volver a añadirlo sea un acto deliberado.
 */
export const admin = new Hono();

admin.use("*", requireAuth);
admin.use("*", requireRole("superadmin"));

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

admin.get("/stats", async (c) => {
	const stats = await getAdminStats();
	return c.json(adminSpec.stats.response.parse(stats));
});

admin.get("/maintenance", async (c) => {
	const state = await getMaintenance();
	return c.json(adminSpec.maintenance.response.parse(state));
});

admin.put(
	"/maintenance",
	validate("json", setMaintenanceInputSchema),
	async (c) => {
		const state = await setMaintenance(c.req.valid("json"), actorOf(c));
		return c.json(adminSpec.setMaintenance.response.parse(state));
	},
);

/** Lo que llega en el `multipart`: el archivo, y nada más. */
const MAX_BYTES = 8 * 1024 * 1024;

async function uploadedFile(
	c: Context,
): Promise<{ bytes: Uint8Array; filename: string }> {
	const body = await c.req.parseBody();
	const file = body.file;

	if (!(file instanceof File)) {
		throw new HTTPException(400, {
			message: "Adjunta el archivo en el campo «file».",
		});
	}
	if (file.size > MAX_BYTES) {
		throw new HTTPException(413, {
			message: "El archivo pasa de 8 MB. Divídelo en tandas.",
		});
	}

	return {
		bytes: new Uint8Array(await file.arrayBuffer()),
		filename: file.name || "importacion.xlsx",
	};
}

/** RN-19.2 — Devuelve el informe y no escribe ni una fila. */
admin.post("/import/attendance/validate", async (c) => {
	const { bytes } = await uploadedFile(c);
	const report = await validateAttendanceImport(bytes);
	return c.json(adminSpec.validateImport.response.parse(report));
});

admin.post("/import/attendance/commit", async (c) => {
	const { bytes, filename } = await uploadedFile(c);
	const result = await commitAttendanceImport(bytes, filename, actorOf(c));
	return c.json(adminSpec.commitImport.response.parse(result));
});
