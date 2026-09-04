import { describeRestDays, restDaysIssue } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { BedDouble, CircleAlert, Info, Loader2, Users } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { formatLongDate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	myRestScheduleQueryOptions,
	useUpdateMyRestSchedule,
} from "#/modules/rest/api.ts";
import { WeekdayPicker } from "#/modules/rest/weekday-picker.tsx";

/**
 * "Mis descansos" (spec 10 §7), en el perfil propio — donde la spec 05 §3 los
 * coloca.
 *
 * El aviso de la separación mínima se calcula **con la misma función que aplica el
 * servidor** (`restDaysIssue` de `@elineas/validations`) y con los límites que
 * viajan en la respuesta: lo que se lee aquí es exactamente lo que se va a
 * rechazar, no una descripción escrita a mano que se queda vieja cuando alguien
 * cambia la configuración global.
 *
 * En modo por grupos el selector se pinta **igual, en lectura**: saber qué días
 * descansas es útil aunque no puedas cambiarlos, y esconderlo dejaría al operario
 * sin forma de verlo (RN-10.2).
 */
export function MyRestCard() {
	const mine = useQuery(myRestScheduleQueryOptions());
	const save = useUpdateMyRestSchedule();

	const [draft, setDraft] = useState<number[] | null>(null);
	const [effectiveFrom, setEffectiveFrom] = useState("");

	if (mine.isPending) {
		return (
			<section className="rounded-xl border p-4">
				<Skeleton className="h-48 w-full" />
			</section>
		);
	}

	if (mine.error) {
		return (
			<section className="rounded-xl border p-4">
				<InlineError error={mine.error} />
			</section>
		);
	}

	if (!mine.data) return null;

	const { resolved, limits, canEdit, canBackdate, today, department } =
		mine.data;
	const days = draft ?? resolved.daysOfWeek;
	const from = effectiveFrom || today;

	const dirty =
		draft !== null &&
		(draft.join() !== resolved.daysOfWeek.join() || from !== today);
	const issue = restDaysIssue(days, limits);

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!canEdit || issue) return;

		save.mutate(
			{ daysOfWeek: days, effectiveFrom: from },
			{
				onSuccess: () => {
					setDraft(null);
					setEffectiveFrom("");
				},
			},
		);
	};

	return (
		<section className="space-y-4 rounded-xl border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
						<BedDouble className="size-4" />
						Mis descansos
					</h2>
					<p className="mt-1 text-sm">
						{resolved.daysOfWeek.length === 0
							? "No tienes días de descanso configurados."
							: `Descansas ${describeRestDays(resolved.daysOfWeek)}.`}
					</p>
				</div>
				{resolved.source === "group" && resolved.group && (
					<Badge variant="secondary">
						<Users />
						{resolved.group.name}
					</Badge>
				)}
			</div>

			{/*
			 * RN-10.3: sin descansos configurados se exigen todos los días laborables.
			 * Es el estado que dispara el recordatorio de RN-10.10, y quien lo tiene
			 * necesita saber qué le supone antes de que se lo cuente un reporte.
			 */}
			{resolved.daysOfWeek.length === 0 && (
				<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
					{resolved.restGroupsEnabled
						? "Tu departamento organiza los descansos por grupos y todavía no estás en ninguno, así que se te exige asistencia todos los días laborables. Pídele a tu jefe que te asigne un grupo."
						: "Mientras no elijas tus días, se te exige asistencia todos los días laborables del calendario."}
				</p>
			)}

			{resolved.restGroupsEnabled && (
				<p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
					<Info className="mt-0.5 size-4 shrink-0" />
					{department
						? `${department.name} gestiona los descansos por grupos, así que los tuyos los decide tu grupo y no se eligen aquí.`
						: "Tu departamento gestiona los descansos por grupos."}
				</p>
			)}

			<form onSubmit={onSubmit} className="space-y-4">
				<div className="space-y-2">
					<Label>Días de la semana</Label>
					<WeekdayPicker
						value={days}
						onChange={setDraft}
						disabled={!canEdit || save.isPending}
					/>
					{limits.minSeparationDays > 0 && (
						<p className="text-xs text-muted-foreground">
							Se exigen {limits.minSeparationDays}{" "}
							{limits.minSeparationDays === 1 ? "día" : "días"} de separación
							entre descansos.
						</p>
					)}
					{(limits.minPerWeek > 0 || limits.maxPerWeek < 7) && (
						<p className="text-xs text-muted-foreground">
							Entre {limits.minPerWeek} y {limits.maxPerWeek} días de descanso
							por semana.
						</p>
					)}
				</div>

				{canEdit && (
					<>
						<div className="max-w-56 space-y-2">
							<Label htmlFor="rest-effective-from">Desde cuándo</Label>
							<Input
								id="rest-effective-from"
								type="date"
								value={from}
								min={canBackdate ? undefined : today}
								onChange={(event) => {
									setEffectiveFrom(event.target.value);
									setDraft(draft ?? resolved.daysOfWeek);
								}}
							/>
							{/*
							 * RN-10.1: el cambio no reescribe el pasado, y por eso la fecha es
							 * un campo y no un detalle escondido. Sin esta frase, alguien que
							 * cambia sus descansos a mitad de mes esperaría que el reporte del
							 * mes entero se recalculara.
							 */}
							<p className="text-xs text-muted-foreground">
								El cambio rige a partir de esa fecha. Los días anteriores se
								quedan como estaban, para que los reportes ya cerrados no
								cambien.
							</p>
						</div>

						{issue && dirty && (
							<p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
								{issue}
							</p>
						)}

						<InlineError error={save.error} />

						<div className="flex flex-wrap items-center gap-3">
							<Button
								type="submit"
								disabled={!dirty || !!issue || save.isPending}
							>
								{save.isPending && <Loader2 className="animate-spin" />}
								Guardar descansos
							</Button>
							{dirty && (
								<Button
									type="button"
									variant="outline"
									onClick={() => {
										setDraft(null);
										setEffectiveFrom("");
									}}
								>
									Descartar
								</Button>
							)}
							{!dirty && save.isSuccess && (
								<span className="text-sm text-muted-foreground">Guardado.</span>
							)}
						</div>
					</>
				)}
			</form>

			{mine.data.schedules.length > 1 && (
				<div className="rounded-lg border border-dashed border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
					<p className="font-medium text-foreground">Vigencias</p>
					<ul className="mt-1 space-y-0.5">
						{mine.data.schedules.map((schedule) => (
							<li key={schedule.id}>
								Desde el {formatLongDate(schedule.effectiveFrom)}:{" "}
								{describeRestDays(schedule.daysOfWeek)}
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
