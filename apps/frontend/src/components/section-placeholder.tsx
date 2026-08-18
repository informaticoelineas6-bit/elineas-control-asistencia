import type { AppRole } from "@elineas/validations";
import { HardHat } from "lucide-react";
import { ROLE_LABELS } from "#/modules/auth/navigation.ts";

/**
 * Marcador de una sección todavía sin construir.
 *
 * El contenido de cada sección llega con su propia spec. Hasta entonces la
 * página existe para que el control de acceso por rol sea comprobable de
 * extremo a extremo.
 *
 * **Tiene que verse provisional.** Con el color de texto normal, estas páginas
 * parecían secciones terminadas que resultaban estar vacías, y eso se reporta
 * como avería. El bloque va atenuado con `text-placeholder` —el mismo tono que
 * los campos vacíos— y sobre un fondo tenue: se lee sin esfuerzo, pero nadie lo
 * confunde con contenido real.
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

			<div className="flex items-start gap-4 rounded-xl border-2 border-dashed border-border/70 bg-muted/30 p-6">
				<HardHat className="mt-0.5 size-5 shrink-0 text-placeholder" />
				<div className="space-y-2 text-sm text-placeholder">
					<p>
						Pendiente de implementar — se construye en la spec{" "}
						<span className="font-medium text-muted-foreground">{spec}</span>.
					</p>
					<p>
						Visible para:{" "}
						<span className="font-medium text-muted-foreground">
							{roles.map((role) => ROLE_LABELS[role]).join(" · ")}
						</span>
					</p>
				</div>
			</div>
		</div>
	);
}
