import type { WorkLocation } from "@elineas/validations";
import {
	createWorkLocationInputSchema,
	formatDistance,
} from "@elineas/validations";
import { Crosshair, Loader2 } from "lucide-react";
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
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { MapView } from "#/components/ui/map.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { usePosition } from "#/modules/geolocation/use-position.ts";
import {
	useCreateWorkLocation,
	useUpdateWorkLocation,
} from "#/modules/locations/api.ts";

/**
 * Alta y edición de una sede (spec 08 §5).
 *
 * El mapa no es decoración: cuatro números —dos coordenadas, un radio y un umbral—
 * no se pueden verificar leyéndolos, y un centro mal puesto por treinta metros deja
 * a media planta sin poder marcar. Aquí se ve el círculo exacto que se va a exigir,
 * y las coordenadas siguen editables a mano para cuando los mosaicos no cargan.
 */

/** La Habana, para centrar el mapa de una sede nueva mientras no hay coordenadas. */
const FALLBACK_CENTER = { latitude: 23.1136, longitude: -82.3666 };

type Draft = {
	name: string;
	centerLat: string;
	centerLng: string;
	radiusMeters: string;
	accuracyThreshold: string;
	blockOnPoorAccuracy: boolean;
};

function draftFrom(location: WorkLocation | null): Draft {
	if (!location) {
		// Sin valores inventados salvo los dos que la spec deja al criterio de quien
		// configura: 100 m de radio y ±50 m de precisión son puntos de partida
		// visibles y editables, no reglas escondidas.
		return {
			name: "",
			centerLat: "",
			centerLng: "",
			radiusMeters: "100",
			accuracyThreshold: "50",
			blockOnPoorAccuracy: false,
		};
	}

	return {
		name: location.name,
		centerLat: String(location.centerLat),
		centerLng: String(location.centerLng),
		radiusMeters: String(location.radiusMeters),
		accuracyThreshold: String(location.accuracyThreshold),
		blockOnPoorAccuracy: location.blockOnPoorAccuracy,
	};
}

const asNumber = (value: string): number | null => {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
};

