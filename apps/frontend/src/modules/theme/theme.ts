/**
 * Tema claro / oscuro.
 *
 * Las variables de color de los dos temas ya viven en `styles.css` (`:root` y
 * `.dark`), y la variante de Tailwind está declarada como `&:is(.dark *)`. Así que
 * todo lo que hace este módulo es poner o quitar la clase `dark` en el `<html>`.
 *
 * **Por defecto se sigue al sistema operativo.** Sólo cuando alguien elige
 * explícitamente claro u oscuro se guarda su preferencia, en una cookie de un año
 * —igual que hace shadcn con el estado de colapso del aside— para que la elección
 * sobreviva a recargas y a otras pestañas.
 *
 * El parpadeo al cargar se evita en `__root.tsx` con el script de `THEME_SCRIPT`,
 * que corre antes del primer pintado. El servidor no puede saber el tema —la
 * preferencia del sistema sólo la conoce el navegador—, así que la clase se
 * resuelve en el cliente pero **antes** de que se vea nada.
 */

export const THEME_COOKIE = "ca_theme";
export const THEME_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type Theme = "light" | "dark" | "system";

export const THEME_LABELS: Record<Theme, string> = {
	light: "Claro",
	dark: "Oscuro",
	system: "Sistema",
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function prefersDark(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia(DARK_QUERY).matches;
}

export function readStoredTheme(): Theme {
	if (typeof document === "undefined") return "system";

	const match = document.cookie.match(
		new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`),
	);
	const value = match?.[1] ? decodeURIComponent(match[1]) : "";
	return value === "light" || value === "dark" ? value : "system";
}

export function storeTheme(theme: Theme) {
	if (typeof document === "undefined") return;

	// `CookieStore` no está en Safari ni Firefox, y esta cookie la lee además el
	// script anti-parpadeo del `<head>`, que corre antes de que exista cualquier API
	// asíncrona útil.
	// biome-ignore lint/suspicious/noDocumentCookie: ver el comentario de arriba
	document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_MAX_AGE_SECONDS}; samesite=lax`;
}

/** Aplica el tema al documento. `system` delega en la preferencia del navegador. */
export function applyTheme(theme: Theme) {
	if (typeof document === "undefined") return;

	const dark = theme === "dark" || (theme === "system" && prefersDark());
	document.documentElement.classList.toggle("dark", dark);
}

export function watchSystemTheme(onChange: () => void): () => void {
	if (typeof window === "undefined") return () => {};

	const query = window.matchMedia(DARK_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/**
 * Script que corre en el `<head>`, antes del primer pintado, para que la página
 * no aparezca en claro y salte a oscuro un instante después.
 *
 * Va como cadena a propósito: tiene que ejecutarse de forma síncrona en el
 * documento inicial, antes de que cargue cualquier módulo de la aplicación.
 */
export const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);var t=m?decodeURIComponent(m[1]):"system";var d=t==="dark"||(t!=="light"&&window.matchMedia("${DARK_QUERY}").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
