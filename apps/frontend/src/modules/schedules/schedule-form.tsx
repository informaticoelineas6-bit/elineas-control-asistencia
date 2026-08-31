import type {
	AppConfigValues,
	DepartmentSchedule,
	DepartmentSummary,
} from "@elineas/validations";
import {
	describeMarkWindow,
	describeMidnightCrossing,
	scheduleIssue,
} from "@elineas/validations";
import {
	CircleAlert,
	Clock,
	Info,
	Loader2,
	Moon,
	Trash2,
	Users,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import { Switch } from "#/components/ui/switch.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	useDeleteSchedule,
	useUpdateSchedule,
} from "#/modules/schedules/api.ts";

/**
 * Tarjeta de horario de un departamento (spec 07 §6): las cuatro horas, la zona,
 * los dos interruptores y un previsualizador de la ventana resultante.
 *
 * El previsualizador no es adorno. Cuatro horas y dos interruptores no dicen a qué
 * hora puede marcar alguien —y menos si la jornada cruza la medianoche—, así que la
 * frase se calcula con **la misma función que aplica el servidor**
 * (`describeMarkWindow`, en `@elineas/validations`): lo que se lee aquí es
 * exactamente lo que se va a exigir.
 *
 * El aviso de "se notificará a N miembros" también es de la spec: guardar esto le
 * llega a cada persona del departamento (RN-07.10).
 */

type Draft = {
	checkinStartTime: string;
	checkinEndTime: string;
	checkoutStartTime: string;
	checkoutEndTime: string;
	timezone: string;
	allowEarlyCheckin: boolean;
	allowLateCheckout: boolean;
};

function draftFrom(
	schedule: DepartmentSchedule | null,
	config: AppConfigValues,
): Draft {
	if (schedule) {
		return {
			checkinStartTime: schedule.checkinStartTime,
			checkinEndTime: schedule.checkinEndTime,
			checkoutStartTime: schedule.checkoutStartTime,
			checkoutEndTime: schedule.checkoutEndTime,
			timezone: schedule.timezone,
			allowEarlyCheckin: schedule.allowEarlyCheckin,
			allowLateCheckout: schedule.allowLateCheckout,
		};
	}

	// Horario nuevo: se rellenan sólo los bordes que la configuración global sabe
	// (spec 06 §3.1). El ancho de cada ventana no lo sabe nadie más que quien la
	// configura, así que se queda en blanco en vez de inventar media hora.
	return {
		checkinStartTime: config.default_work_start_time ?? "",
		checkinEndTime: "",
		checkoutStartTime: "",
		checkoutEndTime: config.default_work_end_time ?? "",
		timezone: config.global_timezone,
		allowEarlyCheckin: false,
		allowLateCheckout: false,
	};
}

function TimeField({
	id,
	label,
	hint,
	value,
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type="time"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<p className="text-xs text-muted-foreground">{hint}</p>
		</div>
	);
}

