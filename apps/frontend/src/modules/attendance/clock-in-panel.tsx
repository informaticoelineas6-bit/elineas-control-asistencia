import {
	type AttendanceMark,
	evaluateGeofence,
	formatDistance,
	type MarkType,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import {
	CircleAlert,
	CircleCheck,
	Clock,
	Crosshair,
	Loader2,
	LogIn,
	LogOut,
	MapPin,
	Satellite,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
	attendanceStatusQueryOptions,
	useCreateMark,
} from "#/modules/attendance/api.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { PermissionHelp } from "#/modules/geolocation/permission-help.tsx";
import { usePosition } from "#/modules/geolocation/use-position.ts";
import { myWorkLocationQueryOptions } from "#/modules/locations/api.ts";

/**
 * Pantalla de marcaje (spec 09 §5).
 *
 * Está pensada para un operario de pie, con una mano, y por eso el orden de la
 * pantalla es el orden de las preguntas que se hace: *¿dónde estoy?*, *¿qué me toca
 * marcar?*, *¿qué pasó con lo que ya marqué?*
 *
 * Tres cosas que la spec pide explícitamente y que aquí no son adorno:
 *
 * - **El estado del GPS se ve antes de intentar marcar**, no como error después. Si
 *   la lectura es mala o el permiso está denegado, se dice ahí, con qué hacer.
 * - **El botón se bloquea mientras la petición está en vuelo**, que es la mitad de
 *   la defensa contra el doble toque (la otra mitad es el antirrebote del servidor,
 *   RN-09.10).
 * - **El rechazo es accionable.** El mensaje viene del servidor ya redactado con los
 *   metros y las horas concretas; aquí no se reescribe, se muestra.
 *
 * El veredicto que se pinta antes de marcar se calcula **en el cliente** con la
 * misma función que usa el servidor (`evaluateGeofence`), y es sólo orientativo: la
 * decisión la toma el servidor recalculando (RN-08.2). Por eso el botón no se
 * deshabilita por estar fuera de la geocerca — se avisa, se deja intentar, y el
 * rechazo queda registrado, que es lo que sostiene una incidencia.
 */

const MARK_LABEL: Record<MarkType, string> = {
	IN: "Marcar entrada",
	OUT: "Marcar salida",
};

function MarkRow({ mark }: { mark: AttendanceMark }) {
	const time = new Date(mark.markedAt).toLocaleTimeString("es-CU", {
		hour: "2-digit",
		minute: "2-digit",
	});

	return (
		<li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
			<span className="flex items-center gap-2">
				{mark.markType === "IN" ? (
					<LogIn className="size-4 text-emerald-600" />
				) : (
					<LogOut className="size-4 text-sky-600" />
				)}
				<span className="font-medium tabular-nums">{time}</span>
				<span className="text-muted-foreground">
					{mark.markType === "IN" ? "Entrada" : "Salida"}
				</span>
			</span>
			<span className="flex items-center gap-2 text-xs text-muted-foreground">
				{mark.isLate && (
					<Badge variant="warning">{mark.lateMinutes} min tarde</Badge>
				)}
				{mark.workLocationName && (
					<span className="flex items-center gap-1">
						<MapPin className="size-3" />
						{mark.workLocationName}
					</span>
				)}
			</span>
		</li>
	);
}

export function ClockInPanel() {
	const session = useQuery(sessionQueryOptions());
	const status = useQuery(attendanceStatusQueryOptions());
	const mine = useQuery(
		myWorkLocationQueryOptions(session.data?.user.identityUserId),
	);
	const position = usePosition();
	const create = useCreateMark();

	const [result, setResult] = useState<{
		accepted: boolean;
		message: string;
	} | null>(null);

	const location = mine.data?.location ?? null;
	const reading = position.reading;

	// Veredicto orientativo, con la misma cuenta que hará el servidor.
	const preview =
		location && reading ? evaluateGeofence(location, reading) : null;

	const markType: MarkType | null = status.data?.nextMarkType ?? null;
	const busy = create.isPending;

	const onMark = async () => {
		if (!markType) return;
		setResult(null);

		// La lectura se pide **en el momento de marcar**, no la que había en pantalla:
		// entre que se abrió y se pulsa, la persona pudo moverse.
		const fresh = await position.read();
		if (!fresh) return;

		const outcome = await create.mutateAsync({
			markType,
			latitude: fresh.latitude,
			longitude: fresh.longitude,
			accuracy: fresh.accuracy,
			workLocationId: location?.id ?? null,
		});

		setResult({ accepted: outcome.accepted, message: outcome.message });
	};

	if (status.isPending || mine.isPending) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-xl space-y-5">
			<InlineError error={status.error} />

			{/* 1 — Dónde estoy. Antes de cualquier botón. */}
			<section className="space-y-3 rounded-xl border p-4">
				<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
					<Satellite className="size-4" />
					Ubicación
				</h2>

				{!location ? (
					<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
						No tienes sede seleccionada. Elígela en tu perfil antes de marcar.
					</p>
				) : (
					<p className="flex items-center gap-2 text-sm">
						<MapPin className="size-4 text-muted-foreground" />
						<span className="font-medium">{location.name}</span>
						<span className="text-muted-foreground">
							· radio {formatDistance(location.radiusMeters)}
						</span>
					</p>
				)}

				{!reading ? (
					<div className="space-y-2">
						<p className="text-sm text-muted-foreground">
							Hace falta tu ubicación para poder marcar. Se lee sólo cuando la
							pides.
						</p>
						<Button
							type="button"
							variant="outline"
							disabled={position.isReading}
							onClick={() => void position.read()}
						>
							{position.isReading ? (
								<Loader2 className="animate-spin" />
							) : (
								<Crosshair />
							)}
							Leer mi ubicación
						</Button>
					</div>
				) : (
					<div
						className={`rounded-lg border p-3 ${
							preview?.insideGeofence
								? "border-emerald-500/40 bg-emerald-500/10"
								: "border-rose-500/40 bg-rose-500/10"
						}`}
					>
						<p className="text-lg font-semibold">
							{preview?.insideGeofence
								? `Dentro de la geocerca · ${formatDistance(preview.distanceMeters)} del centro`
								: `Fuera · ${formatDistance(preview?.distanceMeters ?? 0)} del centro`}
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Precisión del GPS: ±{formatDistance(reading.accuracy)}
							{preview && !preview.accuracyOk && (
								<span className="text-amber-700 dark:text-amber-400">
									{" "}
									· peor que el umbral de la sede
									{preview.blockedByAccuracy
										? ", que bloquea el marcaje"
										: ", pero la sede lo tolera"}
								</span>
							)}
						</p>
					</div>
				)}

				<PermissionHelp permission={position.permission} />

				{position.error && (
					<p className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-400">
						<CircleAlert className="mt-0.5 size-4 shrink-0" />
						{position.error.message}
					</p>
				)}
			</section>

			{/* 2 — Qué me toca marcar. */}
			<section className="space-y-3 rounded-xl border p-4">
				<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
					<Clock className="size-4" />
					{status.data?.workDate
						? "Jornada en curso"
						: "Sin jornada que registrar"}
				</h2>

				<p className="text-sm">{status.data?.message}</p>

				{status.data?.openSince && (
					<p className="text-sm text-muted-foreground">
						Entrada abierta desde las{" "}
						{new Date(status.data.openSince).toLocaleTimeString("es-CU", {
							hour: "2-digit",
							minute: "2-digit",
						})}
						.
					</p>
				)}

				{status.data?.canMark && markType && (
					<Button
						type="button"
						size="lg"
						className="h-16 w-full text-base"
						disabled={busy || !reading}
						onClick={() => void onMark()}
					>
						{busy ? (
							<Loader2 className="animate-spin" />
						) : markType === "IN" ? (
							<LogIn />
						) : (
							<LogOut />
						)}
						{MARK_LABEL[markType]}
					</Button>
				)}

				{!reading && status.data?.canMark && (
					<p className="text-xs text-muted-foreground">
						Lee tu ubicación arriba para habilitar el botón.
					</p>
				)}

				<InlineError error={create.error} />

				{/* `<output>` y no `<p role="status">`: es el elemento que ya anuncia un
				    resultado a un lector de pantalla, sin rol postizo. */}
				{result && (
					<output
						className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
							result.accepted
								? "border-emerald-500/40 bg-emerald-500/10"
								: "border-rose-500/40 bg-rose-500/10"
						}`}
					>
						{result.accepted ? (
							<CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
						) : (
							<CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600" />
						)}
						{result.message}
					</output>
				)}
			</section>

			{/* 3 — Qué llevo marcado hoy. */}
			<section className="space-y-3 rounded-xl border p-4">
				<h2 className="text-sm font-medium text-muted-foreground">
					Marcas de esta jornada
				</h2>

				{status.data && status.data.marks.length > 0 ? (
					<ul className="space-y-2">
						{status.data.marks.map((mark) => (
							<MarkRow key={mark.id} mark={mark} />
						))}
					</ul>
				) : (
					<p className="rounded-md border border-dashed border-border/70 bg-muted/30 p-3 text-sm text-placeholder">
						Todavía no has marcado nada en esta jornada.
					</p>
				)}
			</section>
		</div>
	);
}
