import { useQuery } from "@tanstack/react-query";
import { Loader2, Power, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	maintenanceQueryOptions,
	useSetMaintenance,
} from "#/modules/admin/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * La palabra que hay que escribir para activar el mantenimiento.
 *
 * **RN-19.9 en su forma literal**: las acciones destructivas exigen escribir el
 * nombre del recurso, *"no un simple «¿Está seguro?»"*. Un diálogo de confirmar
 * se acepta sin leerlo; teclear una palabra obliga a mirar la pantalla.
 */
const CONFIRMATION = "MANTENIMIENTO";

/**
 * Modo de mantenimiento (spec 19 §2.5).
 *
 * La tarjeta dice **qué va a pasar exactamente** antes de que pase, porque es una
 * función con efecto global y la spec avisaba de que en el documento heredado no
 * estaba definida: se bloquean las escrituras de todo el mundo menos el
 * `superadmin`, las lecturas siguen, el login sigue y las sesiones no se cierran.
 */
export function MaintenanceCard() {
	const state = useQuery(maintenanceQueryOptions());
	const setMaintenance = useSetMaintenance();
	const [message, setMessage] = useState("");
	const [confirmation, setConfirmation] = useState("");

	const active = state.data?.active ?? false;
	const confirmed = confirmation.trim().toUpperCase() === CONFIRMATION;

	return (
		<section className="space-y-4 rounded-xl border p-5">
			<div>
				<h2 className="flex items-center gap-2 font-medium">
					<ShieldAlert className="size-4" />
					Modo de mantenimiento
				</h2>
				<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
					Con el mantenimiento activo, <strong>nadie puede guardar nada</strong>{" "}
					—marcar asistencia incluido— salvo un superadmin. Las consultas siguen
					funcionando y las sesiones no se cierran: quien entre verá el aviso y
					sus propios datos. Queda en la bitácora con tu nombre y el motivo.
				</p>
			</div>

			{state.isPending ? (
				<Skeleton className="h-24 w-full" />
			) : active ? (
				<div className="space-y-3">
					<p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
						<strong>Activo</strong> desde{" "}
						{state.data?.since
							? new Date(state.data.since).toLocaleString("es-CU")
							: "hace un momento"}
						{state.data?.byName && `, activado por ${state.data.byName}`}.
						<span className="mt-1 block text-muted-foreground">
							«{state.data?.message}»
						</span>
					</p>

					<Button
						type="button"
						disabled={setMaintenance.isPending}
						onClick={() => setMaintenance.mutate({ active: false })}
					>
						{setMaintenance.isPending ? (
							<Loader2 className="animate-spin" />
						) : (
							<Power />
						)}
						Reanudar la operación
					</Button>
				</div>
			) : (
				<div className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="maintenance-message">
							Motivo (lo lee toda la plantilla)
						</Label>
						<Textarea
							id="maintenance-message"
							maxLength={300}
							placeholder="Volvemos a las 14:00. Estamos migrando los datos de marzo."
							value={message}
							onChange={(event) => setMessage(event.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="maintenance-confirm">
							Escribe <code className="font-mono">{CONFIRMATION}</code> para
							confirmar
						</Label>
						<Input
							id="maintenance-confirm"
							className="w-64"
							autoComplete="off"
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
						/>
					</div>

					<Button
						type="button"
						variant="destructive"
						disabled={
							setMaintenance.isPending ||
							!confirmed ||
							message.trim().length === 0
						}
						onClick={() =>
							setMaintenance.mutate(
								{ active: true, message: message.trim() },
								{
									onSuccess: () => {
										setMessage("");
										setConfirmation("");
									},
								},
							)
						}
					>
						{setMaintenance.isPending && <Loader2 className="animate-spin" />}
						Parar el sistema
					</Button>
				</div>
			)}

			<InlineError error={state.error ?? setMaintenance.error} />
		</section>
	);
}
