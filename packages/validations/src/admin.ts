import { z } from "zod";
import { markTypeSchema } from "./attendance.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Panel de superadmin (spec 19).
 *
 * ⚠️ **Todo lo de esta spec es potente y peligroso**, y el vocabulario lo
 * refleja: no hay ni un esquema que acepte SQL libre, y los dos que escriben
 * —mantenimiento e importación— exigen motivo y confirmación explícita
 * (RN-19.9).
 */

// ── §2.1 Estadísticas globales ───────────────────────────────────────────────

/**
 * El estado global del sistema.
 *
 * ⚠️ **Falta lo primero que la §2.1 pide: "usuarios por rol".** No es un olvido y
 * no se puede añadir: **este sistema no sabe qué rol tiene nadie hasta que esa
 * persona se autentica.** Los roles viven en el Identity Server y sólo se
 * conocen por *session token* ([00](./00-migracion-datos-e-identidad.md)
 * RN-00.43); en nuestra base sólo queda el ámbito **adicional** de un jefe. Un
 * conteo por rol sería inventado, o exigiría preguntarle al IS por cada perfil
 * —la decisión 3 de la spec 11 §9, que sigue abierta—.
 *
 * Es la quinta aparición de esa misma limitación, y aquí no hay salida parcial
 * como en las otras: se cambia el recuento por **usuarios por estado**, que sí
 * es nuestro, y se deja dicho por qué.
 */
export const adminStatsSchema = z.object({
	profiles: z.object({
		total: z.number().int().nonnegative(),
		active: z.number().int().nonnegative(),
		inactive: z.number().int().nonnegative(),
		/** Alta a medias: sin departamento (RN-02.3). */
		incomplete: z.number().int().nonnegative(),
		/** Con ámbito departamental adicional (spec 03 §3): lo único de rol que sabemos. */
		withAdditionalScope: z.number().int().nonnegative(),
	}),
	departments: z.object({
		total: z.number().int().nonnegative(),
		paused: z.number().int().nonnegative(),
		withoutSchedule: z.number().int().nonnegative(),
	}),
	attendance: z.object({
		marksToday: z.number().int().nonnegative(),
		marksThisMonth: z.number().int().nonnegative(),
		blockedToday: z.number().int().nonnegative(),
		importedTotal: z.number().int().nonnegative(),
	}),
	pending: z.object({
		incidents: z.number().int().nonnegative(),
		vacations: z.number().int().nonnegative(),
		/** Ausencias sin clasificar de los últimos 30 días (spec 13 §5). */
		absences: z.number().int().nonnegative(),
	}),
	reports: z.object({
		queued: z.number().int().nonnegative(),
		running: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
	}),
	audit: z.object({
		/** Entradas de las últimas 24 h: el pulso del sistema (spec 18). */
		lastDay: z.number().int().nonnegative(),
	}),
	generatedAt: z.iso.datetime(),
});

// ── §2.5 Modo de mantenimiento ───────────────────────────────────────────────

/**
 * Estado del modo de mantenimiento (§2.5, decisión 2 cerrada).
 *
 * `since` y `by` **no se guardan en configuración**: salen de la última entrada
 * de bitácora de `maintenance.enabled` (spec 18). La spec pide "quién y cuándo lo
 * activó" y eso ya está escrito en el sitio donde vive ese tipo de dato; una
 * copia en `app_config` sería un segundo registro que se puede desincronizar del
 * primero.
 */
export const maintenanceStateSchema = z.object({
	active: z.boolean(),
	/** El aviso que ve todo el mundo. Nulo cuando no hay mantenimiento. */
	message: z.string().nullable(),
	since: z.iso.datetime().nullable(),
	byName: z.string().nullable(),
});

export const setMaintenanceInputSchema = z.object({
	active: z.boolean(),
	/**
	 * Obligatorio al activar y por eso se valida abajo: un mantenimiento sin
	 * motivo deja a todo el mundo mirando un aviso que no explica nada.
	 */
	message: z.string().trim().max(300).optional(),
});

// ── §2.4 Importación de histórico ────────────────────────────────────────────

/**
 * Una fila del archivo, ya interpretada.
 *
 * El formato es deliberadamente pobre —correo, fecha, hora, tipo— porque lo que
 * se importa es un histórico que viene de otro sistema y no una jornada
 * completa: sin sede, sin coordenadas y sin tolerancia. RN-19.5 exige que se
 * distingan de un marcaje real, y así es imposible confundirlos.
 */
export const attendanceImportRowSchema = z.object({
	email: z.string().trim().toLowerCase(),
	date: isoDateSchema,
	/** `HH:mm` o `HH:mm:ss`. */
	time: z
		.string()
		.trim()
		.regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Hora no válida"),
	markType: markTypeSchema,
});

export const attendanceImportIssueSchema = z.object({
	/** Fila del archivo, 1-indexada y contando la cabecera. */
	row: z.number().int().positive(),
	message: z.string(),
});

/**
 * RN-19.2 — El informe previo. **Se devuelve antes de escribir nada.**
 *
 * La regla lo dice con las palabras que importan: *"nunca importación parcial
 * silenciosa"*. Así que validar y escribir son dos endpoints, y el informe es lo
 * que se enseña entre uno y otro.
 */
export const attendanceImportReportSchema = z.object({
	/** Filas de datos del archivo, sin contar la cabecera. */
	rows: z.number().int().nonnegative(),
	valid: z.number().int().nonnegative(),
	issues: z.array(attendanceImportIssueSchema),
	/** Cuántas ya existen en la base: reimportar no duplica (RN-19.3). */
	alreadyPresent: z.number().int().nonnegative(),
	people: z.number().int().nonnegative(),
	from: isoDateSchema.nullable(),
	to: isoDateSchema.nullable(),
});

