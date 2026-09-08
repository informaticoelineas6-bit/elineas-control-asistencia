import {
	type AuditLogEntry,
	type AuditPage,
	decodeAuditCursor,
	encodeAuditCursor,
	type ListAuditQuery,
} from "@elineas/validations";
import { and, desc, eq, like, type SQL, sql } from "drizzle-orm";
import { db } from "#/db";
import { auditLog, profiles } from "#/db/schema";
import { getConfig } from "#/services/config.ts";

/**
 * Lectura de la bitácora (spec 18 §6).
 *
 * **Está aparte de `services/audit.ts` a propósito**, y no es una preferencia de
 * organización: ese archivo es la escritura, lo importa cada servicio de dominio
 * y no debe importar nada más que la base. Leer necesita la configuración —para
 * la zona horaria del filtro por fechas—, y `services/config.ts` escribe en la
 * bitácora, así que ponerlas juntas crearía un ciclo entre las dos. Es el mismo
 * corte que la spec 11 hizo al sacar la lectura de vacaciones de su servicio de
 * dominio.
 *
 * Aquí no hay ni una escritura, y no puede haberla: RN-18.6 dice que la bitácora
 * es inmutable, así que este módulo sólo tiene `select`.
 */

type AuditJoin = {
	entry: typeof auditLog.$inferSelect;
	actorName: string | null;
	actorEmail: string | null;
};

function toEntry(row: AuditJoin): AuditLogEntry {
	return {
		id: row.entry.id,
		actorId: row.entry.actorId,
		// Nulo con `actorId` puesto significa que ese perfil ya no existe. La
		// bitácora sobrevive a quien la generó (RN-18.6), que es justo el punto.
		actorName: row.actorName,
		actorEmail: row.actorEmail,
		action: row.entry.action,
		tableName: row.entry.tableName,
		recordId: row.entry.recordId,
		oldData: row.entry.oldData ?? null,
		newData: row.entry.newData ?? null,
		sourceIp: row.entry.sourceIp,
		metadata: (row.entry.metadata as Record<string, unknown> | null) ?? null,
		createdAt: row.entry.createdAt.toISOString(),
	};
}

const query = () =>
	db
		.select({
			entry: auditLog,
			actorName: profiles.fullName,
			actorEmail: profiles.email,
		})
		.from(auditLog)
		.leftJoin(profiles, eq(profiles.id, auditLog.actorId));

/**
 * Empaqueta la página **pidiendo una fila más** de las que devuelve: es lo que
 * permite decir "hay más" sin un `count(*)` sobre una tabla que sólo crece.
 */
function toPage(rows: AuditJoin[], limit: number): AuditPage {
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		entries: page.map(toEntry),
		nextCursor:
			rows.length > limit && last
				? encodeAuditCursor({
						createdAt: last.entry.createdAt.toISOString(),
						id: last.entry.id,
					})
				: null,
	};
}

/**
 * `GET /audit` (§6). Filtros y paginación por *keyset*.
 *
 * **El rango de fechas se resuelve en PostgreSQL con la zona configurada**
 * (RN-06.6), no comparando cadenas ni construyendo instantes en JavaScript: un
 * `from` es la medianoche **local** de ese día, y un `to` es inclusivo hasta la
 * medianoche local del siguiente. Es exactamente el error que una prueba
 * encontró en `periodRange` de la spec 16 —construir en UTC y formatear en
 * local—, y aquí decidiría si una acción de las 21:00 en La Habana entra en el
 * día que la persona está mirando o en el siguiente.
 */
export async function listAudit(input: ListAuditQuery): Promise<AuditPage> {
	const config = await getConfig();
	const conditions: SQL[] = [];

	if (input.actorId) conditions.push(eq(auditLog.actorId, input.actorId));
	if (input.action) conditions.push(eq(auditLog.action, input.action));
	// Un dominio entero: `payroll_adjustment.` cubre creación y reversión.
	if (input.domain) {
		conditions.push(like(auditLog.action, `${input.domain}.%`));
	}
	if (input.tableName) conditions.push(eq(auditLog.tableName, input.tableName));
	if (input.recordId) conditions.push(eq(auditLog.recordId, input.recordId));
	if (input.correlationId) {
		// RN-18.8 — La cadena entera. Se compara sobre el JSON como texto: es una
		// igualdad exacta contra un uuid, no una búsqueda dentro del documento.
		conditions.push(
			sql`${auditLog.metadata}->>'correlationId' = ${input.correlationId}`,
		);
	}
	if (input.from) {
		conditions.push(
			sql`${auditLog.createdAt} >= (${input.from}::date at time zone ${config.global_timezone})`,
		);
	}
	if (input.to) {
		conditions.push(
			sql`${auditLog.createdAt} < ((${input.to}::date + 1) at time zone ${config.global_timezone})`,
		);
	}

	const cursor = input.cursor ? decodeAuditCursor(input.cursor) : null;
	if (cursor) {
		// Comparación de fila completa: el instante **y** el id, porque dos entradas
		// de la misma cascada comparten milisegundo más veces de las que parece —
		// van en la misma transacción— y sin el id una de las dos se perdería al
		// pasar de página.
		conditions.push(
			sql`(${auditLog.createdAt}, ${auditLog.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
		);
	}

	const rows = await query()
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
		.limit(input.limit + 1);

	return toPage(rows, input.limit);
}

/**
 * `GET /audit/resource/:tableName/:id` (§6) — el historial de un registro.
 *
 * Es la pregunta que la §7 quiere poder hacer desde cada recurso: *"¿qué le ha
 * pasado a esto?"*. Tiene su propio endpoint y no es un filtro más de `list`
 * porque así la interfaz enlaza a un sitio en vez de componer una consulta, y
 * porque el índice `audit_log_record_idx` está hecho exactamente para esta
 * pareja de columnas.
 */
export async function resourceHistory(
	tableName: string,
	recordId: string,
	limit: number,
): Promise<AuditPage> {
	const rows = await query()
		.where(
			and(eq(auditLog.tableName, tableName), eq(auditLog.recordId, recordId)),
		)
		.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
		.limit(limit + 1);

	return toPage(rows, limit);
}
