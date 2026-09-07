import { roleAtLeast } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { useState } from "react";
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
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	monthlyReportQueryOptions,
	reportKpisQueryOptions,
	useEnqueueReportRun,
} from "#/modules/reports/api.ts";
import { ReportMatrix } from "#/modules/reports/report-matrix.tsx";
import { ReportRunsCard } from "#/modules/reports/report-runs-card.tsx";

const PATH = "/reports" as const;

export const Route = createFileRoute("/_authed/reports")({
	component: () => (
		<RequireRole path={PATH}>
			<ReportsPage />
		</RequireRole>
	),
});

const ALL = "__all__";

/** El mes anterior: es el que se reporta, no el que está a medias. */
function lastMonth(): string {
	const now = new Date();
	const previous = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0),
	);
	return previous.toISOString().slice(0, 7);
}

/**
 * Reportería mensual (spec 16).
 *
 * **Una sola pantalla para el reporte departamental y el global**, por lo mismo
 * que los paneles de la spec 15: es el mismo reporte con distinto alcance, y el
 * alcance sale de la sesión. Un jefe ve su departamento y no puede pedir el
 * global; un gestor puede pedir los dos.
 *
 * La tabla de arriba se pinta desde `buildReportGrid`, **el mismo módulo del que
 * sale el XLSX** (§7): lo que se mira y lo que se descarga no pueden separarse.
 * Lo que se descarga, además, no se genera aquí — se encola (§3), porque un
 * reporte de toda la empresa no cabe en una petición.
 */
function ReportsPage() {
	const session = useQuery(sessionQueryOptions());
	const [period, setPeriod] = useState(lastMonth);
	const [departmentId, setDepartmentId] = useState<string>(ALL);

	const isManager = roleAtLeast(
		session.data?.effectiveRole ?? "employee",
		"global_manager",
	);

	const scoped = departmentId === ALL ? {} : { departmentId };
	const report = useQuery(monthlyReportQueryOptions({ period, ...scoped }));
	const enqueue = useEnqueueReportRun();

	// Sólo un gestor global puede pedir los KPIs; para un jefe la consulta
	// devolvería 403, así que ni se lanza.
	const kpis = useQuery({ ...reportKpisQueryOptions(30), enabled: isManager });

	const departments = useQuery({
		...departmentsQueryOptions({ includePaused: true }),
		enabled: (session.data?.managedDepartmentIds.length ?? 0) > 1,
	});

	const options = (departments.data ?? []).filter(
		(department) =>
			isManager || session.data?.managedDepartmentIds.includes(department.id),
	);

	// Sin departamento, la corrida es global — y eso sólo lo puede pedir un
	// gestor. Se refleja aquí para no ofrecer un botón que va a devolver 403.
	const canEnqueue = isManager || departmentId !== ALL;

	return (
		<div className="max-w-6xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Reportes</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Matriz de asistencia empleado × día del mes, con su resumen. Lo que
					ves aquí y lo que se descarga salen del mismo sitio.
				</p>
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="report-period" className="text-xs">
						Mes
					</Label>
					<Input
						id="report-period"
						type="month"
						value={period}
						onChange={(event) => setPeriod(event.target.value)}
					/>
				</div>

				{options.length > 1 && (
					<div className="space-y-1.5">
						<Label htmlFor="report-department" className="text-xs">
							Departamento
						</Label>
						<Select value={departmentId} onValueChange={setDepartmentId}>
							<SelectTrigger id="report-department" className="w-56">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL}>
									{isManager ? "Toda la empresa" : "Todo mi ámbito"}
								</SelectItem>
								{options.map((department) => (
									<SelectItem key={department.id} value={department.id}>
										{department.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<Button
					type="button"
					disabled={!canEnqueue || enqueue.isPending}
					title={
						canEnqueue
							? undefined
							: "El reporte de toda la empresa lo pide un gestor global"
					}
					onClick={() => enqueue.mutate({ period, ...scoped })}
				>
					{enqueue.isPending ? (
						<Loader2 className="animate-spin" />
					) : (
						<FileSpreadsheet />
					)}
					Generar XLSX
				</Button>
			</div>

			<InlineError error={enqueue.error} />
			<InlineError error={report.error} />

			{report.isPending ? (
				<Skeleton className="h-64 w-full" />
			) : (
				report.data && <ReportMatrix report={report.data} />
			)}

			<ReportRunsCard />

			{kpis.data && (
				<section className="space-y-2">
					<h2 className="font-medium">Salud de la reportería</h2>
					<p className="text-sm text-muted-foreground">
						Últimos {kpis.data.windowDays} días, sobre {kpis.data.total}{" "}
						{kpis.data.total === 1
							? "corrida terminada"
							: "corridas terminadas"}
						.
					</p>
					<dl className="grid gap-3 sm:grid-cols-3">
						<div className="rounded-xl border p-4">
							<dt className="text-xs text-muted-foreground">Disponibilidad</dt>
							<dd
								className={`mt-1 text-2xl font-semibold tabular-nums ${
									kpis.data.meetsSlo
										? "text-emerald-700 dark:text-emerald-400"
										: "text-rose-700 dark:text-rose-400"
								}`}
							>
								{kpis.data.availabilityPct}%
							</dd>
							<dd className="text-xs text-muted-foreground">
								SLO {kpis.data.slo.availabilityPct}%
							</dd>
						</div>
						<div className="rounded-xl border p-4">
							<dt className="text-xs text-muted-foreground">Tasa de error</dt>
							<dd className="mt-1 text-2xl font-semibold tabular-nums">
								{kpis.data.errorRatePct}%
							</dd>
							<dd className="text-xs text-muted-foreground">
								SLO {kpis.data.slo.errorRatePct}%
							</dd>
						</div>
						<div className="rounded-xl border p-4">
							<dt className="text-xs text-muted-foreground">Duración (p95)</dt>
							<dd className="mt-1 text-2xl font-semibold tabular-nums">
								{kpis.data.p95DurationMs === null
									? "—"
									: `${(kpis.data.p95DurationMs / 1000).toFixed(1)} s`}
							</dd>
						</div>
					</dl>
				</section>
			)}
		</div>
	);
}
