import type { AttendanceIncident, IncidentType } from "@elineas/validations";
import {
	INCIDENT_STATUS_LABELS,
	INCIDENT_TYPE_LABELS,
	incidentDateIssue,
	incidentRequiresReason,
	incidentTypeSchema,
	MARK_REJECTION_MESSAGES,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Link2, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
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
import { formatShortDate, toISODate } from "#/lib/dates.ts";
import { publicConfigQueryOptions } from "#/modules/config/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	incidentsQueryOptions,
	ownBlockedMarksQueryOptions,
	useReportIncident,
} from "#/modules/incidents/api.ts";

/**
 * "Mis incidencias" (spec 12 §6, lado del empleado): reportar un problema con el
 * marcaje y ver en qué quedó.
 *
 * El formulario valida la fecha con la **misma función** que el servidor
 * (`incidentDateIssue`) y la misma cifra de plazo, que llega en la configuración
 * pública (RN-12.4): así el aviso aparece al elegir el día, no después de
 * enviar. El motivo obligatorio se decide igual, con `incidentRequiresReason`
 * (RN-12.1).
 *
 * Y cuando el día elegido tiene **intentos de marcaje rechazados**, se ofrecen
 * para enlazarlos (RN-12.2). Es la idea de la cabecera de la spec: si el sistema
 * ya guardó "a las 08:04 intentaste marcar y estabas a 340 m de la sede", la
 * incidencia se abre con esa fila delante en vez de con un relato.
 */

const STATUS_VARIANT: Record<
	AttendanceIncident["status"],
	"secondary" | "default" | "destructive"
> = {
	pending: "secondary",
	approved: "default",
	rejected: "destructive",
};

