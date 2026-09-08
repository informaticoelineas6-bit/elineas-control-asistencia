import type { AppRole } from "@elineas/validations";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useIsMobile } from "#/hooks/use-mobile.ts";
import {
	parseShellOverride,
	resolveShell,
	type Shell,
	type ShellOverride,
} from "#/modules/shells/resolve.ts";

/**
 * El shell que toca (spec 05 §2), con lo que la regla pura no puede saber: el
 * tamaño del viewport y el `?ui=` de la URL.
 *
 * **RN-05.1 — es reactivo.** `useIsMobile` escucha el `matchMedia`, así que rotar
 * el teléfono o estrechar la ventana cambia el shell sin recargar. En el primer
 * render del servidor no hay viewport que medir y sale `admin`; el efecto corrige
 * en el cliente antes de que nadie lo note.
 *
 * **RN-05.2 — el override se recuerda en la pestaña.** `?ui=employee` en la URL
 * fija el shell y **se guarda en `sessionStorage`**, porque si no se perdería en
 * el primer enlace que se pulse y no serviría para lo que existe: reproducir lo
 * que ve un operario en planta desde un escritorio. `?ui=auto` lo borra.
 *
 * Que viva en la pestaña y no en una cookie es parte de la decisión: un override
 * de depuración no debe seguir a nadie a la sesión siguiente ni contaminar otra
 * ventana.
 */

const STORAGE_KEY = "ca_ui_shell";

function readStored(): ShellOverride | null {
	if (typeof window === "undefined") return null;
	try {
		return parseShellOverride(window.sessionStorage.getItem(STORAGE_KEY));
	} catch {
		// Navegador con el almacenamiento bloqueado: el override deja de recordarse
		// y la aplicación sigue igual. No es una función que nadie necesite.
		return null;
	}
}

function store(value: ShellOverride | null) {
	if (typeof window === "undefined") return;
	try {
		if (value === null || value === "auto") {
			window.sessionStorage.removeItem(STORAGE_KEY);
		} else {
			window.sessionStorage.setItem(STORAGE_KEY, value);
		}
	} catch {
		// idem
	}
}

export function useShell(role: AppRole | null | undefined): Shell {
	const isMobile = useIsMobile();
	const searchStr = useRouterState({ select: (s) => s.location.searchStr });
	const [override, setOverride] = useState<ShellOverride | null>(null);

	useEffect(() => {
		// Se lee de la URL con `URLSearchParams` y no con el `search` tipado del
		// router a propósito: `?ui=` es un parámetro de depuración que puede
		// aparecer en cualquier ruta, y declararlo en el esquema de todas ellas
		// sería propagar una herramienta por medio contrato.
		const fromUrl = parseShellOverride(
			new URLSearchParams(searchStr).get("ui"),
		);

		if (fromUrl) {
			store(fromUrl);
			setOverride(fromUrl === "auto" ? null : fromUrl);
			return;
		}
		setOverride(readStored());
	}, [searchStr]);

	return resolveShell({ role, isMobile, override });
}
