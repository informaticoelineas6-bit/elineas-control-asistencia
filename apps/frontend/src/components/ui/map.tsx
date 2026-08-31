import type * as Leaflet from "leaflet";
import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils.ts";
import "leaflet/dist/leaflet.css";

/**
 * Mapa de la aplicación, sobre Leaflet con mosaicos de OpenStreetMap.
 *
 * Es el único mapa del proyecto: lo usan el alta de sedes (spec 08 §5) y el
 * diagnóstico de GPS (§6). Decisión 3 de la §9: Leaflet en vez del mini-mapa hecho a
 * mano del legacy. Pesa unos 42 KB comprimidos y trae resuelto el paneo, el zoom, el
 * marcador arrastrable y **el círculo en metros** — que es justo la parte que decide
 * si alguien puede marcar y la que no conviene reinventar a mano.
 *
 * Tres cosas que este componente hace por obligación, no por gusto:
 *
 * - **Se carga en el cliente y sólo ahí.** Leaflet toca `window` al importarse, así
 *   que el módulo entra con `import()` dentro de un efecto: durante el SSR aquí no
 *   se ejecuta nada.
 * - **Degrada si no hay mosaicos.** Sin red, o con el dominio de OSM bloqueado, el
 *   mapa se queda gris y eso no puede parecer una avería: se avisa y las
 *   coordenadas siguen editándose a mano (§5).
 * - **No usa los iconos de Leaflet.** Sus marcadores por defecto son imágenes con
 *   rutas relativas que se rompen al empaquetar; aquí el marcador es un `divIcon`
 *   con nuestro propio HTML, sin un solo fichero de imagen.
 */

export type MapPoint = { latitude: number; longitude: number };

export type MapCircle = {
	center: MapPoint;
	radiusMeters: number;
	/** `primary` la geocerca; `muted` el error de la lectura del GPS. */
	tone?: "primary" | "muted" | "danger";
};

export type MapMarker = {
	position: MapPoint;
	label?: string;
	tone?: "primary" | "danger";
	draggable?: boolean;
	onDragEnd?: (point: MapPoint) => void;
};

const CIRCLE_STYLE: Record<
	NonNullable<MapCircle["tone"]>,
	{ className: string; color: string }
> = {
	primary: {
		className: "stroke-violet-500 fill-violet-500/15",
		color: "#8b5cf6",
	},
	muted: { className: "stroke-sky-500 fill-sky-500/10", color: "#0ea5e9" },
	danger: { className: "stroke-rose-500 fill-rose-500/10", color: "#f43f5e" },
};

const MARKER_HTML: Record<NonNullable<MapMarker["tone"]>, string> = {
	primary:
		'<span class="block size-3.5 rounded-full border-2 border-white bg-violet-600 shadow-md"></span>',
	danger:
		'<span class="block size-3.5 rounded-full border-2 border-white bg-rose-600 shadow-md"></span>',
};

