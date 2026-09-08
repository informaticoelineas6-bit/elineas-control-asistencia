import {
	decodeKeysetCursor,
	encodeKeysetCursor,
	type ListNotificationsQuery,
	type Notification,
	type NotificationPage,
	type NotificationType,
	notificationTypeSchema,
} from "@elineas/validations";
import {
	and,
	desc,
	eq,
	isNotNull,
	isNull,
	lt,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import { notifications } from "#/db/schema";
import { cursorAt } from "#/lib/keyset.ts";
import { queueLiveUpdate } from "#/lib/live.ts";
import type { Database } from "#/services/audit.ts";
import { getConfig } from "#/services/config.ts";

/**
 * Notificaciones in-app (spec 14), en su mínimo viable.
 *
 * - **RN-14.1** — aislamiento estricto: toda consulta y toda mutación filtra por
 *   `userId`. No hay una sola función aquí que acepte leer las de otro.
 * - **RN-14.2** — sólo el servidor las crea, y **en la transacción del hecho que
 *   las origina**: de ahí que `notify` reciba la transacción.
 * - **RN-14.4** — `notify` encola además el aviso en vivo, que se publica cuando
 *   la transacción ya escribió (ver `lib/live.ts`). Es el único sitio donde se
 *   encola: un aviso sin notificación detrás manda al cliente a preguntar por
 *   nada, y una notificación sin aviso tarda hasta 30 s en aparecer.
 *
 * ⚠️ Hallazgo H-4 de la spec 14: en el legacy las reglas de generación vivían en
 * el contexto de notificaciones del **frontend**, así que sólo se ejecutaban si
 * el usuario abría la app. Aquí no hay generación en cliente, ninguna.
 */

type NotifyInput = {
	type: NotificationType;
	title: string;
	body: string;
	actionUrl?: string | null;
	/**
	 * Si viene, la notificación se **actualiza en vez de duplicarse** (spec 14
	 * §5) y vuelve a quedar como no leída. Para avisos recurrentes que no deben
	 * acumularse.
	 */
	dedupeKey?: string | null;
};

export async function notify(
	tx: Database,
	recipientIds: readonly string[],
	input: NotifyInput,
): Promise<void> {
	const unique = [...new Set(recipientIds)];
	if (unique.length === 0) return;

	const rows = unique.map((userId) => ({
		userId,
		type: input.type,
		title: input.title,
		body: input.body,
		actionUrl: input.actionUrl ?? null,
		dedupeKey: input.dedupeKey ?? null,
	}));

	if (!input.dedupeKey) {
		await tx.insert(notifications).values(rows);
	} else {
		await tx
			.insert(notifications)
			.values(rows)
			.onConflictDoUpdate({
				target: [notifications.userId, notifications.dedupeKey],
				// El índice único es parcial (sólo donde `dedupe_key` no es nulo), así
				// que el ON CONFLICT tiene que repetir esa condición para casar con él.
				targetWhere: sql`dedupe_key is not null`,
				set: {
					type: input.type,
					title: input.title,
					body: input.body,
					actionUrl: input.actionUrl ?? null,
					readAt: null,
					createdAt: new Date(),
				},
			});
	}

	// RN-14.4 — El aviso en vivo. Se **encola**, no se manda: sale cuando la
	// transacción haya escrito de verdad, o el cliente preguntaría antes del
	// `COMMIT` y no vería nada nuevo.
	queueLiveUpdate(unique);
}

type NotificationRow = typeof notifications.$inferSelect;

/**
 * Un tipo que no está en el catálogo se **descarta al leer** en vez de reventar
 * la respuesta entera: puede quedar en base tras revertir una versión. Se avisa
 * por consola para que no pase inadvertido.
 */
function toNotification(row: NotificationRow): Notification | null {
	const type = notificationTypeSchema.safeParse(row.type);
	if (!type.success) {
		console.warn(`Notificación con tipo desconocido: ${row.type} (${row.id})`);
		return null;
	}

	return {
		id: row.id,
		type: type.data,
		title: row.title,
		body: row.body,
		actionUrl: row.actionUrl,
		readAt: row.readAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * `GET /notifications` (§7, §8). Una página, no la lista entera.
 *
 * El `userId` va **en el `where`**, no en un filtro posterior: RN-14.1 no es una
 * comprobación que se pueda olvidar en una rama, es la forma de la consulta.
 *
 * Ordena por `created_at desc, id desc` y pagina por *keyset*, como la bitácora
 * y con el mismo cursor compartido: la campana se queda con la primera página y
 * la vista completa sigue pidiendo.
 */
export async function listNotifications(
	userId: string,
	options: ListNotificationsQuery,
): Promise<NotificationPage> {
	const conditions: SQL[] = [eq(notifications.userId, userId)];
	if (options.unreadOnly) conditions.push(isNull(notifications.readAt));

	const cursor = options.cursor ? decodeKeysetCursor(options.cursor) : null;
	if (cursor) {
		conditions.push(
			sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
		);
	}

	const rows = await db
		.select({
			row: notifications,
			// Con microsegundos: el `Date` de JavaScript los pierde y la página
			// siguiente se saltaría las filas del mismo instante — dos avisos de la
			// misma transacción, por ejemplo. Ver `lib/keyset.ts`.
			cursorAt: cursorAt(notifications.createdAt),
		})
		.from(notifications)
		.where(and(...conditions))
		.orderBy(desc(notifications.createdAt), desc(notifications.id))
		// Una fila más de las que se devuelven: es cómo se sabe si queda algo
		// detrás sin contar una tabla que sólo crece.
		.limit(options.limit + 1);

	const page = rows.slice(0, options.limit);
	const last = page.at(-1);

	return {
		notifications: page
			.map((entry) => toNotification(entry.row))
			.filter((row): row is Notification => !!row),
		nextCursor:
			rows.length > options.limit && last
				? encodeKeysetCursor({ createdAt: last.cursorAt, id: last.row.id })
				: null,
	};
}

export async function countUnread(userId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
	return row?.count ?? 0;
}

/**
 * Marca una como leída (RN-14.3). El `userId` va en el `where`, no en una
 * comprobación posterior: así una notificación de otro no se distingue de una
 * que no existe, y no hay forma de sondear ids ajenos.
 */
export async function markRead(
	userId: string,
	notificationId: string,
): Promise<Notification | null> {
	const [row] = await db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(
			and(
				eq(notifications.id, notificationId),
				eq(notifications.userId, userId),
			),
		)
		.returning();

	return row ? toNotification(row) : null;
}

export async function markAllRead(userId: string): Promise<number> {
	const rows = await db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
		.returning({ id: notifications.id });

	return rows.length;
}

/**
 * RN-14.6 — Purga de notificaciones **leídas** (decisión 3, cerrada).
 *
 * `notification_retention_days` en configuración, con default `0` = no se purga
 * nada. Es el criterio del catálogo de la spec 06: la cifra es del negocio y el
 * default deja la regla inerte.
 *
 * **Sólo alcanza a las leídas**, y no por cautela: una notificación sin leer es
 * trabajo pendiente de alguien, y borrarla porque lleva mucho tiempo ahí es lo
 * contrario de para qué existe. Una leída ya cumplió su función.
 *
 * No deja entrada en la bitácora: es mantenimiento sobre datos derivados, no una
 * decisión de nadie, y una fila diaria de "purgué 12" sólo taparía las de §3 de
 * la spec 18. Devuelve cuántas borró para que el proceso pueda registrarlo en el
 * log del contenedor.
 */
export async function purgeReadNotifications(): Promise<number> {
	const config = await getConfig();
	const days = config.notification_retention_days;
	if (days <= 0) return 0;

	const cutoff = new Date(Date.now() - days * 86_400_000);
	const rows = await db
		.delete(notifications)
		.where(
			and(isNotNull(notifications.readAt), lt(notifications.readAt, cutoff)),
		)
		.returning({ id: notifications.id });

	return rows.length;
}
