import type {
	AttendanceDayStatus,
	DashboardAlert,
	DayCounts,
	PersonalSummary,
	ScopeSummary,
} from "@elineas/validations";
import { DASHBOARD_ALERT_LABELS } from "@elineas/validations";
import { Link } from "@tanstack/react-router";
import { CircleAlert, DoorOpen, Plane } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { formatWeekdayDate } from "#/lib/dates.ts";

/**
 * Las tarjetas del dashboard (spec 15 §5.1).
 *
 * La spec describe **tres filas de una tabla de roles**, no tres pantallas, y
 * eso es lo que hay: las mismas piezas, y cada una aparece si el servidor mandó
 * su dato. Un empleado recibe `scope: null` y no ve nada de gestión; un gestor
 * global recibe `me: null` porque no marca (RN-03.4) y no ve una tarjeta vacía
 * de "tu estado de hoy".
 */

/**
 * Los seis estados de la §2 con su etiqueta. Se enumeran los seis aunque el
 * panel destaque tres: un estado nuevo en la spec 15 tiene que romper aquí.
 */
const STATUS_LABEL: Record<AttendanceDayStatus, string> = {
	PRESENTE: "Presentes",
	TARDE: "Tarde",
	AUSENTE: "Ausentes",
	DESCANSO: "Descanso",
	NO_LABORABLE: "No laborable",
	VACACIONES: "Vacaciones",
};

/** A dónde lleva cada alerta. La ruta es conocimiento del cliente, no del servidor. */
const ALERT_LINK: Record<DashboardAlert["kind"], string> = {
	absences_unreviewed: "/team",
	incidents_pending: "/team",
	vacations_pending: "/team",
	departments_paused: "/departments",
};

function Tile({
	label,
	value,
	tone = "",
	hint,
}: {
	label: string;
	value: ReactNode;
	tone?: string;
	hint?: string;
}) {
	return (
		<div className="rounded-xl border p-4">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>
				{value}
			</p>
			{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

/**
 * Lo propio de hoy. Es una **tarjeta de dato**, no un gráfico: un solo número
 * por concepto y ninguna comparación que dibujar.
 */
export function MyDayCard({
	summary,
	date,
}: {
	summary: PersonalSummary;
	date: string;
}) {
	const { day, vacationBalance } = summary;

	return (
		<section className="space-y-3">
			<h2 className="font-medium">Hoy · {formatWeekdayDate(date)}</h2>
			<div className="grid gap-3 sm:grid-cols-3">
				<Tile
					label="Tu estado"
					value={
						day ? (day.pending ? "En curso" : STATUS_LABEL[day.status]) : "—"
					}
					hint={
						day?.isLate
							? `${day.lateMinutes} min de tardanza`
							: day?.incomplete
								? "Sin salida registrada"
								: undefined
					}
				/>
				<Tile
					label="Trabajado"
					value={
						day?.workedMinutes !== null && day?.workedMinutes !== undefined
							? `${Math.floor(day.workedMinutes / 60)} h ${day.workedMinutes % 60} min`
							: "—"
					}
					hint={day?.incomplete ? "La jornada sigue abierta" : undefined}
				/>
				{vacationBalance && (
					<Tile
						label="Vacaciones disponibles"
						value={
							<span className="flex items-center gap-2">
								<Plane className="size-5 text-muted-foreground" />
								{vacationBalance.available}
							</span>
						}
						hint={`${vacationBalance.pending} pendientes de aprobar`}
					/>
				)}
			</div>
		</section>
	);
}

/** Alertas de gestión. Sólo llegan las que tienen algo: una alerta con cero no es una alerta. */
export function AlertsRow({ alerts }: { alerts: readonly DashboardAlert[] }) {
	if (alerts.length === 0) return null;

	return (
		<section className="flex flex-wrap gap-2">
			{alerts.map((alert) => (
				<Link
					key={alert.kind}
					to={ALERT_LINK[alert.kind]}
					className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm hover:bg-amber-500/15"
				>
					{/* El color de estado nunca va solo: icono y texto lo acompañan. */}
					<CircleAlert className="size-4 shrink-0 text-amber-600" />
					<span className="tabular-nums font-medium">{alert.count}</span>
					<span className="text-muted-foreground">
						{DASHBOARD_ALERT_LABELS[alert.kind]}
					</span>
				</Link>
			))}
		</section>
	);
}

const expectedOf = (counts: DayCounts) =>
	counts.PRESENTE + counts.TARDE + counts.AUSENTE;

/**
 * El resumen del ámbito y su desglose por departamento — la §5.2 y la §5.3 en el
 * dashboard, que son la misma con distinto alcance.
 *
 * Los totales de arriba y los de la tabla **salen del mismo conteo**: si
 * vinieran de dos consultas distintas, un día podrían no cuadrar y nadie sabría
 * a cuál creer.
 */
export function ScopeCards({ scope }: { scope: ScopeSummary }) {
	const expected = expectedOf(scope.counts);

	return (
		<section className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<Tile
					label="Presentes hoy"
					value={scope.counts.PRESENTE + scope.counts.TARDE}
					hint={`de ${expected} que se esperaban`}
				/>
				<Tile
					label="Tarde"
					value={scope.counts.TARDE}
					tone={
						scope.counts.TARDE > 0 ? "text-amber-700 dark:text-amber-400" : ""
					}
				/>
				<Tile
					label="Ausentes"
					value={scope.counts.AUSENTE}
					tone={
						scope.counts.AUSENTE > 0 ? "text-rose-700 dark:text-rose-400" : ""
					}
				/>
				<Tile
					label="Jornadas abiertas"
					value={
						<span className="flex items-center gap-2">
							<DoorOpen className="size-5 text-muted-foreground" />
							{scope.open}
						</span>
					}
					hint="Entraron y aún no han salido"
				/>
			</div>

			{scope.byDepartment.length > 1 && (
				<div className="rounded-xl border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="pl-4">Departamento</TableHead>
								<TableHead className="text-right">Esperados</TableHead>
								<TableHead className="text-right">Presentes</TableHead>
								<TableHead className="text-right">Tarde</TableHead>
								<TableHead className="pr-4 text-right">Ausentes</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{scope.byDepartment.map((row) => (
								<TableRow key={row.departmentId}>
									<TableCell className="pl-4 whitespace-normal">
										<span className="flex flex-wrap items-center gap-2">
											{row.departmentName}
											{/*
											 * Un departamento en pausa no admite marcajes
											 * (RN-01.4): su gente sale ausente sin que sea culpa de
											 * nadie, y decirlo aquí evita leerlo como un problema
											 * de asistencia.
											 */}
											{row.isPaused && (
												<Badge variant="warning">En pausa</Badge>
											)}
										</span>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{expectedOf(row.counts)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{row.counts.PRESENTE + row.counts.TARDE}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{row.counts.TARDE}
									</TableCell>
									<TableCell className="pr-4 text-right tabular-nums">
										{row.counts.AUSENTE}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</section>
	);
}