export const attendanceImportResultSchema = attendanceImportReportSchema.extend(
	{
		inserted: z.number().int().nonnegative(),
		/** Hechos diarios recalculados tras escribir (RN-19.4). */
		factsRefreshed: z.number().int().nonnegative(),
	},
);

/**
 * Las cuatro columnas del archivo, en este orden. Se comprueban por **posición**
 * y no por nombre: un archivo exportado de otro sistema trae la cabecera que
 * trae, y exigir un texto exacto convierte un histórico entero en cero filas
 * válidas por una tilde.
 */
export const IMPORT_COLUMNS = ["Correo", "Fecha", "Hora", "Tipo"] as const;

/** Lo que el vocabulario de la interfaz puede traer en la columna «Tipo». */
const MARK_TYPE_ALIASES: Record<string, "IN" | "OUT"> = {
	in: "IN",
	out: "OUT",
	entrada: "IN",
	salida: "OUT",
	e: "IN",
	s: "OUT",
};

/**
 * El día 0 de Excel. **No es 1900-01-01**: Excel arrastra desde Lotus 1-2-3 el
 * año 1900 como bisiesto, que no lo fue, así que el epoch que cuadra con sus
 * números es el 30 de diciembre de 1899.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const EXCEL_DAY_MS = 86_400_000;

/**
 * Interpreta una celda de fecha, venga como texto o como **número de serie de
 * Excel**.
 *
 * Lo segundo no es un caso raro: es lo **normal**. Una hoja de cálculo guarda las
 * fechas como días desde su epoch, así que un archivo exportado de Excel trae
 * `45383` donde una persona ve `2024-03-14`. Sin esta conversión, un histórico
 * real daría cero filas válidas y el mensaje de error diría "fecha no válida"
 * sobre algo que en la pantalla se ve perfectamente.
 */
export function toImportDate(cell: unknown): string | null {
	if (typeof cell === "number" && Number.isFinite(cell)) {
		// Un serial de fecha razonable: entre 1970 y 2100 aproximadamente.
		if (cell < 25_000 || cell > 75_000) return null;
		return new Date(EXCEL_EPOCH_MS + Math.floor(cell) * EXCEL_DAY_MS)
			.toISOString()
			.slice(0, 10);
	}
	if (typeof cell !== "string") return null;

	const text = cell.trim();
	// `yyyy-MM-dd`, con o sin hora detrás (un `Date` serializado entero).
	const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
	if (iso?.[1]) return iso[1];

	// `dd/MM/yyyy` y `dd-MM-yyyy`, que es como lo escribe una persona aquí.
	const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
	if (local) {
		const [, day = "", month = "", year = ""] = local;
		return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
	}
	return null;
}

/**
 * Interpreta una celda de hora. Excel guarda las horas como **fracción de día**,
 * así que `0.354166…` es `08:30`.
 */
export function toImportTime(cell: unknown): string | null {
	if (typeof cell === "number" && Number.isFinite(cell)) {
		// La parte fraccionaria: un `timestamp` de Excel trae el día delante.
		const fraction = cell - Math.floor(cell);
		const minutes = Math.round(fraction * 24 * 60);
		if (minutes < 0 || minutes >= 24 * 60) return null;
		const hours = Math.floor(minutes / 60);
		return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
	}
	if (typeof cell !== "string") return null;

	const text = cell.trim();
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
	if (!match) return null;
	const [, hours = "", minutes = ""] = match;
	if (Number(hours) > 23 || Number(minutes) > 59) return null;
	return `${hours.padStart(2, "0")}:${minutes}`;
}

/**
 * Una fila del archivo → una fila interpretada, o el motivo por el que no.
 *
 * Devuelve **el motivo, no una excepción**: RN-19.2 pide un informe con las filas
 * con error *y su motivo*, y una excepción sólo permite contar la primera.
 */
export function parseImportRow(
	cells: readonly unknown[],
	row: number,
):
	| { ok: true; value: AttendanceImportRow }
	| { ok: false; issue: AttendanceImportIssue } {
	const fail = (message: string) => ({
		ok: false as const,
		issue: { row, message },
	});

	const [rawEmail, rawDate, rawTime, rawType] = cells;

	const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
	if (!email.includes("@")) return fail("El correo no es válido.");

	const date = toImportDate(rawDate);
	if (!date) return fail("La fecha no se entiende (usa AAAA-MM-DD).");

	const time = toImportTime(rawTime);
	if (!time) return fail("La hora no se entiende (usa HH:mm).");

	const typeKey = String(rawType ?? "")
		.trim()
		.toLowerCase();
	const markType = MARK_TYPE_ALIASES[typeKey];
	if (!markType) return fail("El tipo debe ser entrada o salida.");

	const parsed = attendanceImportRowSchema.safeParse({
		email,
		date,
		time,
		markType,
	});
	if (!parsed.success) {
		return fail(parsed.error.issues.at(0)?.message ?? "Fila no válida.");
	}
	return { ok: true, value: parsed.data };
}

/** Cuántas filas admite un archivo. Un histórico llega en tandas, no de una vez. */
export const IMPORT_MAX_ROWS = 20_000;

export type AdminStats = z.infer<typeof adminStatsSchema>;
export type MaintenanceState = z.infer<typeof maintenanceStateSchema>;
export type SetMaintenanceInput = z.infer<typeof setMaintenanceInputSchema>;
export type AttendanceImportRow = z.infer<typeof attendanceImportRowSchema>;
export type AttendanceImportIssue = z.infer<typeof attendanceImportIssueSchema>;
export type AttendanceImportReport = z.infer<
	typeof attendanceImportReportSchema
>;
export type AttendanceImportResult = z.infer<
	typeof attendanceImportResultSchema
>;
