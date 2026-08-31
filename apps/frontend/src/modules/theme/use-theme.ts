import { useCallback, useEffect, useState } from "react";
import {
	applyTheme,
	readStoredTheme,
	storeTheme,
	type Theme,
	watchSystemTheme,
} from "#/modules/theme/theme.ts";

/**
 * Tema actual y cómo cambiarlo.
 *
 * Arranca en `system` en el primer render —el servidor no puede saber otra cosa— y
 * se sincroniza con la cookie en cuanto hay documento. La clase del `<html>` ya la
 * puso el script del `<head>`, así que este efecto no provoca ningún salto visual:
 * sólo pone el estado de React de acuerdo con lo que ya se está viendo.
 */
export function useTheme() {
	const [theme, setThemeState] = useState<Theme>("system");

	useEffect(() => {
		setThemeState(readStoredTheme());
	}, []);

	// Con `system`, seguir al sistema operativo también cuando cambia en caliente.
	useEffect(() => {
		if (theme !== "system") return;
		return watchSystemTheme(() => applyTheme("system"));
	}, [theme]);

	const setTheme = useCallback((next: Theme) => {
		setThemeState(next);
		storeTheme(next);
		applyTheme(next);
	}, []);

	return { theme, setTheme };
}
