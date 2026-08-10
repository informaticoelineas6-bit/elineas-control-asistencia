import type { AppRole } from "@elineas/validations";
import { ROLE_LABELS } from "#/modules/auth/navigation.ts";

/**
 * Marcador de una sección todavía sin construir.
 *
 * La spec 00 sólo cubre base de datos e identidad; el contenido de cada sección
 * llega con su propia spec. Hasta entonces la página existe para que el control
 * de acceso por rol sea comprobable de extremo a extremo.
 */
export function SectionPlaceholder({
	title,
	description,
	roles,
	spec,
}: {
	title: string;
	description: string;
	roles: readonly AppRole[];
	spec: string;
}) {
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">{title}</h1>
				<p className="mt-1 text-muted-foreground">{description}</p>
			</div>

			<div className="rounded-xl border border-dashed p-6">
				<p className="text-sm text-muted-foreground">
					Pendiente de implementar — se construye en la spec{" "}
					<span className="font-medium text-foreground">{spec}</span>.
				</p>
				<p className="mt-3 text-sm text-muted-foreground">
					Visible para:{" "}
					<span className="font-medium text-foreground">
						{roles.map((role) => ROLE_LABELS[role]).join(" · ")}
					</span>
				</p>
			</div>
		</div>
	);
}