export function ScheduleForm({
	department,
	schedule,
	config,
}: {
	department: DepartmentSummary;
	schedule: DepartmentSchedule | null;
	config: AppConfigValues;
}) {
	const update = useUpdateSchedule();
	const remove = useDeleteSchedule();

	const [draft, setDraft] = useState<Draft>(() => draftFrom(schedule, config));
	const [saved, setSaved] = useState(false);
	const [confirmingRemoval, setConfirmingRemoval] = useState(false);

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
		setSaved(false);
		setDraft((current) => ({ ...current, [key]: value }));
	};

	const timezones = useMemo(() => {
		try {
			return Intl.supportedValuesOf("timeZone");
		} catch {
			return [] as string[];
		}
	}, []);

	const baseline = draftFrom(schedule, config);
	const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

	// Misma función que el servidor (RN-06.5 aplicado a la spec 07): el aviso sale
	// al teclear, no al recibir el 400.
	const issue = scheduleIssue(draft);
	const preview = issue
		? null
		: {
				checkin: describeMarkWindow(draft, "IN"),
				checkout: describeMarkWindow(draft, "OUT"),
				midnight: describeMidnightCrossing(draft),
			};

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (issue || !dirty) return;

		update.mutate(
			{
				departmentId: department.id,
				...draft,
				// Vacío significa "la global, o la que ya tenía", no una zona inválida:
				// el contrato la declara opcional justo para eso.
				timezone: draft.timezone.trim() || undefined,
			},
			{ onSuccess: () => setSaved(true) },
		);
	};

	return (
		<form onSubmit={onSubmit} className="space-y-5">
			<section className="space-y-4 rounded-xl border p-5">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h3 className="flex items-center gap-2 font-medium">
							<Clock className="size-4" />
							Ventana de marcaje
						</h3>
						<p className="mt-0.5 text-sm text-muted-foreground">
							Desde y hasta cuándo se acepta una entrada, y desde y hasta cuándo
							una salida. Fuera de esa ventana el marcaje se rechaza; la
							corrección pasa por una incidencia.
						</p>
					</div>
					{!schedule && (
						<span className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
							Sin configurar
						</span>
					)}
				</div>

				<div className="grid gap-5 sm:grid-cols-2">
					<TimeField
						id="checkin-start"
						label="Entrada: desde"
						hint="Antes de esta hora no se acepta la entrada, salvo con entrada anticipada."
						value={draft.checkinStartTime}
						onChange={(value) => set("checkinStartTime", value)}
					/>
					<TimeField
						id="checkin-end"
						label="Entrada: hasta"
						hint="Pasada esta hora la entrada se rechaza. La tardanza se cuenta desde la hora de apertura."
						value={draft.checkinEndTime}
						onChange={(value) => set("checkinEndTime", value)}
					/>
					<TimeField
						id="checkout-start"
						label="Salida: desde"
						hint="Antes de esta hora no se puede marcar la salida."
						value={draft.checkoutStartTime}
						onChange={(value) => set("checkoutStartTime", value)}
					/>
					<TimeField
						id="checkout-end"
						label="Salida: hasta"
						hint="Si es anterior a la hora de entrada, la jornada cruza la medianoche y la salida cuenta para el día anterior."
						value={draft.checkoutEndTime}
						onChange={(value) => set("checkoutEndTime", value)}
					/>
				</div>

				<div className="space-y-2">
					<Label htmlFor="schedule-timezone">Zona horaria</Label>
					<Input
						id="schedule-timezone"
						list="schedule-timezone-options"
						value={draft.timezone}
						onChange={(event) => set("timezone", event.target.value)}
						placeholder={config.global_timezone}
					/>
					<datalist id="schedule-timezone-options">
						{timezones.map((zone) => (
							<option key={zone} value={zone} />
						))}
					</datalist>
					<p className="text-xs text-muted-foreground">
						Todas las horas de arriba se leen en esta zona, no en la del
						servidor ni en la del teléfono de quien marca. Por defecto, la
						global ({config.global_timezone}).
					</p>
				</div>

				<div className="space-y-3 rounded-lg border border-dashed border-border/70 p-4">
					<div className="flex items-start gap-3">
						<Switch
							id="allow-early"
							checked={draft.allowEarlyCheckin}
							onCheckedChange={(checked) => set("allowEarlyCheckin", checked)}
						/>
						<div>
							<Label htmlFor="allow-early" className="font-normal">
								Permitir entrada anticipada
							</Label>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Acepta marcar la entrada antes de que abra la ventana, desde la
								medianoche de ese día. No cuenta como tardanza.
							</p>
						</div>
					</div>
					<div className="flex items-start gap-3">
						<Switch
							id="allow-late"
							checked={draft.allowLateCheckout}
							onCheckedChange={(checked) => set("allowLateCheckout", checked)}
						/>
						<div>
							<Label htmlFor="allow-late" className="font-normal">
								Permitir salida tardía
							</Label>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Acepta marcar la salida después de que cierre la ventana, hasta
								el final del día en que termina la jornada.
							</p>
						</div>
					</div>
				</div>

				{issue ? (
					<p
						role="alert"
						className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
					>
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
						{issue}
					</p>
				) : (
					preview && (
						<div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
							<p className="flex items-start gap-2">
								<Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<span>
									{preview.checkin} {preview.checkout}
								</span>
							</p>
							{preview.midnight && (
								<p className="flex items-start gap-2 text-muted-foreground">
									<Moon className="mt-0.5 size-4 shrink-0" />
									{preview.midnight}
								</p>
							)}
						</div>
					)
				)}
			</section>

			{/* RN-07.10: el aviso a los miembros es automático, y quien guarda tiene
			    que saber a cuánta gente le va a llegar. */}
			{dirty && department.activeMemberCount > 0 && (
				<p className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-sm">
					<Users className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-400" />
					Al guardar se notificará a{" "}
					{department.activeMemberCount === 1
						? "1 miembro"
						: `los ${department.activeMemberCount} miembros`}{" "}
					de {department.name}.
				</p>
			)}

			<InlineError error={update.error} />
			<InlineError error={remove.error} />

			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={!dirty || !!issue || update.isPending}>
					{update.isPending && <Loader2 className="animate-spin" />}
					{schedule ? "Guardar horario" : "Crear horario"}
				</Button>
				{dirty && (
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setDraft(baseline);
							setSaved(false);
						}}
					>
						Descartar
					</Button>
				)}
				{schedule && !dirty && (
					<Button
						type="button"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10"
						onClick={() => setConfirmingRemoval(true)}
					>
						<Trash2 />
						Quitar horario
					</Button>
				)}
				<p className="text-sm text-muted-foreground">
					{dirty
						? "Cambios sin guardar."
						: saved
							? "Guardado."
							: schedule
								? "Sin cambios."
								: "Este departamento todavía no tiene horario: nadie puede marcar."}
				</p>
			</div>

			<Dialog
				open={confirmingRemoval}
				onOpenChange={(open) => !open && setConfirmingRemoval(false)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Quitar el horario de {department.name}</DialogTitle>
						<DialogDescription>
							Sin horario, ningún miembro del departamento podrá registrar
							asistencia, y se les notificará. El calendario laboral se
							conserva.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmingRemoval(false)}
						>
							Cancelar
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={remove.isPending}
							onClick={() =>
								remove.mutate(
									{ departmentId: department.id },
									{
										onSuccess: () => {
											setConfirmingRemoval(false);
											setDraft(draftFrom(null, config));
											setSaved(false);
										},
									},
								)
							}
						>
							{remove.isPending && <Loader2 className="animate-spin" />}
							Quitar horario
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</form>
	);
}
