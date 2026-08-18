import type { Notification } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
	notificationsQueryOptions,
	unreadCountQueryOptions,
	useMarkAllNotificationsRead,
	useMarkNotificationRead,
} from "#/modules/notifications/api.ts";

/**
 * Campana de notificaciones (spec 14), en su mínimo viable.
 *
 * El contador se sondea cada 30 s (RN-14.4); la lista sólo se pide cuando se abre
 * el panel, para no traer treinta registros que nadie va a mirar. Falta el aviso
 * emergente al llegar una nueva (RN-14.5), que llega con la entrega en vivo.
 */
export function NotificationsBell() {
	const [open, setOpen] = useState(false);
	const unread = useQuery(unreadCountQueryOptions());
	const count = unread.data ?? 0;

	return (
		<>
			<Button
				variant="ghost"
				size="icon-sm"
				className="relative"
				onClick={() => setOpen(true)}
				aria-label={
					count > 0 ? `Notificaciones, ${count} sin leer` : "Notificaciones"
				}
			>
				<Bell />
				{count > 0 && (
					<span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-white tabular-nums">
						{count > 9 ? "9+" : count}
					</span>
				)}
			</Button>

			<Sheet open={open} onOpenChange={setOpen}>
				<NotificationsPanel unreadCount={count} />
			</Sheet>
		</>
	);
}

function NotificationsPanel({ unreadCount }: { unreadCount: number }) {
	const notifications = useQuery(notificationsQueryOptions());
	const markAllRead = useMarkAllNotificationsRead();

	return (
		<SheetContent className="w-full gap-0 sm:max-w-md">
			<SheetHeader>
				<SheetTitle>Notificaciones</SheetTitle>
				<SheetDescription>
					{unreadCount > 0
						? `Tienes ${unreadCount} sin leer.`
						: "No tienes nada sin leer."}
				</SheetDescription>
			</SheetHeader>

			{unreadCount > 0 && (
				<div className="px-4 pb-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => markAllRead.mutate()}
						disabled={markAllRead.isPending}
					>
						<CheckCheck />
						Marcar todas como leídas
					</Button>
				</div>
			)}

			<div className="flex-1 overflow-y-auto border-t">
				{notifications.isPending && (
					<div className="space-y-3 p-4">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				)}

				{notifications.data?.length === 0 && (
					<p className="p-6 text-center text-sm text-muted-foreground">
						Aquí aparecerán los avisos que te afecten: pausas de tu
						departamento, decisiones sobre tus solicitudes y recordatorios.
					</p>
				)}

				<ul className="divide-y">
					{notifications.data?.map((notification) => (
						<NotificationItem
							key={notification.id}
							notification={notification}
						/>
					))}
				</ul>
			</div>
		</SheetContent>
	);
}

/**
 * Fecha relativa corta. Se calcula en el cliente a propósito: la hora del
 * servidor viene en ISO y quien lee la nota está en su propia zona.
 */
function relativeTime(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const minutes = Math.round(diffMs / 60_000);
	if (minutes < 1) return "ahora mismo";
	if (minutes < 60) return `hace ${minutes} min`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `hace ${hours} h`;

	const days = Math.round(hours / 24);
	if (days < 7) return `hace ${days} d`;

	return new Date(iso).toLocaleDateString("es-CU", {
		day: "numeric",
		month: "short",
	});
}

function NotificationItem({ notification }: { notification: Notification }) {
	const navigate = useNavigate();
	const markRead = useMarkNotificationRead();
	const isUnread = notification.readAt === null;

	const onClick = () => {
		if (isUnread) markRead.mutate(notification.id);
		if (notification.actionUrl) {
			void navigate({ to: notification.actionUrl });
		}
	};

	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-accent/60"
			>
				<span
					aria-hidden
					data-unread={isUnread}
					className="mt-1.5 size-2 shrink-0 rounded-full bg-primary data-[unread=false]:bg-transparent"
				/>
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline justify-between gap-2">
						<span
							data-unread={isUnread}
							className="text-sm data-[unread=true]:font-medium"
						>
							{notification.title}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">
							{relativeTime(notification.createdAt)}
						</span>
					</span>
					<span className="mt-1 block text-sm text-muted-foreground">
						{notification.body}
					</span>
				</span>
			</button>
		</li>
	);
}
