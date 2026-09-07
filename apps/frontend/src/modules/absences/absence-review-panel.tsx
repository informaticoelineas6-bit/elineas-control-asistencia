import type {
	PayrollAdjustmentEffect,
	PendingAbsence,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import {
	CalendarX,
	Check,
	CircleAlert,
	Loader2,
	TriangleAlert,
	X,
} from "lucide-react";
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
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { formatShortDate, toISODate } from "#/lib/dates.ts";
import {
	absenceReviewsQueryOptions,
	pendingAbsencesQueryOptions,
	useReviewAbsence,
} from "#/modules/absences/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Bandeja de ausencias por clasificar (spec 13 §5 y §7), en `/team`.
 *
 * **Es la vista que el legacy no tenía.** Allí las ausencias sólo se veían
 * navegando día por día desde el panel de departamento o el global, y la §5 lo
 * señala como una carencia: sin una bandeja, una ausencia sin revisar no aparece
 * en ninguna parte hasta que alguien abre el día exacto. Y es **un solo
 * componente con el ámbito implícito en la sesión**, como pide esa misma
 * sección: el servidor devuelve lo que quien pregunta gestiona (RN-03.2), así
 * que no hacen falta dos pantallas —una de jefe y otra de gestor— que escriban
 * lo mismo.
 *
 * La §7 pide tres cosas y las tres están: dos acciones claras con notas, la
 * **confirmación explícita del impacto económico** antes de marcar como no
 * justificada, y quién y cuándo tomó la decisión anterior si se está cambiando.
 *
 * ⚠️ La advertencia económica dice **el hecho, no la cifra**: quien clasifica es
 * normalmente el jefe de departamento, que no tiene acceso al sueldo de nadie
 * (RN-17.1, hallazgo H-3), y el descuento es el sueldo dividido por el divisor.
 * El importe sólo llega a un rol administrativo, y el servidor es quien decide
 * eso — aquí sólo se pinta lo que venga.
 */
export function AbsenceReviewPanel() {
	const [range, setRange] = useState(() => {
		const today = new Date();
		return {
			from: toISODate(new Date(today.getTime() - 30 * 86_400_000)),
			to: toISODate(today),
		};
	});

	const pending = useQuery(pendingAbsencesQueryOptions(range));
	const [reviewing, setReviewing] = useState<PendingAbsence | null>(null);

	return (
		<section className="space-y-4">
			<div>
				<h2 className="flex items-center gap-2 font-medium">
					<CalendarX className="size-4" />
					Ausencias por clasificar
				</h2>
				<p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
					Días laborables sin marcaje de tu ámbito. Marcar una ausencia como no
					justificada <strong>aplica un descuento</strong>; justificarla lo
					revierte.
				</p>
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="absences-from" className="text-xs">
						Desde
					</Label>
					<Input
						id="absences-from"
						type="date"
						max={range.to}
						value={range.from}
						onChange={(event) =>
							setRange((current) => ({ ...current, from: event.target.value }))
						}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="absences-to" className="text-xs">
						Hasta
					</Label>
					<Input
						id="absences-to"
						type="date"
						min={range.from}
						max={toISODate(new Date())}
						value={range.to}
						onChange={(event) =>
							setRange((current) => ({ ...current, to: event.target.value }))
						}
					/>
				</div>
			</div>

			<InlineError error={pending.error} />

			{pending.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : (pending.data?.length ?? 0) === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					No hay ausencias sin clasificar en ese rango.
				</div>
			) : (
				<ul className="space-y-3">
					{pending.data?.map((item) => (
						<li
							key={`${item.userId}|${item.date}`}
							className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
						>
							<div className="min-w-0">
								<p className="font-medium">{item.userFullName}</p>
								<p className="text-sm text-muted-foreground">
									{formatShortDate(item.date)}
									{item.departmentName && ` · ${item.departmentName}`}
								</p>
							</div>
							<div className="flex items-center gap-2">
								{/*
								 * RN-13.10: mientras nadie decida, el día ya cuenta como ANJ en
								 * la presentación — pero sin descuento. Enseñarlo evita la
								 * lectura de que "sin revisar" es neutro.
								 */}
								<Badge variant="warning">ANJ sin revisar</Badge>
								<Button
									type="button"
									size="sm"
									onClick={() => setReviewing(item)}
								>
									Clasificar
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}

			{reviewing && (
				<ReviewDialog absence={reviewing} onClose={() => setReviewing(null)} />
			)}
		</section>
	);
}

function effectMessage(effect: PayrollAdjustmentEffect): string {
	switch (effect.effect) {
		case "created":
			return effect.amount
				? `Se aplicó un descuento de ${effect.amount} ${effect.currency}.`
				: "Se aplicó el descuento de un día de salario.";
		case "reverted":
			return effect.amount
				? `Se revirtió el descuento de ${effect.amount} ${effect.currency}.`
				: "Se revirtió el descuento que había.";
		case "skipped_no_salary":
			return "No se aplicó descuento: esa persona no tiene sueldo configurado.";
		default:
			return "La nómina no cambió.";
	}
}

function ReviewDialog({
	absence,
	onClose,
}: {
	absence: PendingAbsence;
	onClose: () => void;
}) {
	const review = useReviewAbsence();
	const [notes, setNotes] = useState("");
	const [confirmingDiscount, setConfirmingDiscount] = useState(false);

	// §7: si ya había una decisión sobre este día, hay que decir quién la tomó y
	// cuándo. Se pide sólo al abrir el diálogo, y para este día exacto.
	const previous = useQuery(
		absenceReviewsQueryOptions({
			from: absence.date,
			to: absence.date,
			userId: absence.userId,
		}),
	);
	const earlier = previous.data?.at(0);

	const submit = (isJustified: boolean) =>
		review.mutate(
			{
				userId: absence.userId,
				date: absence.date,
				isJustified,
				notes: notes.trim() || undefined,
			},
			{ onSuccess: () => setConfirmingDiscount(false) },
		);

	const done = review.data;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Ausencia de {absence.userFullName} el{" "}
						{formatShortDate(absence.date)}
					</DialogTitle>
					<DialogDescription>
						Un día laborable sin ningún marcaje. Tu decisión afecta al reporte
						del mes y a la nómina.
					</DialogDescription>
				</DialogHeader>

				{earlier && (
					<p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
						<CircleAlert className="mt-0.5 size-4 shrink-0" />
						<span>
							Ya había una decisión:{" "}
							<strong>
								{earlier.isJustified ? "justificada" : "no justificada"}
							</strong>{" "}
							el {formatShortDate(earlier.reviewedAt.slice(0, 10))}.
							{earlier.notes && ` «${earlier.notes}»`}
						</span>
					</p>
				)}

				{done ? (
					<div className="space-y-3">
						<p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
							Quedó como{" "}
							<strong>
								{done.review.isJustified ? "justificada" : "no justificada"}
							</strong>
							. {effectMessage(done.payrollAdjustment)}
						</p>
						<DialogFooter>
							<Button type="button" onClick={onClose}>
								Cerrar
							</Button>
						</DialogFooter>
					</div>
				) : (
					<>
						<div className="space-y-2">
							<Label htmlFor="absence-notes">Notas</Label>
							<Textarea
								id="absence-notes"
								maxLength={1000}
								placeholder="Obligatorio sólo si la justificas"
								value={notes}
								onChange={(event) => setNotes(event.target.value)}
							/>
						</div>

						{/*
						 * §7 — La confirmación explícita del impacto económico, que el
						 * legacy no daba. Es un segundo paso y no un `confirm()` porque lo
						 * que hay que leer antes de seguir es *qué* va a pasar.
						 */}
						{confirmingDiscount && (
							<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
								<TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
								<span>
									Se aplicará un <strong>descuento de un día de salario</strong>{" "}
									a {absence.userFullName}, y se le notificará. Vuelve a pulsar
									para confirmar.
								</span>
							</p>
						)}

						<InlineError error={review.error} />

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={review.isPending}
								onClick={() => {
									if (!confirmingDiscount) {
										setConfirmingDiscount(true);
										return;
									}
									submit(false);
								}}
							>
								{review.isPending && <Loader2 className="animate-spin" />}
								<X />
								{confirmingDiscount
									? "Confirmar: no justificada"
									: "No justificada"}
							</Button>
							<Button
								type="button"
								disabled={review.isPending || notes.trim().length === 0}
								title={
									notes.trim().length === 0
										? "Justificar exige explicar el motivo"
										: undefined
								}
								onClick={() => submit(true)}
							>
								<Check />
								Justificada
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
