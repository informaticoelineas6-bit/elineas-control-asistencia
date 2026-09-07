import type { ReportRun } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, RotateCcw } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { formatShortDate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	reportRunsQueryOptions,
	useDownloadReport,
	useRetryReportRun,
} from "#/modules/reports/api.ts";

/**
 * El historial de corridas (spec 16 §3), con su seguimiento.
 *
 * **RN-16.6** — se refresca cada 15 s mientras haya corridas activas y para
 * cuando no las hay; el intervalo lo decide la propia consulta, mirando los
 * datos que ya tiene (ver `api.ts`).
 *
 * **RN-16.4** — reintentar crea una fila nueva, así que la lista crece en vez de
 * cambiar: es un registro de qué se pidió y cómo fue, y verlo así es la mitad
 * del valor de tenerlo.
 */

const STATUS_LABEL: Record<ReportRun["status"], string> = {
	queued: "En cola",
	running: "Generando",
	completed: "Lista",
	failed: "Falló",
};

const STATUS_VARIANT: Record<
	ReportRun["status"],
	"default" | "secondary" | "destructive" | "outline" | "warning"
> = {
	queued: "outline",
	running: "warning",
	completed: "default",
	failed: "destructive",
};

export function ReportRunsCard() {
	const runs = useQuery(reportRunsQueryOptions());
	const download = useDownloadReport();
	const retry = useRetryReportRun();

	return (
		<section className="space-y-3">
			<div>
				<h2 className="font-medium">Corridas</h2>
				<p className="mt-0.5 text-sm text-muted-foreground">
					Un reporte de toda la empresa no se genera de un tirón: se encola y
					avisa al terminar. Reintentar crea una corrida nueva y conserva la
					anterior.
				</p>
			</div>

			<InlineError error={runs.error ?? download.error ?? retry.error} />

			{runs.isPending ? (
				<Skeleton className="h-32 w-full" />
			) : (runs.data?.length ?? 0) === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					Todavía no has generado ningún reporte.
				</div>
			) : (
				<ul className="space-y-2">
					{runs.data?.map((run) => (
						<li
							key={run.id}
							className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5"
						>
							<div className="min-w-0">
								<p className="font-medium">
									{run.periodStart.slice(0, 7)}
									{" · "}
									<span className="font-normal text-muted-foreground">
										{run.departmentName ?? "Toda la empresa"}
									</span>
								</p>
								<p className="text-xs text-muted-foreground">
									Pedida el {formatShortDate(run.createdAt.slice(0, 10))}
									{run.rowCount !== null &&
										` · ${run.rowCount} ${run.rowCount === 1 ? "empleado" : "empleados"}`}
									{run.durationMs !== null &&
										` · ${(run.durationMs / 1000).toFixed(1)} s`}
									{run.retryCount > 0 && ` · reintento ${run.retryCount}`}
									{` · reglas v${run.ruleVersion}`}
								</p>
								{run.errorMessage && (
									<p className="mt-1 text-xs text-destructive">
										{run.errorMessage}
									</p>
								)}
							</div>

							<div className="flex items-center gap-2">
								<Badge variant={STATUS_VARIANT[run.status]}>
									{STATUS_LABEL[run.status]}
								</Badge>
								{run.status === "completed" && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={download.isPending}
										onClick={() => download.mutate({ id: run.id })}
									>
										{download.isPending ? (
											<Loader2 className="animate-spin" />
										) : (
											<Download />
										)}
										XLSX
									</Button>
								)}
								{run.status === "failed" && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={retry.isPending}
										onClick={() => retry.mutate({ id: run.id })}
									>
										<RotateCcw />
										Reintentar
									</Button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
