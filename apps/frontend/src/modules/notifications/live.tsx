import { notificationsSpec } from "@elineas/contracts";
import {
	type Notification,
	notificationEventSchema,
} from "@elineas/validations";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "#/lib/api-client.ts";
import {
	notificationsQueryKey,
	notificationsQueryOptions,
	unreadCountQueryKey,
} from "#/modules/notifications/api.ts";

/**
 * Entrega en vivo (RN-14.4) y aviso emergente (RN-14.5).
 *
 * Se monta una sola vez en el layout autenticado. Abre el flujo SSE, y cada
 * evento hace tres cosas: pintar el contador nuevo sin esperar a nadie,
 * invalidar las listas, y **si el número de no leídas subió**, sacar el aviso
 * emergente con la que acaba de llegar.
 *
 * Por qué "si subió" y no "cada evento": el mismo flujo despierta al marcar una
 * como leída desde otra pestaña, y un aviso emergente por algo que uno mismo
 * acaba de leer es exactamente el ruido que hace que la gente deje de mirar la
 * campana.
 *
 * **El contenido no viaja por el flujo**: el evento sólo trae el contador, y lo
 * que se enseña sale de `GET /notifications`, que filtra por la sesión
 * (RN-14.1). Así el aislamiento se comprueba en un sitio y no en dos.
 *
 * `EventSource` reconecta solo cuando la conexión se cae, que es la mitad de la
 * razón para haber elegido SSE. La otra mitad es que no hace falta nada más: el
 * tráfico va en un solo sentido.
 */
export function NotificationsLive() {
	const queryClient = useQueryClient();
	const [toasts, setToasts] = useState<Notification[]>([]);
	/** Nulo hasta el primer evento: el primero sincroniza, no avisa. */
	const lastUnread = useRef<number | null>(null);

	const dismiss = useCallback((id: string) => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
	}, []);

	useEffect(() => {
		// SSR y navegadores sin soporte: la aplicación sigue funcionando con el
		// sondeo, que es exactamente el respaldo que RN-14.4 exige.
		if (typeof EventSource === "undefined") return;

		const source = new EventSource(apiUrl(notificationsSpec.stream.path), {
			withCredentials: true,
		});

		source.onmessage = async (event) => {
			const parsed = notificationEventSchema.safeParse(
				JSON.parse(event.data as string),
			);
			if (!parsed.success) return;
			const { unread } = parsed.data;

			// El contador, al instante y sin pedir nada: es el dato que ya trae el
			// evento.
			queryClient.setQueryData(unreadCountQueryKey, unread);
			await queryClient.invalidateQueries({ queryKey: notificationsQueryKey });

			const previous = lastUnread.current;
			lastUnread.current = unread;
			if (previous === null || unread <= previous) return;

			// RN-14.5 — El aviso emergente, con la más reciente sin leer.
			const page = await queryClient.fetchQuery(notificationsQueryOptions());
			const latest = page.notifications.find((row) => row.readAt === null);
			if (!latest) return;

			setToasts((current) =>
				current.some((toast) => toast.id === latest.id)
					? current
					: [latest, ...current].slice(0, 3),
			);
		};

		return () => source.close();
	}, [queryClient]);

	if (toasts.length === 0) return null;

	return (
		<div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6">
			{toasts.map((toast) => (
				<Toast key={toast.id} notification={toast} onDismiss={dismiss} />
			))}
		</div>
	);
}

/** Cuánto se queda un aviso antes de irse solo. */
const TOAST_MS = 8_000;

function Toast({
	notification,
	onDismiss,
}: {
	notification: Notification;
	onDismiss: (id: string) => void;
}) {
	const navigate = useNavigate();

	useEffect(() => {
		const timer = setTimeout(() => onDismiss(notification.id), TOAST_MS);
		return () => clearTimeout(timer);
	}, [notification.id, onDismiss]);

	return (
		<div className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-background p-4 shadow-lg">
			<Bell className="mt-0.5 size-4 shrink-0 text-primary" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{notification.title}</p>
				<p className="mt-0.5 text-sm text-muted-foreground">
					{notification.body}
				</p>
				{notification.actionUrl && (
					<button
						type="button"
						className="mt-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
						onClick={() => {
							onDismiss(notification.id);
							// Sin marcarla leída: abrir el recurso es una cosa y dar el aviso
							// por leído es otra. Lo segundo pasa en la campana, al tocarla.
							void navigate({ to: notification.actionUrl ?? "/dashboard" });
						}}
					>
						Ver
					</button>
				)}
			</div>
			<button
				type="button"
				aria-label="Descartar el aviso"
				className="text-muted-foreground hover:text-foreground"
				onClick={() => onDismiss(notification.id)}
			>
				<X className="size-4" />
			</button>
		</div>
	);
}
