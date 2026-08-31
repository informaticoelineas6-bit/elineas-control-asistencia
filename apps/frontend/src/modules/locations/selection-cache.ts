import {
	type MyWorkLocation,
	myWorkLocationSchema,
} from "@elineas/validations";

/**
 * Copia local de la sede seleccionada (spec 08 RN-08.8).
 *
 * **Es caché, no la verdad**: la selección vive en el perfil, en el servidor
 * (decisión 2 de la §9). Esto sólo evita que al abrir la aplicación en frío la
 * pantalla de marcaje aparezca sin sede durante media petición — que en planta, con
 * mala señal, no es media petición.
 *
 * Dos cosas que la hacen segura:
 *
 * - **Está indexada por usuario** (`identityUserId`), no por dispositivo: dos
 *   operarios que comparten un terminal no heredan la sede del otro.
 * - **Se valida al leer.** Una entrada corrupta —o de una versión anterior del
 *   esquema— se descarta en vez de pintar datos imposibles.
 *
 * Se limpia al cerrar sesión (RN-04.8), en `useLogout`.
 */

const KEY = "ca:work-location";

type Stored = Record<string, unknown>;

function readAll(): Stored {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Stored)
			: {};
	} catch {
		// Modo privado, cuota llena o JSON roto: sin caché se sigue funcionando.
		return {};
	}
}

export function readCachedWorkLocation(
	identityUserId: string,
): MyWorkLocation | undefined {
	const parsed = myWorkLocationSchema.safeParse(readAll()[identityUserId]);
	return parsed.success ? parsed.data : undefined;
}

export function writeCachedWorkLocation(
	identityUserId: string,
	value: MyWorkLocation,
): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			KEY,
			JSON.stringify({ ...readAll(), [identityUserId]: value }),
		);
	} catch {
		// Que no se pueda cachear no debe romper nada.
	}
}

/** RN-04.8: al cerrar sesión no queda estado local de nadie. */
export function clearCachedWorkLocations(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(KEY);
	} catch {
		// idem
	}
}
