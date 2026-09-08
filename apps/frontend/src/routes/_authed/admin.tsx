import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { adminStatsQueryOptions } from "#/modules/admin/api.ts";
import { ImportCard } from "#/modules/admin/import-card.tsx";
import { MaintenanceCard } from "#/modules/admin/maintenance-card.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";

const PATH = "/admin" as const;

export const Route = createFileRoute("/_authed/admin")({
	component: () => (
		<RequireRole path={PATH}>
			<AdminPage />
		</RequireRole>
	),
});

/**
 * Panel de superadmin (spec 19). Sólo `superadmin` (RN-19.7).
 *
 * ⚠️ **No hay consola SQL**, y es la decisión más importante de esa spec
 * (§6.1, cerrada por su alternativa (a)): una consola con privilegios totales
 * sobre producción accesible desde un navegador no se puede proteger con una
 * lista negra, y la necesidad legítima ya la cubre `db:studio` con credenciales
 * que viven fuera de la aplicación.
 *
 * **La bitácora tampoco está aquí**: vive en `/logs` desde la spec 18, con el
 * mismo rol mínimo. Se enlaza en vez de duplicarse — dos pantallas de lo mismo es
 * cómo empiezan a divergir.
 *
 * Y una nota que la propia spec pide tener presente (RN-19.10): **si algo de esto
 * se usa a menudo, falta una funcionalidad en el producto.** Lo que hay aquí es
 * lo que se hace una vez o casi nunca.
 */
function AdminPage() {
	const stats = useQuery(adminStatsQueryOptions());

	return (
		<div className="max-w-5xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Superadmin</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Herramientas de operación y soporte. Todo lo de aquí es potente, queda
					en la bitácora y no debería hacer falta a menudo.
				</p>
			</div>

			<InlineError error={stats.error} />

			{stats.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : (
				stats.data && (
					<section className="space-y-3">
						<h2 className="font-medium">Estado del sistema</h2>

						<dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<Figure
								label="Perfiles activos"
								value={stats.data.profiles.active}
								hint={`${stats.data.profiles.total} en total · ${stats.data.profiles.inactive} de baja`}
							/>
							<Figure
								label="Altas a medias"
								value={stats.data.profiles.incomplete}
								hint="sin departamento"
								alert={stats.data.profiles.incomplete > 0}
							/>
							<Figure
								label="Departamentos"
								value={stats.data.departments.total}
								hint={`${stats.data.departments.paused} pausados · ${stats.data.departments.withoutSchedule} sin horario`}
								alert={stats.data.departments.withoutSchedule > 0}
							/>
							<Figure
								label="Marcajes hoy"
								value={stats.data.attendance.marksToday}
								hint={`${stats.data.attendance.marksThisMonth} este mes · ${stats.data.attendance.blockedToday} rechazados hoy`}
							/>
							<Figure
								label="Incidencias por revisar"
								value={stats.data.pending.incidents}
								alert={stats.data.pending.incidents > 0}
							/>
							<Figure
								label="Vacaciones por aprobar"
								value={stats.data.pending.vacations}
								alert={stats.data.pending.vacations > 0}
							/>
							<Figure
								label="Ausencias sin clasificar"
								value={stats.data.pending.absences}
								hint="últimos 30 días"
								alert={stats.data.pending.absences > 0}
							/>
							<Figure
								label="Reportes fallidos"
								value={stats.data.reports.failed}
								hint={`${stats.data.reports.queued} en cola · ${stats.data.reports.running} corriendo`}
								alert={stats.data.reports.failed > 0}
							/>
						</dl>

						<p className="text-xs text-muted-foreground">
							{stats.data.attendance.importedTotal} marcajes importados ·{" "}
							{stats.data.profiles.withAdditionalScope} perfiles con ámbito
							adicional · {stats.data.audit.lastDay} acciones auditadas en las
							últimas 24 h.{" "}
							<span className="text-placeholder">
								No hay desglose por rol: los roles viven en el Identity Server y
								este sistema no los conoce hasta que la persona entra.
							</span>
						</p>

						<Button variant="outline" size="sm" asChild>
							<Link to="/logs">
								<ScrollText />
								Ver la bitácora
							</Link>
						</Button>
					</section>
				)
			)}

			<MaintenanceCard />
			<ImportCard />
		</div>
	);
}

function Figure({
	label,
	value,
	hint,
	alert = false,
}: {
	label: string;
	value: number;
	hint?: string;
	alert?: boolean;
}) {
	return (
		<div className="rounded-xl border p-4">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd
				className={`mt-1 text-2xl font-semibold tabular-nums ${
					alert && value > 0 ? "text-amber-700 dark:text-amber-400" : ""
				}`}
			>
				{value}
			</dd>
			{hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
		</div>
	);
}
