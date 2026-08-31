import { useCallback, useEffect, useRef, useState } from "react";
import {
	getCurrentPosition,
	LocationError,
	type LocationPermission,
	type PositionReading,
	permissionState,
	watchPosition,
} from "#/modules/geolocation/location-layer.ts";

/**
 * La capa de ubicación (spec 08 §4) como hook de React.
 *
 * Deliberadamente **no** lee al montar: encender el GPS es una acción del usuario,
 * y una pantalla que pide ubicación sola en cuanto se abre enseña el diálogo del
 * permiso en el peor momento posible — cuando nadie sabe todavía para qué se lo
 * piden, que es cuando se deniega. `read()` y `startWatching()` se llaman desde un
 * botón.
 */
export function usePosition(options: { watch?: boolean } = {}) {
	const [reading, setReading] = useState<PositionReading | null>(null);
	const [error, setError] = useState<LocationError | null>(null);
	const [permission, setPermission] = useState<LocationPermission>("unknown");
	const [isReading, setIsReading] = useState(false);
	const [isWatching, setIsWatching] = useState(false);
	const stopRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		let cancelled = false;
		void permissionState().then((state) => {
			if (!cancelled) setPermission(state);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// El seguimiento se corta al desmontar, siempre: dejarlo vivo mantiene el GPS
	// encendido con la pantalla apagada.
	useEffect(
		() => () => {
			stopRef.current?.();
			stopRef.current = null;
		},
		[],
	);

	const read = useCallback(async () => {
		setIsReading(true);
		setError(null);
		try {
			const next = await getCurrentPosition();
			setReading(next);
			setPermission("granted");
			return next;
		} catch (caught) {
			const failure =
				caught instanceof LocationError
					? caught
					: new LocationError("unavailable", "No se pudo leer la ubicación.");
			setError(failure);
			if (failure.kind === "denied") setPermission("denied");
			return null;
		} finally {
			setIsReading(false);
		}
	}, []);

	const stopWatching = useCallback(() => {
		stopRef.current?.();
		stopRef.current = null;
		setIsWatching(false);
	}, []);

	const startWatching = useCallback(() => {
		if (stopRef.current) return;
		setError(null);
		setIsWatching(true);
		stopRef.current = watchPosition(
			(next) => {
				setReading(next);
				setPermission("granted");
			},
			(failure) => {
				setError(failure);
				if (failure.kind === "denied") setPermission("denied");
				stopWatching();
			},
		);
	}, [stopWatching]);

	useEffect(() => {
		if (!options.watch) return;
		startWatching();
		return stopWatching;
	}, [options.watch, startWatching, stopWatching]);

	return {
		reading,
		error,
		permission,
		isReading,
		isWatching,
		read,
		startWatching,
		stopWatching,
	};
}
