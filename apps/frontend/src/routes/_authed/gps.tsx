import { formatDistance } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	CircleAlert,
	Copy,
	Crosshair,
	Loader2,
	Radio,
	ShieldCheck,
	Square,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { MapView } from "#/components/ui/map.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { readingAgeSeconds } from "#/modules/geolocation/location-layer.ts";
import { PermissionHelp } from "#/modules/geolocation/permission-help.tsx";
import { usePosition } from "#/modules/geolocation/use-position.ts";
import {
	myWorkLocationQueryOptions,
	useCheckLocation,
} from "#/modules/locations/api.ts";

const PATH = "/gps" as const;

export const Route = createFileRoute("/_authed/gps")({
	component: () => (
		<RequireRole path={PATH}>
			<GpsDiagnosticsPage />
		</RequireRole>
	),
});

const PERMISSION_LABEL = {
	granted: "Concedido",
	prompt: "Sin conceder todavía",
	denied: "Denegado",
	unsupported: "No disponible en este dispositivo",
	unknown: "Desconocido hasta que se pida",
} as const;

/**
 * Diagnóstico de GPS (spec 08 §6).
 *
 * Existe para resolver **un** reclamo, el más común de todos: *"la app dice que estoy
 * fuera y estoy dentro"*. Y lo resuelve enseñando las tres cosas que hacen falta para
 * saber quién tiene razón: qué lee el dispositivo, con cuánto error, y qué concluye el
 * servidor con esa lectura (RN-08.2).
 *
 * La accesible a cualquier rol a propósito: el que la va a usar de verdad es el jefe
 * en planta, con el teléfono de otro en la mano.
 */