export function MapView({
	center,
	zoom = 16,
	circles = [],
	markers = [],
	onSelect,
	fitPoints,
	height = 320,
	interactive = true,
	className,
	label = "Mapa",
}: {
	center: MapPoint;
	zoom?: number;
	circles?: readonly MapCircle[];
	markers?: readonly MapMarker[];
	/** Clic en el mapa. Sin esto, el mapa es de sólo lectura. */
	onSelect?: (point: MapPoint) => void;
	/** Encaja la vista para que estos puntos quepan todos. */
	fitPoints?: readonly MapPoint[];
	height?: number | string;
	interactive?: boolean;
	className?: string;
	label?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<Leaflet.Map | null>(null);
	const leafletRef = useRef<typeof Leaflet | null>(null);
	const overlaysRef = useRef<Leaflet.LayerGroup | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const selectRef = useRef(onSelect);
	selectRef.current = onSelect;

	const [ready, setReady] = useState(false);
	const [tilesFailed, setTilesFailed] = useState(false);
	const [failed, setFailed] = useState(false);

	// Creación del mapa. Se hace una sola vez: los cambios de centro, círculos y
	// marcadores se aplican después sin volver a montarlo.
	// biome-ignore lint/correctness/useExhaustiveDependencies: el mapa se crea una sola vez a propósito; centro, zoom, círculos y marcadores se aplican en los efectos siguientes. Volver a montarlo en cada cambio perdería el paneo del usuario y recargaría los mosaicos.
	useEffect(() => {
		let cancelled = false;

		(async () => {
			try {
				const leaflet = await import("leaflet");
				if (cancelled || !containerRef.current) return;

				const map = leaflet.map(containerRef.current, {
					center: [center.latitude, center.longitude],
					zoom,
					// La rueda hace scroll de la página, no zoom del mapa: un mapa que
					// secuestra la rueda deja atrapado a quien sólo quería bajar en el
					// formulario. Para acercar están los botones + y −.
					scrollWheelZoom: false,
					dragging: interactive,
					doubleClickZoom: interactive,
					zoomControl: interactive,
					attributionControl: true,
				});

				const tiles = leaflet.tileLayer(
					"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
					{
						maxZoom: 19,
						// Atribución obligatoria por la política de uso de los mosaicos de OSM.
						attribution: "&copy; OpenStreetMap",
					},
				);
				tiles.on("tileerror", () => setTilesFailed(true));
				tiles.addTo(map);

				map.on("click", (event: Leaflet.LeafletMouseEvent) => {
					selectRef.current?.({
						latitude: event.latlng.lat,
						longitude: event.latlng.lng,
					});
				});

				leafletRef.current = leaflet;
				mapRef.current = map;
				overlaysRef.current = leaflet.layerGroup().addTo(map);
				setReady(true);

				// Un mapa dentro de un diálogo se monta con tamaño cero y dibuja los
				// mosaicos donde no toca. El observador lo recalcula cuando el contenedor
				// llega a su tamaño real, y también al girar el teléfono. Se guarda en una
				// referencia porque quien lo tiene que desconectar es la limpieza del
				// efecto, no esta función asíncrona.
				observerRef.current = new ResizeObserver(() => map.invalidateSize());
				observerRef.current.observe(containerRef.current);
			} catch {
				if (!cancelled) setFailed(true);
			}
		})();

		return () => {
			cancelled = true;
			observerRef.current?.disconnect();
			observerRef.current = null;
			mapRef.current?.remove();
			mapRef.current = null;
			overlaysRef.current = null;
			setReady(false);
		};
	}, []);

	// Centro y encuadre.
	useEffect(() => {
		const map = mapRef.current;
		const leaflet = leafletRef.current;
		if (!ready || !map || !leaflet) return;

		if (fitPoints && fitPoints.length > 1) {
			map.fitBounds(
				leaflet.latLngBounds(
					fitPoints.map((point) => [point.latitude, point.longitude]),
				),
				{ padding: [32, 32], maxZoom: 17 },
			);
			return;
		}
		map.setView([center.latitude, center.longitude], map.getZoom());
	}, [ready, center.latitude, center.longitude, fitPoints]);

	// Círculos y marcadores: se redibuja el grupo entero. Son dos o tres formas, no
	// una capa de miles de puntos, y así no hay que reconciliar nada a mano.
	useEffect(() => {
		const leaflet = leafletRef.current;
		const overlays = overlaysRef.current;
		if (!ready || !leaflet || !overlays) return;

		overlays.clearLayers();

		for (const circle of circles) {
			const style = CIRCLE_STYLE[circle.tone ?? "primary"];
			leaflet
				.circle([circle.center.latitude, circle.center.longitude], {
					radius: circle.radiusMeters,
					className: style.className,
					color: style.color,
					weight: 2,
					fillOpacity: 0.15,
				})
				.addTo(overlays);
		}

		for (const marker of markers) {
			const created = leaflet
				.marker([marker.position.latitude, marker.position.longitude], {
					draggable: marker.draggable ?? false,
					keyboard: true,
					title: marker.label,
					alt: marker.label ?? "Punto en el mapa",
					icon: leaflet.divIcon({
						className: "!bg-transparent !border-0",
						html: MARKER_HTML[marker.tone ?? "primary"],
						iconSize: [14, 14],
						iconAnchor: [7, 7],
					}),
				})
				.addTo(overlays);

			if (marker.draggable && marker.onDragEnd) {
				created.on("dragend", () => {
					const position = created.getLatLng();
					marker.onDragEnd?.({
						latitude: position.lat,
						longitude: position.lng,
					});
				});
			}
		}
	}, [ready, circles, markers]);

	return (
		<div className={cn("space-y-1", className)}>
			{/*
			 * `section` y no `div`: con un nombre accesible se anuncia como región, que
			 * es lo que un lector de pantalla puede saltar. Un `div` con `aria-label` no
			 * significa nada.
			 */}
			<section
				ref={containerRef}
				aria-label={label}
				className="relative z-0 w-full overflow-hidden rounded-lg border bg-muted"
				style={{ height }}
			>
				{!ready && !failed && (
					<div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
						Cargando el mapa…
					</div>
				)}
				{failed && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
						<MapPin className="size-5" />
						No se pudo cargar el mapa. Puedes escribir las coordenadas a mano.
					</div>
				)}
			</section>

			{tilesFailed && !failed && (
				<p className="text-xs text-amber-700 dark:text-amber-400">
					No se pudieron cargar los mosaicos del mapa (sin conexión o dominio
					bloqueado). El círculo y las coordenadas siguen siendo válidos: puedes
					ajustarlos a mano.
				</p>
			)}
			{onSelect && !failed && (
				<p className="text-xs text-muted-foreground">
					Pulsa en el mapa o arrastra el punto para mover el centro. Para
					acercar, usa los botones + y − del mapa.
				</p>
			)}
		</div>
	);
}
