import { CircleAlert } from "lucide-react";
import type { LocationPermission } from "#/modules/geolocation/location-layer.ts";

/**
 * RN-08.9 — Qué hacer cuando el permiso de ubicación está denegado.
 *
 * La regla dice, literalmente, que la interfaz debe explicar cómo reactivarlo **por
 * plataforma** y no sólo decir "error". El motivo es técnico y no de cortesía: un
 * permiso denegado **no se puede volver a pedir por código**, ni en el navegador ni
 * en Android. Sin estas instrucciones, la única salida de esa pantalla es llamar a
 * alguien.
 */
export function PermissionHelp({
	permission,
	className,
}: {
	permission: LocationPermission;
	className?: string;
}) {
	if (permission !== "denied" && permission !== "unsupported") return null;

	return (
		<div
			className={`flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm ${className ?? ""}`}
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
			{permission === "unsupported" ? (
				<div>
					<p className="font-medium">Este dispositivo no da la ubicación</p>
					<p className="mt-1 text-muted-foreground">
						El navegador no tiene geolocalización o está deshabilitada por
						política del equipo. Prueba con la aplicación en el teléfono, o pide
						que registren tu asistencia por incidencia.
					</p>
				</div>
			) : (
				<div className="space-y-2">
					<p className="font-medium">
						El permiso de ubicación está denegado y hay que reactivarlo a mano
					</p>
					<ul className="space-y-1 text-muted-foreground">
						<li>
							<strong>Android (Chrome):</strong> toca el candado o el icono de
							ajustes junto a la dirección → <em>Permisos</em> →{" "}
							<em>Ubicación</em> → <em>Permitir</em>. Y comprueba que la
							ubicación del teléfono esté encendida en los ajustes del sistema.
						</li>
						<li>
							<strong>Android (aplicación):</strong> Ajustes → Aplicaciones →
							Control de Asistencia → <em>Permisos</em> → <em>Ubicación</em> →{" "}
							<em>Permitir sólo mientras se usa la aplicación</em>.
						</li>
						<li>
							<strong>Escritorio (Chrome / Edge):</strong> el candado a la
							izquierda de la dirección → <em>Ubicación</em> → <em>Permitir</em>
							, y recarga la página.
						</li>
						<li>
							<strong>iPhone (Safari):</strong> Ajustes → Safari →{" "}
							<em>Ubicación</em> → <em>Preguntar</em> o <em>Permitir</em>.
						</li>
					</ul>
					<p className="text-muted-foreground">
						Después de cambiarlo, recarga esta pantalla y vuelve a intentarlo.
					</p>
				</div>
			)}
		</div>
	);
}
