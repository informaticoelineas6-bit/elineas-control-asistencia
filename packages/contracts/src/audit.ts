import { auditPageSchema, listAuditQuerySchema } from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de la bitácora (spec 18 §6).
 *
 * **Sólo lectura, y sólo `superadmin`** (RN-18.5, RN-18.6). Que no exista un
 * `POST` ni un `DELETE` no es una omisión de esta tabla: es la regla. La
 * bitácora la escribe `services/audit.ts` dentro de la transacción de la acción
 * que describe (RN-18.3/18.4), así que un endpoint de escritura sólo podría
 * servir para falsificar rastro.
 *
 * `resource` no es un filtro más de `list` aunque pudiera serlo: es la pregunta
 * *"¿qué le ha pasado a este registro?"*, que la §7 pide poder hacer desde cada
 * recurso, y tiene su propio path para que la interfaz pueda enlazarla sin
 * montar una cadena de parámetros.
 */
export const auditSpec = {
	list: {
		method: "GET",
		path: "/api/audit",
		query: listAuditQuerySchema,
		response: auditPageSchema,
	},
	/** El historial de un registro concreto, del más reciente al más antiguo. */
	resource: {
		method: "GET",
		path: "/api/audit/resource/:tableName/:id",
		query: z.object({
			limit: z.coerce.number().int().min(1).max(100).default(50),
		}),
		response: auditPageSchema,
	},
} as const;
