import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCheck, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	notificationPagesQueryOptions,
	unreadCountQueryOptions,
	useMarkAllNotificationsRead,
} from "#/modules/notifications/api.ts";
import { NotificationItem } from "#/modules/notifications/notifications-bell.tsx";

export const Route = createFileRoute("/_authed/notifications")({
	component: NotificationsPage,
});

/**
 * Vista completa de notificaciones (spec 14 §8).
 *
 * **No lleva `RequireRole`**, y es la única pantalla del `AdminShell` que no lo
 * lleva: no hay rol que comprobar porque no hay ámbito que acotar. Cada persona
 * ve las suyas y sólo las suyas, y eso lo garantiza el servidor filtrando por la
 * sesión (RN-14.1) — ni un `superadmin` puede pedir las de otro, así que no
 * existe una versión "de más" de esta pantalla que haya que esconder.
 *
 * Tampoco aparece en el aside: se llega desde la campana. Un menú con "Inicio,
 * Marcar, Mi asistencia, Notificaciones…" pondría al mismo nivel una pantalla y
 * un icono que ya está siempre visible en la cabecera.
 *
 * A diferencia del panel de la campana, esto **pagina y no sondea**: quien está
 * revisando su historial no necesita que la lista se le mueva debajo del dedo, y
 * el aviso en vivo ya le dice si llega algo nuevo.
 */
function NotificationsPage() {
	const [unreadOnly, setUnreadOnly] = useState(false);
	const pages = useInfiniteQuery(notificationPagesQueryOptions(unreadOnly));
	const unread = useQuery(unreadCountQueryOptions());
	const markAllRead = useMarkAllNotificationsRead();

	const rows = pages.data?.pages.flatMap((page) => page.notifications) ?? [];
	const count = unread.data ?? 0;

	return (
		<div className="max-w-3xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Notificaciones</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{count > 0 ? `Tienes ${count} sin leer.` : "No tienes nada sin leer."}{" "}
					Al tocar una, se marca como leída y te lleva al recurso.
				</p>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Switch
						id="notifications-unread-only"
						checked={unreadOnly}
						onCheckedChange={setUnreadOnly}
					/>
					<Label
						htmlFor="notifications-unread-only"
						className="text-sm font-normal"
					>
						Sólo sin leer
					</Label>
				</div>

				{count > 0 && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => markAllRead.mutate()}
						disabled={markAllRead.isPending}
					>
						<CheckCheck />
						Marcar todas como leídas
					</Button>
				)}
			</div>

			<InlineError error={pages.error} />

			{pages.isPending ? (
				<div className="space-y-3">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
				</div>
			) : rows.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					{unreadOnly
						? "No tienes notificaciones sin leer."
						: "Todavía no tienes notificaciones. Aquí aparecerán las decisiones sobre tus solicitudes, los cambios de tu departamento y los recordatorios."}
				</div>
			) : (
				<>
					<ul className="divide-y rounded-xl border">
						{rows.map((notification) => (
							<NotificationItem
								key={notification.id}
								notification={notification}
							/>
						))}
					</ul>

					{pages.hasNextPage && (
						<Button
							type="button"
							variant="outline"
							disabled={pages.isFetchingNextPage}
							onClick={() => void pages.fetchNextPage()}
						>
							{pages.isFetchingNextPage && <Loader2 className="animate-spin" />}
							Cargar más
						</Button>
					)}
				</>
			)}
		</div>
	);
}
