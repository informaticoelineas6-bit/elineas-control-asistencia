import { notificationsSpec, resolvePath, withQuery } from "@elineas/contracts";
import type { Notification } from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Notificaciones del usuario (spec 14), en su mínimo viable.
 *
 * **Entrega por sondeo.** RN-14.4 exige mantener siempre un respaldo por sondeo
 * porque la entrega en vivo falla con la pantalla apagada y en las redes de
 * planta; mientras no se decida el mecanismo en vivo (SSE o WebSocket, decisión
 * abierta de la spec 14), el sondeo es *el* mecanismo. El contador se consulta
 * cada 30 s, igual que hacía el legacy de respaldo.
 */

export const notificationsQueryKey = ["notifications"] as const;

const POLL_INTERVAL_MS = 30_000;

export const unreadCountQueryOptions = () =>
	queryOptions({
		queryKey: [...notificationsQueryKey, "unread-count"] as const,
		queryFn: async (): Promise<number> => {
			const { count } = await apiJson(
				notificationsSpec.unreadCount.path,
				notificationsSpec.unreadCount.response,
			);
			return count;
		},
		refetchInterval: POLL_INTERVAL_MS,
		// Sin reintentos: un fallo puntual del contador no merece ruido, y en 30 s
		// se vuelve a preguntar.
		retry: false,
	});

export const notificationsQueryOptions = (limit = 30) =>
	queryOptions({
		queryKey: [...notificationsQueryKey, "list", limit] as const,
		queryFn: (): Promise<Notification[]> =>
			apiJson(
				withQuery(notificationsSpec.list.path, { limit }),
				notificationsSpec.list.response,
			),
		refetchInterval: POLL_INTERVAL_MS,
	});

export function useMarkNotificationRead() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string): Promise<Notification> =>
			apiJson(
				resolvePath(notificationsSpec.markRead.path, { id }),
				notificationsSpec.markRead.response,
				{ method: notificationsSpec.markRead.method },
			),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: notificationsQueryKey }),
	});
}

export function useMarkAllNotificationsRead() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: () =>
			apiJson(
				notificationsSpec.markAllRead.path,
				notificationsSpec.markAllRead.response,
				{ method: notificationsSpec.markAllRead.method },
			),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: notificationsQueryKey }),
	});
}
