import { notificationsSpec, resolvePath, withQuery } from "@elineas/contracts";
import type { Notification, NotificationPage } from "@elineas/validations";
import {
	infiniteQueryOptions,
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Notificaciones del usuario (spec 14).
 *
 * **Dos mecanismos de entrega, y los dos hacen falta** (RN-14.4): el flujo SSE
 * de `live.tsx` avisa en el momento, y el sondeo cada 30 s es el respaldo que la
 * regla exige mantener *siempre* — la entrega en vivo se cae con la pantalla
 * apagada y en las redes de planta, y una campana que se queda quieta no se
 * distingue de una bandeja vacía. Cuando el flujo funciona, el sondeo no
 * encuentra nada nuevo y no cuesta nada; cuando no, es lo único que hay.
 */

export const notificationsQueryKey = ["notifications"] as const;
export const unreadCountQueryKey = [
	...notificationsQueryKey,
	"unread-count",
] as const;

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 30;

export const unreadCountQueryOptions = () =>
	queryOptions({
		queryKey: unreadCountQueryKey,
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

/** Las primeras, para el panel de la campana. */
export const notificationsQueryOptions = (limit = PAGE_SIZE) =>
	queryOptions({
		queryKey: [...notificationsQueryKey, "list", limit] as const,
		queryFn: (): Promise<NotificationPage> =>
			apiJson(
				withQuery(notificationsSpec.list.path, { limit }),
				notificationsSpec.list.response,
			),
		refetchInterval: POLL_INTERVAL_MS,
	});

/**
 * La vista completa (§8): pagina por cursor y **no sondea**.
 *
 * Quien está mirando la lista entera no necesita que se le mueva debajo del
 * dedo; el aviso en vivo y la campana ya le dicen que hay algo nuevo.
 */
export const notificationPagesQueryOptions = (unreadOnly: boolean) =>
	infiniteQueryOptions({
		queryKey: [...notificationsQueryKey, "pages", unreadOnly] as const,
		queryFn: ({ pageParam }): Promise<NotificationPage> =>
			apiJson(
				withQuery(notificationsSpec.list.path, {
					unreadOnly: unreadOnly || undefined,
					limit: PAGE_SIZE,
					cursor: pageParam ?? undefined,
				}),
				notificationsSpec.list.response,
			),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
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
