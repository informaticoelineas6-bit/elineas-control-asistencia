import {
	CURRENCIES,
	type Currency,
	PAYROLL_CATEGORY_LABELS,
	type PayrollAdjustment,
	type PayrollAdjustmentCategory,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { useDebouncedValue } from "#/hooks/use-debounced-value.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	useCreateAdjustment,
	useRevertAdjustment,
} from "#/modules/payroll/api.ts";
import { usersQueryOptions } from "#/modules/users/api.ts";

/** El signo se elige, no se teclea (ver `AdjustmentDialog`). */
type Sign = "discount" | "bonus";

const CATEGORIES = Object.keys(
	PAYROLL_CATEGORY_LABELS,
) as PayrollAdjustmentCategory[];

/** "Como la del sueldo": el valor que no es una moneda del vocabulario. */
const INHERIT = "__inherit__";

/**
 * RN-17.8 — Alta de un ajuste manual.
 *
 * **El signo se elige en un par de botones y el importe se teclea siempre en
 * positivo.** La tabla lo guarda con signo, pero pedirlo así en el formulario
 * convierte un olvido de un carácter en una bonificación de 250 donde debía
 * haber un descuento — y en esta pantalla eso es dinero de alguien. El
 * formulario compone la cadena firmada; quien la escribe elige entre dos
 * palabras.
 */
export function AdjustmentDialog({ onClose }: { onClose: () => void }) {
	const create = useCreateAdjustment();

	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search);
	const people = useQuery(
		usersQueryOptions({ search: debouncedSearch || undefined }),
	);

	const [userId, setUserId] = useState("");
	const [sign, setSign] = useState<Sign>("discount");
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState<PayrollAdjustmentCategory>("other");
	const [currency, setCurrency] = useState<string>(INHERIT);
	const [description, setDescription] = useState("");
	const [period, setPeriod] = useState("");

	const chosen = people.data?.find((person) => person.id === userId);
	const signed = `${sign === "discount" ? "-" : ""}${amount.trim()}`;

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		create.mutate(
			{
				userId,
				amount: signed,
				category,
				description: description.trim(),
				period: period || undefined,
				currency: currency === INHERIT ? undefined : (currency as Currency),
			},
			{ onSuccess: onClose },
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Nuevo ajuste</DialogTitle>
						<DialogDescription>
							Mueve dinero de verdad: queda en la bitácora con tu nombre y se le
							notifica a la persona con el importe.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-2">
						<Label htmlFor="adjustment-person">Persona</Label>
						<Input
							id="adjustment-person"
							placeholder="Buscar por nombre o correo"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
						<Select value={userId} onValueChange={setUserId}>
							<SelectTrigger className="w-full" aria-label="Persona afectada">
								<SelectValue placeholder="Elige a quién afecta" />
							</SelectTrigger>
							<SelectContent>
								{(people.data ?? []).map((person) => (
									<SelectItem key={person.id} value={person.id}>
										{person.fullName}
										{person.departmentName && ` · ${person.departmentName}`}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label>Tipo</Label>
							<div className="flex gap-2">
								<Button
									type="button"
									className="flex-1"
									variant={sign === "discount" ? "default" : "outline"}
									onClick={() => setSign("discount")}
								>
									Descuento
								</Button>
								<Button
									type="button"
									className="flex-1"
									variant={sign === "bonus" ? "default" : "outline"}
									onClick={() => setSign("bonus")}
								>
									Bonificación
								</Button>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="adjustment-amount">Importe</Label>
							<div className="flex gap-2">
								<Input
									id="adjustment-amount"
									value={amount}
									onChange={(event) => setAmount(event.target.value)}
									placeholder="250.00"
									inputMode="decimal"
									className="flex-1"
								/>
								<Select value={currency} onValueChange={setCurrency}>
									<SelectTrigger className="w-32" aria-label="Moneda">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={INHERIT}>Del sueldo</SelectItem>
										{CURRENCIES.map((option) => (
											<SelectItem key={option} value={option}>
												{option}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="adjustment-category">Categoría</Label>
							<Select
								value={category}
								onValueChange={(next) =>
									setCategory(next as PayrollAdjustmentCategory)
								}
							>
								<SelectTrigger id="adjustment-category" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CATEGORIES.map((option) => (
										<SelectItem key={option} value={option}>
											{PAYROLL_CATEGORY_LABELS[option]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							<Label htmlFor="adjustment-period">Periodo</Label>
							<Input
								id="adjustment-period"
								type="month"
								value={period}
								onChange={(event) => setPeriod(event.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Vacío = el mes en curso.
							</p>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="adjustment-description">Motivo</Label>
						<Textarea
							id="adjustment-description"
							maxLength={500}
							placeholder="Obligatorio: dentro de un año nadie recordará por qué"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>

					{userId && amount.trim() && (
						<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
							<TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
							<span>
								{sign === "discount" ? "Se descontarán" : "Se abonarán"}{" "}
								<strong>{amount.trim()}</strong> a{" "}
								{chosen?.fullName ?? "esa persona"} en{" "}
								{period || "el mes en curso"}.
							</span>
						</p>
					)}

					<InlineError error={create.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button
							type="submit"
							disabled={create.isPending || !userId || !amount.trim()}
						>
							{create.isPending && <Loader2 className="animate-spin" />}
							Registrar ajuste
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * RN-17.4 — Reversión, con su motivo obligatorio.
 *
 * Enseña **de dónde vino** el ajuste, como pide la §5: uno automático nació de
 * una revisión de ausencia, y revertirlo aquí no reclasifica esa ausencia — si
 * más tarde alguien vuelve a marcarla como injustificada, nace un ajuste nuevo
 * (RN-13.4). Decirlo aquí evita la sorpresa de ver reaparecer un descuento.
 */
export function RevertDialog({
	adjustment,
	onClose,
}: {
	adjustment: PayrollAdjustment;
	onClose: () => void;
}) {
	const revert = useRevertAdjustment();
	const [reason, setReason] = useState("");

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		revert.mutate(
			{ id: adjustment.id, reason: reason.trim() },
			{ onSuccess: onClose },
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Revertir el ajuste</DialogTitle>
						<DialogDescription>
							{adjustment.amount} {adjustment.currency} de{" "}
							{adjustment.userFullName}, periodo{" "}
							{adjustment.effectivePeriod.slice(0, 7)}. No se borra: queda con
							tu nombre, la fecha y el motivo.
						</DialogDescription>
					</DialogHeader>

					<p className="rounded-md border bg-muted/40 p-3 text-sm">
						<strong>{PAYROLL_CATEGORY_LABELS[adjustment.category]}</strong>
						{adjustment.description && ` — ${adjustment.description}`}
						{adjustment.sourceType === "absence_review" && (
							<span className="mt-1 block text-muted-foreground">
								Lo generó la clasificación de una ausencia. Revertirlo aquí no
								cambia esa clasificación, y volver a marcarla como injustificada
								crearía un ajuste nuevo.
							</span>
						)}
					</p>

					<div className="space-y-2">
						<Label htmlFor="revert-reason">Motivo</Label>
						<Textarea
							id="revert-reason"
							maxLength={500}
							placeholder="Obligatorio: por qué deja de aplicarse"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
						/>
					</div>

					<InlineError error={revert.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button
							type="submit"
							variant="destructive"
							disabled={revert.isPending || reason.trim().length < 3}
						>
							{revert.isPending && <Loader2 className="animate-spin" />}
							Revertir
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
