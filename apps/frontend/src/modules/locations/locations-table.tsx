import type { WorkLocation } from "@elineas/validations";
import { formatDistance } from "@elineas/validations";
import { Copy, Ellipsis, MapPinOff, Pencil, Play } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";

/**
 * Tabla de sedes (spec 08 §5), con las acciones en un desplegable por fila
 * (`packages/docs/ui.md`).
 *
 * No hay acción de eliminar: una sede se desactiva (RN-08.10). El historial de
 * marcajes necesita seguir sabiendo contra qué geocerca se validó cada uno, y una
 * fila borrada deja ese historial hablando de una sede que "no existió nunca".
 */

export type LocationAction = "edit" | "deactivate" | "reactivate" | "copy";

export function LocationsTable({
	locations,
	onAction,
	busyId,
}: {
	locations: WorkLocation[];
	onAction: (action: LocationAction, location: WorkLocation) => void;
	busyId: string | null;
}) {
	return (
		<div className="rounded-xl border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="pl-4">Sede</TableHead>
						<TableHead>Centro</TableHead>
						<TableHead>Radio</TableHead>
						<TableHead>Precisión</TableHead>
						<TableHead className="w-12 pr-4 text-right">Acciones</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{locations.map((location) => (
						<TableRow key={location.id} data-inactive={!location.isActive}>
							<TableCell className="max-w-xs pl-4 whitespace-normal">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{location.name}</span>
									{!location.isActive && (
										<Badge variant="warning">
											<MapPinOff />
											Desactivada
										</Badge>
									)}
								</div>
							</TableCell>

							<TableCell className="text-muted-foreground tabular-nums">
								{location.centerLat.toFixed(5)}, {location.centerLng.toFixed(5)}
							</TableCell>

							<TableCell className="tabular-nums">
								{formatDistance(location.radiusMeters)}
							</TableCell>

							<TableCell className="text-muted-foreground">
								<span className="tabular-nums">
									±{formatDistance(location.accuracyThreshold)}
								</span>
								<span className="block text-xs">
									{location.blockOnPoorAccuracy
										? "bloquea si es peor"
										: "sólo advierte"}
								</span>
							</TableCell>

							<TableCell className="pr-4 text-right">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={busyId === location.id}
											aria-label={`Acciones de ${location.name}`}
										>
											<Ellipsis />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-56">
										<DropdownMenuLabel>{location.name}</DropdownMenuLabel>
										<DropdownMenuSeparator />

										<DropdownMenuItem
											onSelect={() => onAction("edit", location)}
										>
											<Pencil />
											Editar
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() => onAction("copy", location)}
										>
											<Copy />
											Copiar coordenadas
										</DropdownMenuItem>

										<DropdownMenuSeparator />

										{location.isActive ? (
											<DropdownMenuItem
												variant="destructive"
												onSelect={() => onAction("deactivate", location)}
											>
												<MapPinOff />
												Desactivar
											</DropdownMenuItem>
										) : (
											<DropdownMenuItem
												onSelect={() => onAction("reactivate", location)}
											>
												<Play />
												Reactivar
											</DropdownMenuItem>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
