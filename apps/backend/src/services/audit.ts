import type { AuditAction } from "@elineas/validations";
import type { db } from "#/db";
import { auditLog } from "#/db/schema";

/**
 * Escritura de la bitácora (spec 18).
 *
 * Dos reglas dan forma a esta función:
 *
 * - **RN-18.3** — sólo el servidor escribe. No hay endpoint que inserte aquí.
 * - **RN-18.4** — la entrada va en la **misma transacción** que la acción
 *   auditada. De ahí que reciba `tx` como primer argumento y no use `db`
 *   directamente: si la acción se revierte, su rastro también, y si la bitácora
 *   falla, la acción falla.
 *
 * En el legacy la bitácora se escribía desde los puntos de uso y su cobertura
 * quedó a medias (spec 18 §5): lo que nadie recordó instrumentar, no se auditó.
 * Aquí la instrumentación vive **dentro de los servicios de dominio**, junto a
 * la escritura que describe, para que no se pueda hacer una sin la otra.
 */

/** Transacción abierta de Drizzle. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Una transacción o la conexión suelta. Los servicios de dominio piden esto para
 * poder componerse dentro de una transacción mayor sin duplicar código.
 */
export type Database = Tx | typeof db;

export type AuditEntry = {
	/** Quién actuó. `null` cuando actúa el sistema, no una persona. */
	actorId: string | null;
	action: AuditAction;
	/** Recurso afectado, por nombre de tabla. */
	tableName: string;
	recordId?: string | null;
	/** Estado anterior y nuevo. Nunca contraseñas ni tokens (RN-18.2). */
	oldData?: unknown;
	newData?: unknown;
	sourceIp?: string | null;
	/** Motivo, user-agent, id de correlación (RN-18.8). */
	metadata?: Record<string, unknown> | null;
};

export async function audit(tx: Database, entry: AuditEntry): Promise<void> {
	await tx.insert(auditLog).values({
		actorId: entry.actorId,
		action: entry.action,
		tableName: entry.tableName,
		recordId: entry.recordId ?? null,
		oldData: entry.oldData ?? null,
		newData: entry.newData ?? null,
		sourceIp: entry.sourceIp ?? null,
		metadata: entry.metadata ?? null,
	});
}
