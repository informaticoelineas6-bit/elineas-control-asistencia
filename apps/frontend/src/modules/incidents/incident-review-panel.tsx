import type { AttendanceIncident, IncidentType } from "@elineas/validations";
import {
	INCIDENT_TYPE_LABELS,
	incidentTypeSchema,
	MARK_REJECTION_MESSAGES,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Check, FileWarning, Search, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { useDebouncedValue } from "#/hooks/use-debounced-value.ts";
import { formatShortDate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	incidentContextQueryOptions,
	incidentsQueryOptions,
	useReviewIncident,
} from "#/modules/incidents/api.ts";

/**
 * Bandeja de incidencias (spec 12 §6, lado de gestión), en `/team`.
 *
 * `scope=managed` sin `departmentId` trae **todo** el ámbito de quien pregunta
 * (RN-03.2), igual que la de vacaciones: un jefe con dos departamentos las ve en
 * una sola lista.
 *
 * Se piden **todas**, no sólo las pendientes: el orden del servidor ya pone las
 * pendientes primero (§6), y ver las últimas revisadas debajo es lo que evita
 * revisar dos veces lo mismo y responder distinto. El filtro de estado está ahí
 * para acotarlo.
 *
 * La acción combinada *"Aprobar y justificar la ausencia"* que propone la §6 **no
 * está**: es la decisión 1 de la §9 y necesita la spec 13, que no existe. Lo que
 * sí hace el diálogo es decirlo en voz alta —aprobar no cambia el marcaje
 * (RN-12.9)—, porque el desacople del legacy no era un problema de código sino
 * de que nadie sabía que las dos cosas eran dos cosas.
 */

const ANY = "__any__";

export function IncidentReviewPanel() {
	const [search, setSearch] = useState("");
	const [type, setType] = useState<IncidentType | typeof ANY>(ANY);
	const debouncedSearch = useDebouncedValue(search, 300);

	const incidents = useQuery(
		incidentsQueryOptions({
			scope: "managed",
			...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
			...(type === ANY ? {} : { incidentType: type }),
		}),
	);

	const [reviewing, setReviewing] = useState<AttendanceIncident | null>(null);

	return (
		<section className="space-y-4">
			<div>
				<h2 className="flex items-center gap-2 font-medium">
					<FileWarning className="size-4" />
					Incidencias de asistencia
				</h2>
				<p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
					Lo que tu gente reporta sobre su marcaje. Las pendientes salen
					primero. Revisar deja constancia; no modifica ningún marcaje.
				</p>
			</div>

			<div className="flex flex-wrap gap-3">
				<div className="relative min-w-56 flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						className="pl-8"
						placeholder="Persona, correo o departamento"
						aria-label="Buscar incidencias"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<Select
					value={type}
					onValueChange={(value) => setType(value as IncidentType | typeof ANY)}
				>
					<SelectTrigger className="w-56" aria-label="Filtrar por tipo">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ANY}>Todos los tipos</SelectItem>
						{incidentTypeSchema.options.map((option) => (
							<SelectItem key={option} value={option}>
								{INCIDENT_TYPE_LABELS[option]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<InlineError error={incidents.error} />

			{incidents.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : (incidents.data?.length ?? 0) === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					No hay incidencias en tu ámbito.
				</div>
			) : (
				<ul className="space-y-3">
					{incidents.data?.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-4"
						>
							<div className="min-w-0">
								<p className="font-medium">{item.userFullName}</p>
								<p className="text-sm text-muted-foreground">
									{INCIDENT_TYPE_LABELS[item.incidentType]} ·{" "}
									{formatShortDate(item.date)}
									{item.departmentName && ` · ${item.departmentName}`}
								</p>
								{item.reason && <p className="mt-1 text-sm">{item.reason}</p>}
							</div>
							{item.status === "pending" ? (
								<Button
									type="button"
									size="sm"
									onClick={() => setReviewing(item)}
								>
									Revisar
								</Button>
							) : (
								<Badge
									variant={
										item.status === "approved" ? "default" : "destructive"
									}
								>
									{item.status === "approved" ? "Aprobada" : "Rechazada"}
								</Badge>
							)}
						</li>
					))}
				</ul>
			)}

			{reviewing && (
				<ReviewDialog incident={reviewing} onClose={() => setReviewing(null)} />
			)}
		</section>
	);
}

/**
 * El contexto de la §6 —estado del día, marcas y intentos rechazados— se pide al
 * abrir el diálogo y no con la lista: son dos consultas por incidencia, y
 * resolverlas para toda la bandeja sería trabajo que nadie mira.
 */
function ReviewDialog({
	incident,
	onClose,
}: {
	incident: AttendanceIncident;
	onClose: () => void;
}) {
	const review = useReviewIncident();
	const context = useQuery(incidentContextQueryOptions(incident.id));
	const [notes, setNotes] = useState("");

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{INCIDENT_TYPE_LABELS[incident.incidentType]} de{" "}
						{incident.userFullName}
					</DialogTitle>
					<DialogDescription>
						{formatShortDate(incident.date)}. Aprobar deja constancia:{" "}
						<strong>no crea ni corrige ningún marcaje</strong> (RN-12.9).
					</DialogDescription>
				</DialogHeader>

				{incident.reason && (
					<p className="rounded-md border bg-muted/40 p-3 text-sm">
						{incident.reason}
					</p>
				)}

				<div className="space-y-2 rounded-md border p-3 text-sm">
					<p className="text-xs font-medium text-muted-foreground">
						Ese día, según el sistema
					</p>
					{context.isPending ? (
						<Skeleton className="h-16 w-full" />
					) : context.error ? (
						<InlineError error={context.error} />
					) : (
						context.data && (
							<>
								<p>
									Estado: <strong>{context.data.day.status}</strong>
									{context.data.day.incomplete && " (jornada sin cerrar)"}
								</p>
								{context.data.day.marks.length === 0 ? (
									<p className="text-muted-foreground">Sin marcajes válidos.</p>
								) : (
									<ul className="space-y-0.5">
										{context.data.day.marks.map((mark) => (
											<li key={mark.id}>
												{mark.markType === "IN" ? "Entrada" : "Salida"} a las{" "}
												{new Date(mark.markedAt).toLocaleTimeString("es-CU", {
													hour: "2-digit",
													minute: "2-digit",
												})}
												{mark.isLate && ` · ${mark.lateMinutes} min tarde`}
											</li>
										))}
									</ul>
								)}
								{context.data.blockedMarks.length > 0 && (
									<div className="space-y-0.5 border-t pt-2">
										<p className="text-xs font-medium text-muted-foreground">
											Intentos rechazados
										</p>
										{context.data.blockedMarks.map((mark) => (
											<p
												key={mark.id}
												className={
													mark.id === incident.attendanceMarkId
														? "font-medium"
														: "text-muted-foreground"
												}
											>
												{new Date(mark.markedAt).toLocaleTimeString("es-CU", {
													hour: "2-digit",
													minute: "2-digit",
												})}{" "}
												·{" "}
												{mark.blockReason
													? MARK_REJECTION_MESSAGES[mark.blockReason]
													: "rechazado"}
												{mark.distanceToCenter !== null &&
													` (${Math.round(mark.distanceToCenter)} m)`}
												{mark.id === incident.attendanceMarkId && " ← enlazado"}
											</p>
										))}
									</div>
								)}
							</>
						)
					)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="incident-notes">Notas</Label>
					<Textarea
						id="incident-notes"
						maxLength={1000}
						placeholder="Obligatorio sólo si rechazas"
						value={notes}
						onChange={(event) => setNotes(event.target.value)}
					/>
				</div>

				<InlineError error={review.error} />

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={review.isPending}
						onClick={() =>
							review.mutate(
								{
									id: incident.id,
									approved: false,
									notes: notes.trim() || undefined,
								},
								{ onSuccess: onClose },
							)
						}
					>
						<X />
						Rechazar
					</Button>
					<Button
						type="button"
						disabled={review.isPending}
						onClick={() =>
							review.mutate(
								{
									id: incident.id,
									approved: true,
									notes: notes.trim() || undefined,
								},
								{ onSuccess: onClose },
							)
						}
					>
						<Check />
						Aprobar
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
