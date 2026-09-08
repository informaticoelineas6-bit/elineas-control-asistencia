import type { AppConfigValues, WorkLocation } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, MapPinOff, Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog.tsx";
import { MapView } from "#/components/ui/map.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	useDeactivateWorkLocation,
	useReactivateWorkLocation,
	workLocationsQueryOptions,
} from "#/modules/locations/api.ts";
import { LocationFormDialog } from "#/modules/locations/location-form.tsx";
import {
	type LocationAction,
	LocationsTable,
} from "#/modules/locations/locations-table.tsx";

/**
 * Pestaña *Sedes y geocerca* de Configuración (spec 08 §5).
 *
 * Muestra **todas** las sedes, activas y desactivadas: la lista completa es
 * información de gestión y sólo la ve un gestor global, que es quien entra aquí.
 *
 * El mapa de conjunto no es un adorno: con tres sedes en la misma ciudad, ver los
 * círculos juntos es la única forma de notar que dos se solapan — y con geocercas
 * solapadas, la sede que alguien tenga elegida decide si puede marcar o no
 * (RN-08.5).
 */
export function LocationsTab({ config }: { config: AppConfigValues }) {
	const locations = useQuery(
		workLocationsQueryOptions({ includeInactive: true }),
	);
	const deactivate = useDeactivateWorkLocation();
	const reactivate = useReactivateWorkLocation();

	const [editing, setEditing] = useState<WorkLocation | null | "new">(null);
	const [confirming, setConfirming] = useState<WorkLocation | null>(null);
	const [actionError, setActionError] = useState<Error | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	const busyId = deactivate.isPending
		? (deactivate.variables?.id ?? null)
		: reactivate.isPending
			? (reactivate.variables?.id ?? null)
			: null;

	const onAction = (action: LocationAction, location: WorkLocation) => {
		setActionError(null);
		setCopied(null);

		switch (action) {
			case "edit":
				setEditing(location);
				return;
			case "deactivate":
				setConfirming(location);
				return;
			case "reactivate":
				reactivate.mutate({ id: location.id }, { onError: setActionError });
				return;
			case "copy":
				void navigator.clipboard
					?.writeText(`${location.centerLat}, ${location.centerLng}`)
					.then(() => setCopied(location.id));
				return;
		}
	};

	const active = (locations.data ?? []).filter((each) => each.isActive);

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<p className="max-w-2xl text-sm text-muted-foreground">
					Cada sede es un círculo: un centro y un radio. Un marcaje se acepta si
					la lectura del GPS cae dentro del círculo de{" "}
					<strong>la sede que esa persona tiene elegida</strong>, y el servidor
					recalcula siempre la distancia — nunca se cree la que envía el
					teléfono.
				</p>
				<Button onClick={() => setEditing("new")}>
					<Plus />
					Nueva sede
				</Button>
			</div>

			<InlineError error={actionError} />
			<InlineError error={locations.error} />
			{copied && (
				<p className="text-sm text-muted-foreground">
					Coordenadas copiadas al portapapeles.
				</p>
			)}

			{locations.isPending && <Skeleton className="h-40 w-full" />}

			{locations.data?.length === 0 && (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/30 p-12 text-center">
					<MapPin className="size-8 text-placeholder" />
					<div>
						<h2 className="font-medium">Todavía no hay sedes</h2>
						<p className="mt-1 max-w-sm text-sm text-muted-foreground">
							Sin ninguna sede activa nadie puede registrar asistencia: no hay
							contra qué validar la ubicación. Crea la primera.
						</p>
					</div>
					<Button variant="outline" onClick={() => setEditing("new")}>
						<Plus />
						Crear sede
					</Button>
				</div>
			)}

			{locations.data && locations.data.length > 0 && (
				<>
					<LocationsTable
						locations={locations.data}
						onAction={onAction}
						busyId={busyId}
					/>

					{active.length > 0 && (
						<div className="space-y-2 rounded-xl border p-5">
							<h3 className="font-medium">Las sedes activas en el mapa</h3>
							<p className="text-sm text-muted-foreground">
								Cada círculo es el área desde la que se acepta un marcaje. Si
								dos se solapan, quien esté en la zona común sólo podrá marcar en
								la sede que tenga elegida.
							</p>
							<MapView
								center={{
									latitude: active[0]?.centerLat ?? 0,
									longitude: active[0]?.centerLng ?? 0,
								}}
								circles={active.map((each) => ({
									center: {
										latitude: each.centerLat,
										longitude: each.centerLng,
									},
									radiusMeters: each.radiusMeters,
								}))}
								markers={active.map((each) => ({
									position: {
										latitude: each.centerLat,
										longitude: each.centerLng,
									},
									label: each.name,
								}))}
								fitPoints={active.map((each) => ({
									latitude: each.centerLat,
									longitude: each.centerLng,
								}))}
								height={320}
								label="Mapa de las sedes activas"
							/>
						</div>
					)}
				</>
			)}

			{/*
			 * El modo de salida por geocerca se configura en la pestaña General (spec 06
			 * §3.2), pero la advertencia pertenece aquí: es esta capa la que no puede
			 * sostenerlo hoy (§4, deuda del punto 77).
			 */}
			{config.attendance_checkout_mode === "geofence_exit" && (
				<div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
					<TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
					<div className="text-sm">
						<p className="font-medium">
							El modo de salida «por geocerca» está activo
						</p>
						<p className="mt-1 text-muted-foreground">
							Ese modo necesita seguimiento de ubicación en segundo plano, y hoy
							no es fiable: Android corta el proceso con la pantalla apagada.
							Las jornadas pueden quedarse sin salida sin que nadie lo note
							hasta el reporte. Un navegador no puede resolverlo, así que usa el
							modo manual o el cierre por horario.
						</p>
					</div>
				</div>
			)}

			{editing !== null && (
				<LocationFormDialog
					key={editing === "new" ? "new" : editing.id}
					location={editing === "new" ? null : editing}
					onClose={() => setEditing(null)}
				/>
			)}

			<Dialog
				open={confirming !== null}
				onOpenChange={(open) => !open && setConfirming(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Desactivar {confirming?.name}</DialogTitle>
						<DialogDescription>
							Dejará de poder elegirse y nadie podrá marcar contra ella. A quien
							la tenga elegida se le quitará la selección y se le avisará para
							que escoja otra. No se borra: el historial de marcajes sigue
							apuntando aquí, y puedes reactivarla.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirming(null)}
						>
							Cancelar
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={deactivate.isPending}
							onClick={() => {
								if (!confirming) return;
								deactivate.mutate(
									{ id: confirming.id },
									{
										onSuccess: () => setConfirming(null),
										onError: (error) => {
											setActionError(error);
											setConfirming(null);
										},
									},
								);
							}}
						>
							{deactivate.isPending && <Loader2 className="animate-spin" />}
							<MapPinOff />
							Desactivar
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
