import { auditSpec } from "@elineas/contracts";
import { listAuditQuerySchema } from "@elineas/validations";
import { Hono } from "hono";
import { z } from "zod";
import { validate } from "#/lib/validate.ts";
import { requireAuth, requireRole } from "#/middleware/auth";
import { listAudit, resourceHistory } from "#/services/audit-log.ts";

/**
 * Bitácora de auditoría (spec 18 §6). Montado en `/api/audit`.
 *
 * **Sólo `superadmin`, y sólo lectura** (RN-18.5, RN-18.6).
 *
 * Que no haya `POST`, `PATCH` ni `DELETE` es la regla, no un hueco: la bitácora
 * la escribe `services/audit.ts` dentro de la transacción de la acción que
 * describe (RN-18.3/18.4), y un endpoint de escritura sólo serviría para
 * falsificar rastro. Por eso este router **no importa nada que escriba**: el
 * servicio de lectura sólo tiene `select`.
 *
 * **Decisión 1 de la §9, cerrada: un `global_manager` no lee nada de aquí, ni
 * "la parte de su ámbito".** No es prudencia: es que no se puede calcular. Una
 * entrada de bitácora no tiene departamento —tiene actor, tabla y registro—, así
 * que "lo de mi ámbito" exigiría etiquetar cada entrada con un departamento al
 * escribirla, decidir cuál le toca a un cambio de configuración global y
 * rellenar hacia atrás las que ya existen. Y la mitad del valor de la bitácora
 * es justamente cruzar dominios. Lo que un gestor necesita de verdad ya lo tiene
 * en su propia pantalla: quién revisó una ausencia está en la revisión, y quién
 * creó un ajuste, en el ajuste.
 */
export const audit = new Hono();

audit.use("*", requireAuth);
audit.use("*", requireRole("superadmin"));

const resourceParam = z.object({
	tableName: z.string().min(1).max(80),
	id: z.string().min(1).max(80),
});

audit.get("/", validate("query", listAuditQuerySchema), async (c) => {
	const page = await listAudit(c.req.valid("query"));
	return c.json(auditSpec.list.response.parse(page));
});

audit.get(
	"/resource/:tableName/:id",
	validate("param", resourceParam),
	validate("query", auditSpec.resource.query),
	async (c) => {
		const { tableName, id } = c.req.valid("param");
		const page = await resourceHistory(
			tableName,
			id,
			c.req.valid("query").limit,
		);
		return c.json(auditSpec.resource.response.parse(page));
	},
);
