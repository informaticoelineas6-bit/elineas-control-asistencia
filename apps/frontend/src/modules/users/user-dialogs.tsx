import {
	CURRENCIES,
	type Currency,
	DEFAULT_CURRENCY,
	type DepartmentSummary,
	type UserProfile,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
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
import { PhoneInput } from "#/components/ui/phone-input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	compensationQueryOptions,
	responsibilitiesQueryOptions,
	useDeactivateUser,
	useDeleteUser,
	useUpdateCompensation,
	useUpdateResponsibilities,
	useUpdateUser,
} from "#/modules/users/api.ts";

/**
 * Diálogos de la gestión de usuarios (spec 02).
 *
 * Igual que en departamentos, cada uno se monta sólo mientras está abierto y pinta
 * sus errores con el mensaje del backend. El del sueldo está aparte de la ficha a
 * propósito: es el único que pide el dato, así que quien nunca lo abre no lo recibe
 * en el navegador (spec 02 §6).
 */

type DialogProps = { onClose: () => void };

/** Valor centinela del selector: "sin departamento" no puede ser cadena vacía. */
const NO_DEPARTMENT = "__none__";

/**
 * Paso 2 del alta (§5.1): departamento, teléfono y baja contractual.
 *
 * Nombre y correo se muestran pero no se editan: son de la identidad y los
 * sincroniza el Identity Server (RN-00.45). Editarlos aquí crearía dos verdades.
 */
