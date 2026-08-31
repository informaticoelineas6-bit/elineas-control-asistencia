import type {
	AppConfigValues,
	DepartmentSummary,
	UpdateConfigInput,
} from "@elineas/validations";
import { checkoutModeIssue } from "@elineas/validations";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
import { Switch } from "#/components/ui/switch.tsx";
import { useUpdateConfig } from "#/modules/config/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Pestaña *General* de Configuración (spec 06 §6).
 *
 * Cada campo lleva su descripción de **qué afecta** porque un valor mal puesto
 * aquí cambia el cálculo de asistencia de toda la empresa, y desde esta pantalla
 * no se ve la consecuencia: se ve tres semanas después, en un reporte que no
 * cuadra.
 *
 * Se envía **sólo lo que cambió**: el `PATCH` es un mapa parcial (spec 06 §5), y
 * mandar el objeto entero llenaría la bitácora de claves que nadie tocó.
 */

/** Valor centinela de los selectores: "sin configurar" no puede ser cadena vacía. */
const UNSET = "__unset__";

function Section({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section className="space-y-4 rounded-xl border p-5">
			<div>
				<h2 className="font-medium">{title}</h2>
				<p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
			</div>
			<div className="grid gap-5 sm:grid-cols-2">{children}</div>
		</section>
	);
}

function Field({
	id,
	label,
	hint,
	wide,
	children,
}: {
	id: string;
	label: string;
	hint: string;
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={`space-y-2 ${wide ? "sm:col-span-2" : ""}`}>
			<Label htmlFor={id}>{label}</Label>
			{children}
			<p className="text-xs text-muted-foreground">{hint}</p>
		</div>
	);
}