function GpsDiagnosticsPage() {
	const session = useQuery(sessionQueryOptions());
	const mine = useQuery(
		myWorkLocationQueryOptions(session.data?.user.identityUserId),
	);
	const position = usePosition();
	const check = useCheckLocation();
	const [copied, setCopied] = useState(false);

	const selected = mine.data?.location ?? null;
	const reading = position.reading;
	const verdict = check.data ?? null;

	const readAndCheck = async () => {
		setCopied(false);
		const next = await position.read();
		if (next) check.mutate(next);
	};

	const copyReport = () => {
		const lines = [
			"Diagnóstico de GPS · Control de Asistencia",
			`Usuario: ${session.data?.user.email ?? "—"}`,
			`Permiso: ${PERMISSION_LABEL[position.permission]}`,
			`Sede seleccionada: ${selected ? selected.name : "ninguna"}`,
			selected
				? `Geocerca: radio ${formatDistance(selected.radiusMeters)}, precisión hasta ±${formatDistance(selected.accuracyThreshold)}, ${selected.blockOnPoorAccuracy ? "bloquea" : "advierte"} con mala precisión`
				: "",
			reading
				? `Lectura: ${reading.latitude.toFixed(6)}, ${reading.longitude.toFixed(6)} · ±${formatDistance(reading.accuracy)} · hace ${readingAgeSeconds(reading)} s`
				: "Lectura: sin datos",
			verdict
				? `Veredicto del servidor: ${verdict.allowed ? "permitido" : `rechazado (${verdict.reason})`} — ${verdict.message}`
				: "Veredicto del servidor: sin comprobar",
			`Fecha: ${new Date().toISOString()}`,
		].filter(Boolean);

		void navigator.clipboard
			?.writeText(lines.join("\n"))
			.then(() => setCopied(true));
	};

	return (
		<div className="max-w-4xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Diagnóstico de GPS</h1>
				<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
					Qué lee este dispositivo, con cuánta precisión, y qué decide el
					servidor con esa lectura. Es la pantalla para cuando la aplicación
					dice que estás fuera de tu sede y no lo entiendes.
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					disabled={position.isReading || check.isPending}
					onClick={readAndCheck}
				>
					{position.isReading || check.isPending ? (
						<Loader2 className="animate-spin" />
					) : (
						<Crosshair />
					)}
					Leer y comprobar
				</Button>
				{position.isWatching ? (
					<Button
						type="button"
						variant="outline"
						onClick={position.stopWatching}
					>
						<Square />
						Detener seguimiento
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						onClick={position.startWatching}
					>
						<Radio />
						Seguir en vivo
					</Button>
				)}
				<Button type="button" variant="ghost" onClick={copyReport}>
					<Copy />
					Copiar el diagnóstico
				</Button>
				{copied && (
					<span className="text-sm text-muted-foreground">
						Copiado: pégalo en el mensaje a soporte.
					</span>
				)}
			</div>

			<PermissionHelp permission={position.permission} />
			{position.error && position.permission !== "denied" && (
				<p className="text-sm text-amber-700 dark:text-amber-400">
					{position.error.message}
				</p>
			)}
			<InlineError error={check.error ?? mine.error} />

			<section className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-3 rounded-xl border p-4">
					<h2 className="text-sm font-medium text-muted-foreground">
						Este dispositivo
					</h2>
					<dl className="space-y-2 text-sm">
						<Row label="Permiso de ubicación">
							{PERMISSION_LABEL[position.permission]}
						</Row>
						<Row label="Origen de la lectura">
							Navegador (GPS del dispositivo)
						</Row>
						<Row label="Seguimiento en vivo">
							{position.isWatching ? "Activo" : "Detenido"}
						</Row>
						<Row label="Coordenadas">
							{reading
								? `${reading.latitude.toFixed(6)}, ${reading.longitude.toFixed(6)}`
								: "—"}
						</Row>
						<Row label="Precisión">
							{reading ? `±${formatDistance(reading.accuracy)}` : "—"}
						</Row>
						<Row label="Antigüedad de la lectura">
							{reading ? `${readingAgeSeconds(reading)} s` : "—"}
						</Row>
					</dl>
					{/*
					 * La deuda del punto 77, dicha donde alguien la puede leer: el
					 * seguimiento sólo vive mientras esta pantalla esté abierta.
					 */}
					<p className="text-xs text-muted-foreground">
						El seguimiento en vivo funciona con la pantalla abierta. Android
						detiene el proceso en segundo plano, así que no sirve para cerrar
						jornadas solo.
					</p>
				</div>

				<div className="space-y-3 rounded-xl border p-4">
					<h2 className="text-sm font-medium text-muted-foreground">
						Tu sede y el veredicto del servidor
					</h2>
					{selected ? (
						<dl className="space-y-2 text-sm">
							<Row label="Sede seleccionada">{selected.name}</Row>
							<Row label="Radio permitido">
								{formatDistance(selected.radiusMeters)}
							</Row>
							<Row label="Precisión exigida">
								±{formatDistance(selected.accuracyThreshold)}{" "}
								{selected.blockOnPoorAccuracy ? "(bloquea)" : "(sólo advierte)"}
							</Row>
							<Row label="Distancia al centro">
								{verdict?.distanceMeters !== null &&
								verdict?.distanceMeters !== undefined
									? formatDistance(verdict.distanceMeters)
									: "—"}
							</Row>
							<Row label="Veredicto">
								{verdict ? (
									<span className="inline-flex items-center gap-1.5">
										{verdict.allowed ? (
											<>
												<ShieldCheck className="size-4 text-emerald-600" />
												Dentro
											</>
										) : (
											<>
												<CircleAlert className="size-4 text-rose-600" />
												{verdict.reason === "OUTSIDE_GEOFENCE" &&
												verdict.distanceMeters !== null
													? `Fuera por ${formatDistance(Math.max(0, verdict.distanceMeters - selected.radiusMeters))}`
													: "No se puede marcar"}
											</>
										)}
									</span>
								) : (
									"Sin comprobar"
								)}
							</Row>
						</dl>
					) : (
						<p className="text-sm text-muted-foreground">
							No tienes ninguna sede seleccionada. Elígela en{" "}
							<strong>Mi perfil</strong>: sin sede no hay contra qué validar la
							ubicación.
						</p>
					)}

					{verdict && (
						<p className="rounded-md border bg-muted/40 p-3 text-sm">
							{verdict.message}
						</p>
					)}
				</div>
			</section>

			{verdict && verdict.nearby.length > 0 && (
				<section className="space-y-2">
					<h2 className="text-sm font-medium text-muted-foreground">
						Todas las sedes activas, por distancia
					</h2>
					<div className="rounded-xl border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="pl-4">Sede</TableHead>
									<TableHead>Distancia</TableHead>
									<TableHead>¿Dentro?</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{verdict.nearby.map((each) => (
									<TableRow key={each.id}>
										<TableCell className="pl-4">
											{each.name}
											{each.id === selected?.id && (
												<Badge variant="secondary" className="ml-2">
													La tuya
												</Badge>
											)}
										</TableCell>
										<TableCell className="tabular-nums">
											{formatDistance(each.distanceMeters)}
										</TableCell>
										<TableCell>
											{each.insideGeofence ? (
												<Badge variant="secondary">Dentro</Badge>
											) : (
												<span className="text-muted-foreground">Fuera</span>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
					<p className="text-xs text-muted-foreground">
						Estar dentro de otra sede no permite marcar: el marcaje se valida
						contra la que tengas elegida. Si hoy trabajas en otra, cámbiala en
						tu perfil.
					</p>
				</section>
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
					height={320}
					label="Mapa del diagnóstico"
				/>
			)}
		</div>
	);
}

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right">{children}</dd>
		</div>
	);
}
