import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { ROLE_LABELS } from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import {
	dashboardAlertsQueryOptions,
	dashboardSummaryQueryOptions,
	dashboardTrendQueryOptions,
} from "#/modules/dashboard/api.ts";
import { AttendanceTrend } from "#/modules/dashboard/attendance-trend.tsx";
import {
	AlertsRow,
	MyDayCard,
	ScopeCards,
} from "#/modules/dashboard/scope-cards.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";

export const Route = createFileRoute("/_authed/dashboard")({
	component: DashboardPage,
});

/**
 * Panel de inicio (spec 15 §5.1).
 *
 * **Una pantalla para los tres roles**, no tres. La spec describe una tabla de
 * "qué ve cada rol" y las filas son acumulativas: el jefe ve lo del empleado más
 * lo de su equipo, y el gestor global lo mismo con más alcance. Aquí eso se
 * traduce en que cada sección se pinta **si el servidor mandó su dato**: es él
 * quien decide, con el rol y el ámbito de la sesión, y el cliente no repite esa
 * decisión (RN-03.3).
 *
 * Antes esta pantalla enseñaba el volcado de la sesión —identidad, roles,
 * ámbito— porque no había specs de producto que mostrar. Ya las hay, y ese
 * volcado vive donde le corresponde: *Mi perfil*.
 */
function DashboardPage() {
	const session = useQuery(sessionQueryOptions());
	const summary = useQuery(dashboardSummaryQueryOptions());

	const manages = !!summary.data?.scope;
	// La tendencia y las alertas sólo existen para quien gestiona: pedirlas sin
	// ámbito devolvería 403, así que se piden cuando el resumen ya dijo que hay
	// algo que gestionar.
	const trend = useQuery({
		...dashboardTrendQueryOptions(7),
		enabled: manages,
	});
	const alerts = useQuery({
		...dashboardAlertsQueryOptions(),
		enabled: manages,
	});

	const profile = session.data?.profile;

	return (
		<div className="max-w-5xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">
					Hola, {profile?.fullName || session.data?.user.email}
				</h1>
				{session.data && (
					<p className="mt-1 text-sm text-muted-foreground">
						Entraste como{" "}
						<span className="font-medium text-foreground">
							{ROLE_LABELS[session.data.effectiveRole]}
						</span>
						.
					</p>
				)}
			</div>

			{profile && !profile.isComplete && (
				<div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
					<CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
					<div className="text-sm">
						<p className="font-medium">
							Tu cuenta está pendiente de configurar
						</p>
						<p className="mt-1 text-muted-foreground">
							Todavía no tienes departamento asignado, así que no puedes
							registrar asistencia. Un gestor tiene que completarlo.
						</p>
					</div>
				</div>
			)}

			<InlineError error={summary.error} />

			{summary.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : (
				summary.data && (
					<>
						{alerts.data && <AlertsRow alerts={alerts.data.alerts} />}

						{summary.data.me && (
							<MyDayCard summary={summary.data.me} date={summary.data.date} />
						)}

						{summary.data.scope && <ScopeCards scope={summary.data.scope} />}

						{trend.data && <AttendanceTrend trend={trend.data} />}
					</>
				)
			)}
		</div>
	);
}