/** Lista de departamentos con marca, sin dependencia nueva de UI. */
function DepartmentPicker({
	departments,
	selected,
	onToggle,
}: {
	departments: DepartmentSummary[];
	selected: string[];
	onToggle: (id: string) => void;
}) {
	if (departments.length === 0) {
		return (
			<p className="rounded-md border border-dashed border-border/70 bg-muted/30 p-3 text-sm text-placeholder">
				Todavía no hay departamentos.
			</p>
		);
	}

	return (
		<ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
			{departments.map((department) => {
				const checked = selected.includes(department.id);
				return (
					<li key={department.id}>
						<button
							type="button"
							aria-pressed={checked}
							onClick={() => onToggle(department.id)}
							className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm hover:bg-accent/60"
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
							<span className="truncate">{department.name}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** Los cambios de una clave numérica se aplican sólo si el campo tiene número. */
function numberOr<T>(raw: string, fallback: T): number | T {
	if (raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function ConfigForm({
	config,
	departments,
}: {
	config: AppConfigValues;
	departments: DepartmentSummary[];
}) {
	const update = useUpdateConfig();
	const [draft, setDraft] = useState<AppConfigValues>(config);
	const [saved, setSaved] = useState(false);

	const set = <K extends keyof AppConfigValues>(
		key: K,
		value: AppConfigValues[K],
	) => {
		setSaved(false);
		setDraft((current) => ({ ...current, [key]: value }));
	};

	// Las zonas horarias las enumera el propio motor: una lista escrita a mano
	// envejece, y el backend valida contra el mismo criterio.
	const timezones = useMemo(() => {
		try {
			return Intl.supportedValuesOf("timeZone");
		} catch {
			return [] as string[];
		}
	}, []);

	const patch = useMemo(() => {
		const changed: Record<string, unknown> = {};
		for (const key of Object.keys(draft) as (keyof AppConfigValues)[]) {
			if (JSON.stringify(draft[key]) !== JSON.stringify(config[key])) {
				changed[key] = draft[key];
			}
		}
		return changed as UpdateConfigInput;
	}, [draft, config]);

	const dirty = Object.keys(patch).length > 0;

	// Misma función que aplica el servidor (RN-06.5): el aviso sale al teclear, no
	// al recibir el 400.
	const issue = checkoutModeIssue(draft);

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!dirty || issue) return;
		update.mutate(patch, {
			onSuccess: (result) => {
				setDraft(result);
				setSaved(true);
			},
		});
	};

	return (
		<form onSubmit={onSubmit} className="space-y-5">
			<Section
				title="Tiempo y jornada"
				description="La base de todo cálculo de fechas y horas del sistema."
			>
				<Field
					id="config-timezone"
					label="Zona horaria"
					hint="Se usa para decidir a qué día pertenece un marcaje. Cada departamento puede tener la suya en su horario, y esa gana; ésta es el punto de partida."
				>
					<Input
						id="config-timezone"
						list="config-timezone-options"
						value={draft.global_timezone}
						onChange={(event) => set("global_timezone", event.target.value)}
						placeholder="America/Havana"
					/>
					<datalist id="config-timezone-options">
						{timezones.map((zone) => (
							<option key={zone} value={zone} />
						))}
					</datalist>
				</Field>

				<Field
					id="config-tolerance"
					label="Tolerancia de tardanza (minutos)"
					hint="Minutos de gracia antes de contar una entrada como tardanza. El cambio no reclasifica días ya cerrados."
				>
					<Input
						id="config-tolerance"
						type="number"
						min={0}
						max={240}
						value={draft.late_tolerance_minutes}
						onChange={(event) =>
							set(
								"late_tolerance_minutes",
								numberOr(event.target.value, 0) as number,
							)
						}
					/>
				</Field>

				<Field
					id="config-start"
					label="Hora de entrada por defecto"
					hint="Sólo rellena el formulario al crear un horario nuevo. Vacío = sin sugerencia."
				>
					<Input
						id="config-start"
						type="time"
						value={draft.default_work_start_time ?? ""}
						onChange={(event) =>
							set("default_work_start_time", event.target.value || null)
						}
					/>
				</Field>

				<Field
					id="config-end"
					label="Hora de salida por defecto"
					hint="Igual que la anterior: es una sugerencia al crear horarios, no una regla."
				>
					<Input
						id="config-end"
						type="time"
						value={draft.default_work_end_time ?? ""}
						onChange={(event) =>
							set("default_work_end_time", event.target.value || null)
						}
					/>
				</Field>
			</Section>

			<Section
				title="Modo de salida"
				description="Cómo se cierra la jornada de cada persona."
			>
				<Field
					id="config-checkout-mode"
					label="Modo"
					hint="Manual: la persona marca su salida. Por horario: se cierra sola a una hora fija. Por geocerca: se cierra al alejarse de la sede."
				>
					<Select
						value={draft.attendance_checkout_mode}
						onValueChange={(value) =>
							set(
								"attendance_checkout_mode",
								value as AppConfigValues["attendance_checkout_mode"],
							)
						}
					>
						<SelectTrigger id="config-checkout-mode" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="manual">Manual</SelectItem>
							<SelectItem value="schedule">Por horario</SelectItem>
							<SelectItem value="geofence_exit">
								Por salida de geocerca
							</SelectItem>
						</SelectContent>
					</Select>
				</Field>

				{draft.attendance_checkout_mode === "schedule" && (
					<Field
						id="config-auto-checkout"
						label="Hora de cierre automático"
						hint="Obligatoria con el modo «por horario»: a esta hora se cierran las jornadas que sigan abiertas."
					>
						<Input
							id="config-auto-checkout"
							type="time"
							value={draft.attendance_auto_checkout_time ?? ""}
							onChange={(event) =>
								set("attendance_auto_checkout_time", event.target.value || null)
							}
						/>
					</Field>
				)}

				{/*
				 * Spec 08 §4 (deuda del punto 77): este modo depende del seguimiento de
				 * ubicación en segundo plano, que hoy Android corta. La advertencia va
				 * junto al selector porque es aquí donde alguien lo elige, no tres
				 * pantallas después.
				 */}
				{draft.attendance_checkout_mode === "geofence_exit" && (
					<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm sm:col-span-2">
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
						<span>
							Este modo <strong>no es fiable todavía</strong>: necesita
							seguimiento de ubicación en segundo plano y Android mata el
							proceso con la pantalla apagada, así que hay jornadas que se
							quedarían sin salida. Mientras no exista la aplicación nativa, usa
							el modo manual o el cierre por horario.
						</span>
					</p>
				)}

				{draft.attendance_checkout_mode === "geofence_exit" && (
					<Field
						id="config-geofence-minutes"
						label="Minutos fuera de la geocerca"
						hint="Obligatorio con el modo «por geocerca»: cuánto tiempo seguido fuera de la sede cierra la jornada."
					>
						<Input
							id="config-geofence-minutes"
							type="number"
							min={1}
							max={720}
							value={draft.attendance_geofence_exit_minutes ?? ""}
							onChange={(event) =>
								set(
									"attendance_geofence_exit_minutes",
									numberOr(event.target.value, null),
								)
							}
						/>
					</Field>
				)}
			</Section>

			<Section
				title="Descansos"
				description="Separación mínima entre los descansos de una misma persona."
			>
				<Field
					id="config-rest-separation"
					label="Días mínimos de separación"
					hint="0 desactiva la regla por completo. Con un valor mayor, dos descansos de la misma persona no pueden quedar más juntos que eso."
				>
					<Input
						id="config-rest-separation"
						type="number"
						min={0}
						max={31}
						value={draft.rest_days_min_separation}
						onChange={(event) =>
							set(
								"rest_days_min_separation",
								numberOr(event.target.value, 0) as number,
							)
						}
					/>
				</Field>

				<Field
					id="config-rest-departments"
					label="Departamentos afectados"
					hint="Acota la regla anterior. Marcar ninguno mientras la separación es 0 no tiene efecto."
				>
					<DepartmentPicker
						departments={departments}
						selected={draft.rest_days_min_separation_departments}
						onToggle={(id) =>
							set(
								"rest_days_min_separation_departments",
								draft.rest_days_min_separation_departments.includes(id)
									? draft.rest_days_min_separation_departments.filter(
											(each) => each !== id,
										)
									: [...draft.rest_days_min_separation_departments, id],
							)
						}
					/>
				</Field>
			</Section>

			<Section
				title="Vacaciones"
				description="Cómo se acumula el saldo de vacaciones."
			>
				<Field
					id="config-vacation-rate"
					label="Días acumulados por día trabajado"
					wide
					hint="Se multiplica por los días trabajados para obtener el saldo. En 0 nadie acumula vacaciones, que es lo que ocurre mientras esté sin configurar. No es el divisor de nómina: son dos cosas distintas."
				>
					<Input
						id="config-vacation-rate"
						type="number"
						min={0}
						max={1}
						step="0.001"
						value={draft.vacation_days_per_worked_day}
						onChange={(event) =>
							set(
								"vacation_days_per_worked_day",
								numberOr(event.target.value, 0) as number,
							)
						}
					/>
				</Field>
			</Section>

			<Section
				title="Reportería"
				description="Alcance de los reportes globales y objetivos de servicio."
			>
				<div className="flex items-start gap-3 sm:col-span-2">
					<Switch
						id="config-include-heads"
						checked={draft.include_heads_in_global_reports}
						onCheckedChange={(checked) =>
							set("include_heads_in_global_reports", checked)
						}
					/>
					<div>
						<Label htmlFor="config-include-heads" className="font-normal">
							Incluir a los jefes de departamento en el reporte global
						</Label>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Apagado, el reporte global cuenta sólo a los empleados.
						</p>
					</div>
				</div>

				<Field
					id="config-slo-error"
					label="SLO de tasa de error (%)"
					hint="Por encima de este porcentaje de generaciones fallidas, la reportería se considera degradada."
				>
					<Input
						id="config-slo-error"
						type="number"
						min={0}
						max={100}
						step="0.1"
						value={draft.report_slo_error_rate_pct}
						onChange={(event) =>
							set(
								"report_slo_error_rate_pct",
								numberOr(event.target.value, 0) as number,
							)
						}
					/>
				</Field>

				<Field
					id="config-slo-availability"
					label="SLO de disponibilidad (%)"
					hint="Objetivo de disponibilidad del generador de reportes."
				>
					<Input
						id="config-slo-availability"
						type="number"
						min={0}
						max={100}
						step="0.1"
						value={draft.report_slo_availability_pct}
						onChange={(event) =>
							set(
								"report_slo_availability_pct",
								numberOr(event.target.value, 0) as number,
							)
						}
					/>
				</Field>

				<Field
					id="config-spreadsheet"
					label="Hoja de cálculo de Google"
					wide
					hint="Identificador de la hoja a la que se exportan los reportes. Vacío = la exportación está sin configurar."
				>
					<Input
						id="config-spreadsheet"
						value={draft.google_sheets_report_spreadsheet_id ?? ""}
						onChange={(event) =>
							set(
								"google_sheets_report_spreadsheet_id",
								event.target.value.trim() || null,
							)
						}
						placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
					/>
				</Field>
			</Section>

			<Section
				title="Ámbito"
				description="Reglas que mueven a la gente de departamento por su rol."
			>
				<Field
					id="config-gm-department"
					label="Departamento de los gestores globales"
					wide
					hint="Al resolver la sesión, todo perfil con rol de gestor global se mueve a este departamento. Sin configurar, la regla queda desactivada. Mientras esté elegido, ese departamento no se puede borrar."
				>
					<Select
						value={draft.global_manager_department_id ?? UNSET}
						onValueChange={(value) =>
							set(
								"global_manager_department_id",
								value === UNSET ? null : value,
							)
						}
					>
						<SelectTrigger id="config-gm-department" className="w-full">
							<SelectValue placeholder="Sin configurar" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={UNSET}>Sin configurar</SelectItem>
							{departments.map((department) => (
								<SelectItem key={department.id} value={department.id}>
									{department.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			</Section>

			{issue && (
				<p
					role="alert"
					className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
				>
					<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
					{issue}
				</p>
			)}

			<InlineError error={update.error} />

			<div className="flex items-center gap-3">
				<Button type="submit" disabled={!dirty || !!issue || update.isPending}>
					{update.isPending && <Loader2 className="animate-spin" />}
					Guardar cambios
				</Button>
				{dirty && (
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setDraft(config);
							setSaved(false);
						}}
					>
						Descartar
					</Button>
				)}
				<p className="text-sm text-muted-foreground">
					{dirty
						? `${Object.keys(patch).length} ${Object.keys(patch).length === 1 ? "cambio sin guardar" : "cambios sin guardar"}`
						: saved
							? "Guardado."
							: "Sin cambios."}
				</p>
			</div>
		</form>
	);
}