export function MyIncidentsPanel() {
	const incidents = useQuery(incidentsQueryOptions({ scope: "own" }));
	const config = useQuery(publicConfigQueryOptions());
	const report = useReportIncident();

	const today = toISODate(new Date());

	const [incidentType, setIncidentType] =
		useState<IncidentType>("forgot_to_mark");
	const [date, setDate] = useState(today);
	const [reason, setReason] = useState("");
	const [markId, setMarkId] = useState<string | null>(null);

	const blocked = useQuery(ownBlockedMarksQueryOptions(date || null));

	const windowDays = config.data?.incident_report_window_days ?? 0;
	const dateIssue = date
		? incidentDateIssue({ date, today, windowDays })
		: "Elige el día al que se refiere la incidencia.";
	const needsReason = incidentRequiresReason(incidentType);
	const missingReason = needsReason && reason.trim().length === 0;

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (dateIssue || missingReason) return;

		report.mutate(
			{
				incidentType,
				date,
				reason: reason.trim(),
				attendanceMarkId: markId,
			},
			{
				onSuccess: () => {
					setReason("");
					setMarkId(null);
				},
			},
		);
	};

	return (
		<div className="space-y-6">
			<form
				onSubmit={onSubmit}
				className="space-y-4 rounded-xl border p-4 sm:p-5"
			>
				<div>
					<h2 className="font-medium">Reportar una incidencia</h2>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Queda constancia para tu jefe. No corrige tu marcaje ni lo crea: es
						un reporte, y quien lo revisa decide qué hacer con él.
					</p>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="incident-type">Qué pasó</Label>
						<Select
							value={incidentType}
							onValueChange={(value) => {
								setIncidentType(value as IncidentType);
								setMarkId(null);
							}}
						>
							<SelectTrigger id="incident-type" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{incidentTypeSchema.options.map((type) => (
									<SelectItem key={type} value={type}>
										{INCIDENT_TYPE_LABELS[type]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="incident-date">Día</Label>
						<Input
							id="incident-date"
							type="date"
							max={today}
							value={date}
							onChange={(event) => {
								setDate(event.target.value);
								setMarkId(null);
							}}
						/>
					</div>
				</div>

				<div className="space-y-2">
					<Label htmlFor="incident-reason">
						Motivo{needsReason ? "" : " (opcional)"}
					</Label>
					<Textarea
						id="incident-reason"
						maxLength={1000}
						placeholder={
							needsReason
								? "Explica qué pasó: es obligatorio para este tipo."
								: "El sistema ya guardó el intento rechazado; añade algo sólo si aporta."
						}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
					/>
				</div>

				{/*
				 * RN-12.2. Sólo aparece si ese día hubo intentos rechazados: ofrecer un
				 * selector vacío haría pensar que falta un dato que no existe.
				 */}
				{(blocked.data?.length ?? 0) > 0 && (
					<fieldset className="space-y-2 rounded-lg border bg-muted/30 p-3">
						<legend className="flex items-center gap-2 px-1 text-sm font-medium">
							<Link2 className="size-4" />
							Intentos rechazados de ese día
						</legend>
						<p className="text-xs text-muted-foreground">
							Enlaza el que estás reportando y tu jefe lo revisa con la
							evidencia delante.
						</p>
						<div className="space-y-1.5">
							{blocked.data?.map((mark) => (
								<label
									key={mark.id}
									className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-muted/60"
								>
									<input
										type="radio"
										name="incident-mark"
										className="mt-1"
										checked={markId === mark.id}
										onChange={() => setMarkId(mark.id)}
									/>
									<span>
										<span className="font-medium">
											{new Date(mark.markedAt).toLocaleTimeString("es-CU", {
												hour: "2-digit",
												minute: "2-digit",
											})}
										</span>{" "}
										· {mark.markType === "IN" ? "entrada" : "salida"} ·{" "}
										{mark.blockReason
											? MARK_REJECTION_MESSAGES[mark.blockReason]
											: "rechazado"}
										{mark.distanceToCenter !== null && (
											<span className="text-muted-foreground">
												{" "}
												({Math.round(mark.distanceToCenter)} m de la sede)
											</span>
										)}
									</span>
								</label>
							))}
						</div>
						{markId && (
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setMarkId(null)}
							>
								Quitar el enlace
							</Button>
						)}
					</fieldset>
				)}

				{dateIssue && date && (
					<p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
						<TriangleAlert className="mt-0.5 size-4 shrink-0" />
						{dateIssue}
					</p>
				)}

				<InlineError error={report.error} />

				<div className="flex items-center gap-3">
					<Button
						type="submit"
						disabled={!!dateIssue || missingReason || report.isPending}
					>
						{report.isPending && <Loader2 className="animate-spin" />}
						Reportar
					</Button>
					{windowDays > 0 && (
						<span className="text-xs text-muted-foreground">
							El plazo para reportar es de {windowDays}{" "}
							{windowDays === 1 ? "día" : "días"}.
						</span>
					)}
				</div>
			</form>

			<section className="space-y-3">
				<h2 className="font-medium">Mis incidencias</h2>

				<InlineError error={incidents.error} />

				{incidents.isPending ? (
					<Skeleton className="h-32 w-full" />
				) : (incidents.data?.length ?? 0) === 0 ? (
					<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
						Todavía no has reportado ninguna.
					</div>
				) : (
					<ul className="space-y-2">
						{incidents.data?.map((item) => (
							<li
								key={item.id}
								className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-3.5"
							>
								<div className="min-w-0">
									<p className="font-medium">
										{INCIDENT_TYPE_LABELS[item.incidentType]}
									</p>
									<p className="text-sm text-muted-foreground">
										{formatShortDate(item.date)}
										{item.attendanceMarkId && " · con marcaje enlazado"}
									</p>
									{item.reason && <p className="mt-1 text-sm">{item.reason}</p>}
									{item.managerNotes && (
										<p className="mt-1 flex items-start gap-2 text-sm text-muted-foreground">
											<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
											{item.managerNotes}
										</p>
									)}
								</div>
								<Badge variant={STATUS_VARIANT[item.status]}>
									{INCIDENT_STATUS_LABELS[item.status]}
								</Badge>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
