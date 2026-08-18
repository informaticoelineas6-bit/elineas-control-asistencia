import {
	type Notification,
	type NotificationType,
	notificationTypeSchema,
} from "@elineas/validations";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { notifications } from "#/db/schema";
import type { Database } from "#/services/audit.ts";

/**
 * Notificaciones in-app (spec 14), en su mínimo viable.
 *
 * - **RN-14.1** — aislamiento estricto: toda consulta y toda mutación filtra por
 *   `userId`. No hay una sola función aquí que acepte leer las de otro.
 * - **RN-14.2** — sólo el servidor las crea, y **en la transacción del hecho que
 *   las origina**: de ahí que `notify` reciba la transacción.
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
		return;
	}

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

export async function listNotifications(
	userId: string,
	options: { unreadOnly: boolean; limit: number },
): Promise<Notification[]> {
	const rows = await db
		.select()
		.from(notifications)
		.where(
			options.unreadOnly
				? and(eq(notifications.userId, userId), isNull(notifications.readAt))
				: eq(notifications.userId, userId),
		)
		.orderBy(desc(notifications.createdAt))
		.limit(options.limit);

	return rows.map(toNotification).filter((row): row is Notification => !!row);
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