export function EditUserDialog({
	user,
	departments,
	onClose,
}: DialogProps & { user: UserProfile; departments: DepartmentSummary[] }) {
	const [departmentId, setDepartmentId] = useState(
		user.departmentId ?? NO_DEPARTMENT,
	);
	const [phone, setPhone] = useState(user.phone ?? "");
	const [contractCancelled, setContractCancelled] = useState(
		user.contractCancelledAt ? user.contractCancelledAt.slice(0, 10) : "",
	);
	const update = useUpdateUser();

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		update.mutate(
			{
				id: user.id,
				departmentId: departmentId === NO_DEPARTMENT ? null : departmentId,
				phone: phone.trim() || null,
				contractCancelledAt: contractCancelled
					? new Date(`${contractCancelled}T00:00:00.000Z`).toISOString()
					: null,
			},
			{ onSuccess: onClose },
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{user.fullName}</DialogTitle>
						<DialogDescription>
							{user.email} · el nombre y el correo se gestionan en el Identity
							Server.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-2">
						<Label htmlFor="user-department">Departamento</Label>
						<Select value={departmentId} onValueChange={setDepartmentId}>
							<SelectTrigger id="user-department" className="w-full">
								<SelectValue placeholder="Sin asignar" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NO_DEPARTMENT}>Sin asignar</SelectItem>
								{departments.map((department) => (
									<SelectItem key={department.id} value={department.id}>
										{department.name}
										{department.isPaused ? " (en pausa)" : ""}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{departmentId === NO_DEPARTMENT && (
							<p className="text-xs text-muted-foreground">
								Sin departamento no puede registrar asistencia.
							</p>
						)}
					</div>

					<div className="space-y-2">
						<Label htmlFor="user-phone">Teléfono</Label>
						<PhoneInput
							id="user-phone"
							value={phone}
							onChange={setPhone}
							placeholder="+53 5 1234567"
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="user-contract">Fin de contrato</Label>
						<Input
							id="user-contract"
							type="date"
							value={contractCancelled}
							onChange={(event) => setContractCancelled(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Informativo, independiente de que la cuenta esté activa o no.
						</p>
					</div>

					<InlineError error={update.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button type="submit" disabled={update.isPending}>
							{update.isPending && <Loader2 className="animate-spin" />}
							Guardar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Sueldo (spec 02 §6a). Se pide al abrir y no antes, porque este diálogo es el
 * único sitio de la aplicación por donde ese dato viaja.
 */
export function CompensationDialog({
	user,
	onClose,
}: DialogProps & { user: UserProfile }) {
	const current = useQuery(compensationQueryOptions(user.id));
	const update = useUpdateCompensation();
	// Nulo = "no se ha tocado": se muestra lo que hay guardado hasta que alguien
	// escriba o elija algo distinto.
	const [amount, setAmount] = useState<string | null>(null);
	const [picked, setPicked] = useState<Currency | null>(null);

	const value = amount ?? current.data?.monthlySalary ?? "";
	const currency = picked ?? current.data?.currency ?? DEFAULT_CURRENCY;

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		update.mutate(
			{ id: user.id, monthlySalary: value.trim() || null, currency },
			{ onSuccess: onClose },
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Sueldo de {user.fullName}</DialogTitle>
						<DialogDescription>
							Dato sensible: sólo lo ven los gestores globales, y todo cambio
							queda en la bitácora con el importe anterior y el nuevo.
						</DialogDescription>
					</DialogHeader>

					{current.isPending ? (
						<Skeleton className="h-9 w-full" />
					) : (
						<div className="space-y-2">
							<Label htmlFor="user-salary">Sueldo mensual</Label>
							<div className="flex gap-2">
								<Input
									id="user-salary"
									value={value}
									onChange={(event) => setAmount(event.target.value)}
									placeholder="3500.00"
									inputMode="decimal"
									className="flex-1"
								/>
								<Select
									value={currency}
									onValueChange={(next) => setPicked(next as Currency)}
								>
									<SelectTrigger
										className="w-32"
										aria-label="Moneda del sueldo"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{CURRENCIES.map((option) => (
											<SelectItem key={option} value={option}>
												<span className="font-medium">{option}</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<p className="text-xs text-muted-foreground">
								Vacío = sin sueldo registrado.
								{current.data?.updatedAt
									? ` Última modificación: ${new Date(current.data.updatedAt).toLocaleDateString("es-CU")}.`
									: ""}
							</p>
						</div>
					)}

					<InlineError error={current.error ?? update.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button
							type="submit"
							disabled={update.isPending || current.isPending}
						>
							{update.isPending && <Loader2 className="animate-spin" />}
							Guardar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ámbito departamental (spec 03 §7, RN-03.2).
 *
 * Lo que se marca aquí son los departamentos **adicionales**: el propio del
 * perfil siempre está dentro y por eso aparece fijo y no se puede desmarcar.
 *
 * Esta pantalla **no otorga roles**. Dar responsabilidades a quien no es
 * `department_head` no le sirve de nada — el ámbito sólo se aplica a ese rol
 * (RN-03.2)— y el rol se asigna en la consola del Identity Server (RN-03.8). Se
 * permite marcarlos igualmente para poder dejar el ámbito preparado antes de que
 * allí le den el rol, pero se avisa.
 */
export function ResponsibilitiesDialog({
	user,
	departments,
	onClose,
}: DialogProps & { user: UserProfile; departments: DepartmentSummary[] }) {
	const current = useQuery(responsibilitiesQueryOptions(user.id));
	const update = useUpdateResponsibilities();
	const [picked, setPicked] = useState<string[] | null>(null);

	// Hasta que responde el backend no hay selección propia: se pinta la suya.
	const selected =
		picked ??
		current.data?.additionalDepartments.map((department) => department.id) ??
		[];

	const toggle = (id: string) =>
		setPicked(
			selected.includes(id)
				? selected.filter((each) => each !== id)
				: [...selected, id],
		);

	// El propio no se elige: ya está en el ámbito y guardarlo lo ataría a un
	// departamento que puede cambiar (RN-03.2).
	const selectable = departments.filter(
		(department) => department.id !== user.departmentId,
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Departamentos a cargo de {user.fullName}</DialogTitle>
					<DialogDescription>
						Define qué departamentos entran en su ámbito. Sólo tiene efecto para
						un jefe de departamento; los <strong>roles</strong> se asignan en el
						Identity Server, no aquí.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-2">
					<Label>Su departamento</Label>
					<p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
						{user.departmentName ?? "Sin departamento asignado"}
						<span className="ml-2 text-xs text-muted-foreground">
							{user.departmentName
								? "siempre dentro de su ámbito"
								: "asígnaselo desde “Editar perfil”"}
						</span>
					</p>
				</div>

				<div className="space-y-2">
					<Label>Departamentos adicionales</Label>
					{current.isPending ? (
						<Skeleton className="h-40 w-full" />
					) : selectable.length === 0 ? (
						<p className="rounded-md border border-dashed border-border/70 bg-muted/30 p-4 text-sm text-placeholder">
							No hay otros departamentos que asignar.
						</p>
					) : (
						<ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
							{selectable.map((department) => {
								const checked = selected.includes(department.id);
								return (
									<li key={department.id}>
										<button
											type="button"
											aria-pressed={checked}
											onClick={() => toggle(department.id)}
											className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/60"
										>
											<span
												className={`flex size-4 shrink-0 items-center justify-center rounded border ${
													checked
														? "border-primary bg-primary text-primary-foreground"
														: "border-input"
												}`}
											>
												{checked && <Check className="size-3" />}
											</span>
											<span className="flex-1 truncate">{department.name}</span>
											<span className="text-xs text-muted-foreground">
												{department.activeMemberCount}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
					<p className="text-xs text-muted-foreground">
						Cada cambio queda en la bitácora con el ámbito anterior y el nuevo.
					</p>
				</div>

				<InlineError error={current.error ?? update.error} />

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Cancelar
					</Button>
					<Button
						disabled={update.isPending || current.isPending}
						onClick={() =>
							update.mutate(
								{ id: user.id, departmentIds: selected },
								{ onSuccess: onClose },
							)
						}
					>
						{update.isPending && <Loader2 className="animate-spin" />}
						Guardar
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** RN-02.5: el motivo es obligatorio, y RN-02.4: desactivar no borra nada. */
export function DeactivateUserDialog({
	user,
	onClose,
}: DialogProps & { user: UserProfile }) {
	const [reason, setReason] = useState("");
	const deactivate = useDeactivateUser();

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		deactivate.mutate({ id: user.id, reason }, { onSuccess: onClose });
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Desactivar a {user.fullName}</DialogTitle>
						<DialogDescription>
							Dejará de poder entrar a Control de Asistencia y su sesión abierta
							morirá en cuanto haga cualquier cosa. Su historial se conserva
							completo. Es una baja <strong>de este sistema</strong>: su cuenta
							de Elineas sigue funcionando para los demás.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-2">
						<Label htmlFor="deactivate-reason">Motivo</Label>
						<Textarea
							id="deactivate-reason"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="Renuncia con fecha 30/09"
							maxLength={500}
							rows={3}
							required
						/>
					</div>

					<InlineError error={deactivate.error} />

					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button
							type="submit"
							variant="destructive"
							disabled={deactivate.isPending || reason.trim().length === 0}
						>
							{deactivate.isPending && <Loader2 className="animate-spin" />}
							Desactivar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Borrado real (RN-02.8), sólo superadmin. Exige que ya esté desactivado, y el
 * motivo es concreto: si su cuenta del IS sigue teniendo rol, el perfil volvería a
 * crearse vacío en el siguiente ingreso.
 */
export function DeleteUserDialog({
	user,
	onClose,
}: DialogProps & { user: UserProfile }) {
	const remove = useDeleteUser();
	const blocked = user.isActive;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Borrar el perfil de {user.fullName}</DialogTitle>
					<DialogDescription>
						{blocked
							? "Hay que desactivarlo primero. Si borras el perfil de alguien cuya cuenta sigue teniendo rol en el Identity Server, volverá a crearse vacío en su siguiente ingreso y perderás su departamento y sus datos de contacto."
							: "Se borra el perfil de negocio y todo lo que cuelga de él. No se toca su cuenta del Identity Server: eso se hace allí. La bitácora conserva el rastro."}
					</DialogDescription>
				</DialogHeader>

				<InlineError error={remove.error} />

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						{blocked ? "Entendido" : "Cancelar"}
					</Button>
					{!blocked && (
						<Button
							variant="destructive"
							disabled={remove.isPending}
							onClick={() =>
								remove.mutate({ id: user.id }, { onSuccess: onClose })
							}
						>
							{remove.isPending && <Loader2 className="animate-spin" />}
							Borrar
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
