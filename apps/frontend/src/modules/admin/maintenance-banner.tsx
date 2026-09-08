import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { publicConfigQueryOptions } from "#/modules/config/api.ts";

/**
 * La banda de mantenimiento (spec 19 §2.5).
 *
 * El criterio de aceptación de la §5 dice que el modo mantenimiento **se refleja
 * en la UI de todos los usuarios conectados**, y "todos" incluye al empleado que
 * sólo tiene `GET /config/public`. Por eso las dos claves están en el
 * subconjunto público (spec 06 §5): el aviso viaja por donde ya viajaba la
 * configuración, sin un endpoint nuevo ni un canal aparte.
 *
 * No bloquea nada por su cuenta —eso lo hace el servidor con un 503— pero evita
 * la peor versión del problema: alguien intentando marcar tres veces sin
 * entender por qué no le deja.
 */
export function MaintenanceBanner() {
	const config = useQuery(publicConfigQueryOptions());
	if (!config.data?.maintenance_mode) return null;

	return (
		<div className="flex items-start gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
			<TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
			<p>
				<strong>Sistema en mantenimiento.</strong>{" "}
				{config.data.maintenance_message ??
					"No se pueden guardar cambios ahora mismo."}{" "}
				<span className="text-muted-foreground">
					Puedes consultar tus datos; guardar cambios volverá a funcionar cuando
					termine.
				</span>
			</p>
		</div>
	);
}
