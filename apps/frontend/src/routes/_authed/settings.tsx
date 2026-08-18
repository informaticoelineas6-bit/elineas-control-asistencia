import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { configQueryOptions } from "#/modules/config/api.ts";
import { ConfigForm } from "#/modules/config/config-form.tsx";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

const PATH = "/settings" as const;

export const Route = createFileRoute("/_authed/settings")({
	component: () => (
		<RequireRole path={PATH}>
			<ConfigPage />
		</RequireRole>
	),
});

/**
 * Configuración global (spec 06 §6).
 *
 * Los horarios, las sedes y la geocerca tendrán aquí sus propias pestañas cuando
 * lleguen sus specs (07 y 08). De momento sólo está *General*, que es el catálogo
 * de la spec 06 §3.
 */
function ConfigPage() {
	const config = useQuery(configQueryOptions());
	const departments = useQuery(
		departmentsQueryOptions({ includePaused: true }),
	);

	return (
		<div className="max-w-4xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Configuración</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Los parámetros que cambian el comportamiento del sistema sin tocar
					código.
				</p>
			</div>

			{/*
			 * El aviso no es decorativo: desde esta pantalla no se ve la consecuencia
			 * de un valor mal puesto. Se ve semanas después, en un reporte que no
			 * cuadra y que ya nadie relaciona con este formulario.
			 */}
			<div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
				<TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
				<div className="text-sm">
					<p className="font-medium">Esto afecta a toda la empresa</p>
					<p className="mt-1 text-muted-foreground">
						Un valor mal puesto aquí cambia el cálculo de asistencia de todo el
						mundo. Los cambios <strong>no son retroactivos</strong>: no
						reclasifican días ya cerrados. Cada uno queda en la bitácora con el
						valor anterior y el nuevo.
					</p>
				</div>
			</div>

			<InlineError error={config.error} />

			{config.isPending || departments.isPending ? (
				<div className="space-y-4">
					<Skeleton className="h-56 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			) : (
				config.data && (
					<ConfigForm
						config={config.data}
						departments={departments.data ?? []}
					/>
				)
			)}
		</div>
	);
}
