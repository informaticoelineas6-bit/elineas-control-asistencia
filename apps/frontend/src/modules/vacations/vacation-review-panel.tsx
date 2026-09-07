import type { VacationRequest } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Check, ClipboardList, X } from "lucide-react";
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
import { Label } from "#/components/ui/label.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { formatShortDate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	useReviewVacationRequest,
	vacationRequestsQueryOptions,
} from "#/modules/vacations/api.ts";

/**
 * Bandeja de vacaciones pendientes (spec 11 §5.2), en `/team`.
 *
 * `scope=managed` sin `departmentId` trae **todo** el ámbito de quien pregunta
 * (RN-03.2): un `department_head` con dos departamentos ve las pendientes de
 * los dos en una sola lista, sin tener que elegir uno primero — la revisión es
 * por persona, no por departamento, a diferencia de los grupos de descanso.
 *
 * ⚠️ Sin la "cobertura del equipo" que la §5.2 propone (quién más está de
 * vacaciones en esas fechas): queda para cuando haga falta de verdad, y no
 * bloquea aprobar o rechazar — el jefe ya ve las fechas de cada solicitud.
 */
export function VacationReviewPanel() {
	const pending = useQuery(
		vacationRequestsQueryOptions({ scope: "managed", status: "pending" }),
	);

	const [reviewing, setReviewing] = useState<VacationRequest | null>(null);

	return (
		<section className="space-y-4">
			<div>
				<h3 className="flex items-center gap-2 font-medium">
					<ClipboardList className="size-4" />
					Vacaciones pendientes
				</h3>
				<p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
					De todo tu ámbito. Aprobar bloquea el marcaje de esas fechas
					(RN-11.9); rechazar exige un motivo.
				</p>
			</div>

			<InlineError error={pending.error} />

			{pending.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : (pending.data?.length ?? 0) === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					No hay solicitudes pendientes.
				</div>
			) : (
				<ul className="space-y-3">
					{pending.data?.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
						>
							<div>
								<p className="font-medium">{item.userFullName}</p>
								<p className="text-sm text-muted-foreground">
									{formatShortDate(item.startDate)} al{" "}
									{formatShortDate(item.endDate)} ({item.requestedDays}{" "}
									{item.requestedDays === 1 ? "día" : "días"})
								</p>
							</div>
							<Button
								type="button"
								size="sm"
								onClick={() => setReviewing(item)}
							>
								Revisar
							</Button>
						</li>
					))}
				</ul>
			)}

			{reviewing && (
				<ReviewDialog request={reviewing} onClose={() => setReviewing(null)} />
			)}
		</section>
	);
}

function ReviewDialog({
	request,
	onClose,
}: {
	request: VacationRequest;
	onClose: () => void;
}) {
	const review = useReviewVacationRequest();
	const [comment, setComment] = useState("");

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Revisar solicitud de {request.userFullName}</DialogTitle>
					<DialogDescription>
						{formatShortDate(request.startDate)} al{" "}
						{formatShortDate(request.endDate)} — {request.requestedDays}{" "}
						{request.requestedDays === 1 ? "día" : "días"} de su saldo.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-2">
					<Label htmlFor="review-comment">Comentario</Label>
					<Textarea
						id="review-comment"
						maxLength={500}
						placeholder="Obligatorio sólo si rechazas"
						value={comment}
						onChange={(event) => setComment(event.target.value)}
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
									id: request.id,
									approved: false,
									comment: comment.trim() || undefined,
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
									id: request.id,
									approved: true,
									comment: comment.trim() || undefined,
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
