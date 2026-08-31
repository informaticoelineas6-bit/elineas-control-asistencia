import type { WorkLocation } from "@elineas/validations";
import { formatDistance } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import {
	Check,
	CircleAlert,
	Crosshair,
	Loader2,
	MapPin,
	ShieldCheck,
} from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { MapView } from "#/components/ui/map.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { PermissionHelp } from "#/modules/geolocation/permission-help.tsx";
import { usePosition } from "#/modules/geolocation/use-position.ts";
import {
	myWorkLocationQueryOptions,
	useCheckLocation,
	useSelectWorkLocation,
	workLocationsQueryOptions,
} from "#/modules/locations/api.ts";

/**
 * "Mi sede de trabajo" (spec 08 RN-08.7/RN-08.8), en el perfil propio.
 *
 * Dos cosas a la vez, y por eso están juntas: **elegir** la sede contra la que se
 * validarán los marcajes, y **comprobar** ahí mismo si desde donde estás ahora se
 * podría marcar. Lo segundo es lo que evita que alguien descubra el problema a las
 * siete de la mañana, en la puerta, con el reloj corriendo.
 *
 * El veredicto lo da el servidor (RN-08.2): esta pantalla manda lat/lng y precisión
 * y pinta lo que responde. Calcularlo aquí sería exactamente lo que la regla
 * prohíbe, y además volvería a abrir el hueco de *"la app dice que estoy fuera"*
 * sin poder demostrar quién tiene razón.
 */
export function MyLocationCard() {
	const session = useQuery(sessionQueryOptions());
	const mine = useQuery(
		myWorkLocationQueryOptions(session.data?.user.identityUserId),
	);
	const locations = useQuery(workLocationsQueryOptions());
	const select = useSelectWorkLocation();
	const check = useCheckLocation();
	const position = usePosition();

	const verdict = check.data ?? null;
	const selected = mine.data?.location ?? null;
	const reading = position.reading;

	const onCheck = async () => {
		const next = await position.read();
		if (next) check.mutate(next);
	};

	if (mine.isPending || locations.isPending) {
		return (
			<section className="rounded-xl border p-4">
				<Skeleton className="h-48 w-full" />
			</section>
		);
	}

	const active = locations.data ?? [];

	return (
		<section className="space-y-4 rounded-xl border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
						<MapPin className="size-4" />
						Mi sede de trabajo
					</h2>
					<p className="mt-1 text-sm">
						Tus marcajes se validan contra <strong>esta</strong> sede. Estar
						dentro de otra no sirve: si hoy trabajas en otro sitio, cámbiala
						aquí.
					</p>
				</div>
				{!selected && mine.data?.required && (
					<Badge variant="warning">Sin sede elegida</Badge>
				)}
			</div>

			<InlineError error={mine.error ?? locations.error} />
			<InlineError error={select.error} />

			{active.length === 0 ? (
				<p className="rounded-md border border-dashed border-border/70 bg-muted/30 p-3 text-sm text-muted-foreground">
					Todavía no hay ninguna sede activa. Hasta que un gestor cree una, no
					se puede registrar asistencia.
				</p>
			) : (
				<ul className="space-y-1">
					{active.map((location) => (
						<li key={location.id}>
							<SedeOption
								location={location}
								selected={selected?.id === location.id}
								pending={
									select.isPending &&
									select.variables?.workLocationId === location.id
								}
								distanceMeters={
									verdict?.nearby.find((each) => each.id === location.id)
										?.distanceMeters ?? null
								}
								onSelect={() => select.mutate({ workLocationId: location.id })}
							/>
						</li>
					))}
				</ul>
			)}

			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={position.isReading || check.isPending}
					onClick={onCheck}
				>
					{position.isReading || check.isPending ? (
						<Loader2 className="animate-spin" />
					) : (
						<Crosshair />
					)}
					Comprobar mi ubicación
				</Button>
				{reading && (
					<span className="text-xs text-muted-foreground">
						Precisión del GPS: ±{formatDistance(reading.accuracy)}
					</span>
				)}
			</div>

			<PermissionHelp permission={position.permission} />
			{position.error && position.permission !== "denied" && (
				<p className="text-sm text-amber-700 dark:text-amber-400">
					{position.error.message}
				</p>
			)}
			<InlineError error={check.error} />

			{verdict && (
				<div
					className={`flex items-start gap-3 rounded-md border p-3 text-sm ${
						verdict.allowed
							? "border-emerald-500/40 bg-emerald-500/10"
							: "border-rose-500/40 bg-rose-500/10"
					}`}
				>
					{verdict.allowed ? (
						<ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
					) : (
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600" />
					)}
					<div>
						<p className="font-medium">
							{verdict.allowed
								? "Desde aquí podrías marcar"
								: "Desde aquí no podrías marcar"}
						</p>
						<p className="mt-0.5 text-muted-foreground">{verdict.message}</p>
					</div>
				</div>
			)}

			{selected && (
				<MapView
					center={{
						latitude: selected.centerLat,
						longitude: selected.centerLng,
					}}
					circles={[
						{
							center: {
								latitude: selected.centerLat,
								longitude: selected.centerLng,
							},
							radiusMeters: selected.radiusMeters,
						},
						...(reading
							? [
									{
										center: {
											latitude: reading.latitude,
											longitude: reading.longitude,
										},
										// El círculo de la lectura es el error que reporta el propio
										// GPS: si es enorme, se ve por qué el veredicto puede no
										// coincidir con lo que la persona percibe.
										radiusMeters: Math.max(reading.accuracy, 5),
										tone: "muted" as const,
									},
								]
							: []),
					]}
					markers={[
						{
							position: {
								latitude: selected.centerLat,
								longitude: selected.centerLng,
							},
							label: selected.name,
						},
						...(reading
							? [
									{
										position: {
											latitude: reading.latitude,
											longitude: reading.longitude,
										},
										tone: "danger" as const,
										label: "Tu ubicación",
									},
								]
							: []),
					]}
					fitPoints={
						reading
							? [
									{
										latitude: selected.centerLat,
										longitude: selected.centerLng,
									},
									{ latitude: reading.latitude, longitude: reading.longitude },
								]
							: undefined
					}
					height={260}
					label={`Mapa de ${selected.name}`}
				/>
			)}
		</section>
	);
}

function SedeOption({
	location,
	selected,
	pending,
	distanceMeters,
	onSelect,
}: {
	location: WorkLocation;
	selected: boolean;
	pending: boolean;
	distanceMeters: number | null;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={pending}
			onClick={onSelect}
			className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
				selected
					? "border-primary bg-primary/10"
					: "border-transparent hover:border-border hover:bg-accent/50"
			}`}
		>
			<span
				className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
					selected
						? "border-primary bg-primary text-primary-foreground"
						: "border-input"
				}`}
			>
				{pending ? (
					<Loader2 className="size-3 animate-spin" />
				) : (
					selected && <Check className="size-3" />
				)}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium">{location.name}</span>
				<span className="block text-xs text-muted-foreground">
					Radio de {formatDistance(location.radiusMeters)}
					{location.blockOnPoorAccuracy
						? " · exige buena precisión de GPS"
						: ""}
				</span>
			</span>
			{distanceMeters !== null && (
				<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
					a {formatDistance(distanceMeters)}
				</span>
			)}
		</button>
	);
}