export function LocationFormDialog({
	location,
	onClose,
}: {
	location: WorkLocation | null;
	onClose: () => void;
}) {
	const create = useCreateWorkLocation();
	const update = useUpdateWorkLocation();
	const position = usePosition();

	const [draft, setDraft] = useState<Draft>(() => draftFrom(location));

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((current) => ({ ...current, [key]: value }));

	const parsed = createWorkLocationInputSchema.safeParse({
		name: draft.name,
		centerLat: asNumber(draft.centerLat),
		centerLng: asNumber(draft.centerLng),
		radiusMeters: asNumber(draft.radiusMeters),
		accuracyThreshold: asNumber(draft.accuracyThreshold),
		blockOnPoorAccuracy: draft.blockOnPoorAccuracy,
	});

	// El mismo esquema que valida el servidor, así que el aviso sale al teclear.
	const issue = parsed.success
		? null
		: (parsed.error.issues.at(0)?.message ?? "Revisa los datos de la sede.");

	// Al editar, el borrador ya trae las coordenadas de la sede; el respaldo sólo
	// entra en juego en una sede nueva, para tener algo que enseñar en el mapa
	// mientras nadie ha pinchado.
	const latitude = asNumber(draft.centerLat);
	const longitude = asNumber(draft.centerLng);
	const center =
		latitude !== null && longitude !== null
			? { latitude, longitude }
			: FALLBACK_CENTER;

	const radius = asNumber(draft.radiusMeters) ?? 0;
	const hasCenter = latitude !== null && longitude !== null;

	const pending = create.isPending || update.isPending;

	const onPickCenter = (point: { latitude: number; longitude: number }) => {
		// Seis decimales son ~11 cm: más dígitos sólo ensucian el campo.
		set("centerLat", point.latitude.toFixed(6));
		set("centerLng", point.longitude.toFixed(6));
	};

	const useMyPosition = async () => {
		const reading = await position.read();
		if (reading) onPickCenter(reading);
	};

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!parsed.success) return;

		if (location) {
			update.mutate(
				{ id: location.id, ...parsed.data },
				{ onSuccess: onClose },
			);
			return;
		}
		create.mutate(parsed.data, { onSuccess: onClose });
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{location ? `Editar ${location.name}` : "Nueva sede"}
					</DialogTitle>
					<DialogDescription>
						El centro y el radio deciden desde dónde se puede registrar
						asistencia. El cambio no afecta a los marcajes ya hechos, pero sí a
						todos los siguientes.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={onSubmit} className="space-y-4">
					<div className="grid gap-4 lg:grid-cols-2">
						<div className="space-y-3">
							<div className="space-y-2">
								<Label htmlFor="location-name">Nombre</Label>
								<Input
									id="location-name"
									value={draft.name}
									onChange={(event) => set("name", event.target.value)}
									placeholder="Sede Central"
									autoFocus
								/>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-2">
									<Label htmlFor="location-lat">Latitud</Label>
									<Input
										id="location-lat"
										inputMode="decimal"
										value={draft.centerLat}
										onChange={(event) => set("centerLat", event.target.value)}
										placeholder="23.113600"
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="location-lng">Longitud</Label>
									<Input
										id="location-lng"
										inputMode="decimal"
										value={draft.centerLng}
										onChange={(event) => set("centerLng", event.target.value)}
										placeholder="-82.366600"
									/>
								</div>
							</div>

							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={position.isReading}
								onClick={useMyPosition}
							>
								{position.isReading ? (
									<Loader2 className="animate-spin" />
								) : (
									<Crosshair />
								)}
								Usar mi ubicación actual
							</Button>
							{position.error && (
								<p className="text-xs text-amber-700 dark:text-amber-400">
									{position.error.message}
								</p>
							)}

							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-2">
									<Label htmlFor="location-radius">Radio (m)</Label>
									<Input
										id="location-radius"
										type="number"
										min={10}
										max={20000}
										value={draft.radiusMeters}
										onChange={(event) =>
											set("radiusMeters", event.target.value)
										}
									/>
									<p className="text-xs text-muted-foreground">
										Distancia máxima al centro para aceptar un marcaje.
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="location-accuracy">Precisión (±m)</Label>
									<Input
										id="location-accuracy"
										type="number"
										min={5}
										max={1000}
										value={draft.accuracyThreshold}
										onChange={(event) =>
											set("accuracyThreshold", event.target.value)
										}
									/>
									<p className="text-xs text-muted-foreground">
										Error del GPS que se considera aceptable.
									</p>
								</div>
							</div>

							<div className="flex items-start gap-3 rounded-lg border border-dashed border-border/70 p-3">
								<Switch
									id="location-block"
									checked={draft.blockOnPoorAccuracy}
									onCheckedChange={(checked) =>
										set("blockOnPoorAccuracy", checked)
									}
								/>
								<div>
									<Label htmlFor="location-block" className="font-normal">
										Bloquear con mala precisión
									</Label>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Apagado, una lectura peor que el umbral se acepta y queda
										registrada. Encendido, se rechaza el marcaje: útil dentro de
										naves donde el GPS miente, arriesgado si los teléfonos de
										planta son malos.
									</p>
								</div>
							</div>
						</div>

						<div className="space-y-2">
							<MapView
								center={center}
								circles={
									hasCenter && radius > 0
										? [{ center, radiusMeters: radius }]
										: []
								}
								markers={
									hasCenter
										? [
												{
													position: center,
													draggable: true,
													onDragEnd: onPickCenter,
													label: "Centro de la sede",
												},
											]
										: []
								}
								onSelect={onPickCenter}
								height={340}
								label="Selector de ubicación de la sede"
							/>
							{hasCenter && radius > 0 && (
								<p className="text-xs text-muted-foreground">
									Se aceptarán marcajes hasta {formatDistance(radius)} del
									centro.
								</p>
							)}
						</div>
					</div>

					{issue && (
						<p
							role="alert"
							className="text-sm text-amber-700 dark:text-amber-400"
						>
							{issue}
						</p>
					)}
					<InlineError error={create.error ?? update.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button type="submit" disabled={!!issue || pending}>
							{pending && <Loader2 className="animate-spin" />}
							{location ? "Guardar cambios" : "Crear sede"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
