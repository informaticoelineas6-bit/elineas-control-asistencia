import { z } from "zod";
import { timeOfDaySchema, timezoneSchema } from "./time.ts";

/**
 * Configuración global (spec 06).
 *
 * La tabla es clave/valor con JSONB como en el legacy, pero **tipada al leer**:
 * cada clave declara su esquema y su valor por defecto aquí, la base sólo guarda
 * sobrescrituras (RN-06.2) y un valor corrupto cae al default en vez de romper
 * la aplicación (criterio de aceptación de la spec 06).
 *
 * Las claves son `snake_case` porque son literalmente la clave de la tabla, y así
 * el catálogo de la spec 06 §3 se lee igual en la spec, en la base y en la API.
 *
 * **Criterio para elegir defaults:** el valor por defecto es el que hace que el
 * sistema se comporte *como si la clave no estuviera configurada*, nunca un valor
 * plausible inventado. Una tolerancia de 0 minutos o una tasa de vacaciones de 0
 * se notan enseguida y se corrigen; una inventada se queda ahí produciendo
 * cálculos equivocados que nadie revisa.
 */

/** Modo de cierre de la jornada (spec 06 §3.2, consumido por la spec 09 RN-09.13). */
export const checkoutModeSchema = z.enum([
	/** La persona marca su salida. */
	"manual",
	/** Se cierra sola a `attendance_auto_checkout_time`. */
	"schedule",
	/** Se cierra al salir de la geocerca durante N minutos. */
	"geofence_exit",
]);

export const configValueSchemas = {
	// ── 3.1 Tiempo y jornada ────────────────────────────────────────────────
	/**
	 * Zona horaria de la empresa. Confirmada en la spec 06 §8: Elineas opera en
	 * Cuba. Cada departamento puede tener la suya en su horario, y esa gana; ésta
	 * es el default al crear uno nuevo (RN-06.6).
	 */
	global_timezone: timezoneSchema,
	/** Prefill al crear un horario (spec 07). Nulo = sin prefill. */
	default_work_start_time: timeOfDaySchema.nullable(),
	default_work_end_time: timeOfDaySchema.nullable(),
	/** Minutos de gracia antes de contar tardanza (spec 09 RN-09.7). */
	late_tolerance_minutes: z.number().int().min(0).max(240),

	// ── 3.2 Modo de salida ──────────────────────────────────────────────────
	attendance_checkout_mode: checkoutModeSchema,
	/** Obligatoria si el modo es `schedule` (RN-06.5). */
	attendance_auto_checkout_time: timeOfDaySchema.nullable(),
	/** Obligatorio y > 0 si el modo es `geofence_exit` (RN-06.5). */
	attendance_geofence_exit_minutes: z.number().int().min(1).max(720).nullable(),

	// ── 3.3 Descansos ───────────────────────────────────────────────────────
	/**
	 * Días mínimos entre dos descansos de la misma persona (spec 10 RN-10.5).
	 * **0 desactiva la regla**: es el interruptor, y por eso es el default.
	 */
	rest_days_min_separation: z.number().int().min(0).max(31),
	/**
	 * Departamentos a los que se **acota** la regla anterior. La **lista vacía
	 * significa "todos"** (spec 10, decisión 2, cerrada): el interruptor es el
	 * número, y la lista sólo estrecha su alcance. Con el criterio contrario
	 * habría dos formas de decir "a nadie" —el 0 y la lista vacía— y ninguna de
	 * decir "a todos" sin enumerar los departamentos y acordarse de añadir cada
	 * uno nuevo.
	 */
	rest_days_min_separation_departments: z.array(z.uuid()),
	/**
	 * Mínimo y máximo de días de descanso por semana (spec 10 RN-10.9).
	 *
	 * La cifra es una regla laboral y la pone el negocio, no el código; lo que sí
	 * tiene que existir ya es **el sitio donde ponerla**, o el día que se decida
	 * será un despliegue en vez de un cambio de configuración. Los defaults dejan
	 * la regla inerte —0 y 7 no excluyen ningún conjunto de días—, siguiendo el
	 * criterio de esta spec: el default se comporta como si la clave no estuviera.
	 */
	rest_days_min_per_week: z.number().int().min(0).max(7),
	rest_days_max_per_week: z.number().int().min(0).max(7),

	// ── 3.4 Vacaciones ──────────────────────────────────────────────────────
	/**
	 * Días de vacaciones que se acumulan por día trabajado (spec 11 RN-11.2).
	 *
	 * **No** es el divisor de nómina: son dos cosas distintas y no comparten
	 * clave (spec 06 §3.4, spec 17 §7).
	 */
	vacation_days_per_worked_day: z.number().min(0).max(1),

	// ── 3.5 Incidencias ─────────────────────────────────────────────────────
	/**
	 * Días hacia atrás dentro de los que se puede reportar una incidencia (spec
	 * 12 RN-12.4). **0 desactiva el plazo**, y por eso es el default: es el
	 * interruptor, igual que en `rest_days_min_separation`.
	 *
	 * La spec proponía 7 días. La cifra es una regla laboral —¿hasta cuándo se
	 * admite un reclamo sobre un mes ya pagado?— y la pone el negocio; lo que
	 * tenía que existir ya es el sitio donde ponerla. Sin plazo, alguien puede
	 * reclamar un día de hace seis meses; con uno mal elegido, alguien de baja
	 * médica pierde la vía formal de reportar. Ninguna de las dos la decide el
	 * código.
	 */
	incident_report_window_days: z.number().int().min(0).max(365),

	// ── 3.6 Reportería ──────────────────────────────────────────────────────
	/** Si los `department_head` salen en el reporte global (spec 16 RN-16.2). */
	include_heads_in_global_reports: z.boolean(),
	report_slo_error_rate_pct: z.number().min(0).max(100),
	report_slo_availability_pct: z.number().min(0).max(100),
	/** Nulo = la exportación a Sheets está sin configurar (spec 16). */
	google_sheets_report_spreadsheet_id: z.string().trim().min(1).nullable(),

	// ── 3.7 Ámbito ──────────────────────────────────────────────────────────
	/**
	 * Departamento al que se fuerzan los perfiles con rol `global_manager`
	 * (RN-03.6). Se guarda por **id**, no por nombre: el legacy lo resolvía por
	 * el literal "Administración" en un trigger, y eso ataba el comportamiento a
	 * un nombre que cualquiera podía cambiar. Nulo = la regla está desactivada.
	 */
	global_manager_department_id: z.uuid().nullable(),
} as const;

export const configSchema = z.object(configValueSchemas);

export const updateConfigInputSchema = configSchema
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "No hay ninguna clave que actualizar",
	});

/** RN-06.2: toda clave tiene default en código. */
export const CONFIG_DEFAULTS: AppConfigValues = {
	global_timezone: "America/Havana",
	default_work_start_time: null,
	default_work_end_time: null,
	late_tolerance_minutes: 0,
	attendance_checkout_mode: "manual",
	attendance_auto_checkout_time: null,
	attendance_geofence_exit_minutes: null,
	rest_days_min_separation: 0,
	rest_days_min_separation_departments: [],
	rest_days_min_per_week: 0,
	rest_days_max_per_week: 7,
	vacation_days_per_worked_day: 0,
	incident_report_window_days: 0,
	include_heads_in_global_reports: true,
	report_slo_error_rate_pct: 1,
	report_slo_availability_pct: 99,
	google_sheets_report_spreadsheet_id: null,
	global_manager_department_id: null,
};

export const CONFIG_KEYS = Object.keys(configValueSchemas) as ConfigKey[];

/**
 * Subconjunto seguro de `GET /config/public` (spec 06 §5): lo que cualquier rol
 * necesita para que la interfaz muestre las mismas horas y las mismas reglas que
 * aplica el servidor.
 *
 * Es una **lista blanca explícita** y no un "todo menos X" a propósito: añadir
 * una clave al catálogo no debe exponerla por descuido. Los ids de departamento,
 * los SLOs y el identificador de la hoja de cálculo no están aquí porque no le
 * sirven a nadie que no sea gestor.
 */
export const PUBLIC_CONFIG_KEYS = [
	"global_timezone",
	"late_tolerance_minutes",
	"attendance_checkout_mode",
	"attendance_auto_checkout_time",
	"attendance_geofence_exit_minutes",
	/**
	 * Spec 12 RN-12.4: el formulario de incidencias tiene que poder decir "esa
	 * fecha ya quedó fuera de plazo" antes de enviar, con la misma cifra que
	 * aplica el servidor (`incidentDateIssue`). Es exactamente para lo que existe
	 * esta lista, y no revela nada: es un plazo, igual que la tolerancia.
	 */
	"incident_report_window_days",
] as const satisfies readonly ConfigKey[];

export const publicConfigSchema = configSchema.pick(
	Object.fromEntries(PUBLIC_CONFIG_KEYS.map((key) => [key, true])) as {
		[K in PublicConfigKey]: true;
	},
);

/**
 * RN-06.5 — Validación cruzada del modo de salida.
 *
 * Se valida el resultado **efectivo**, no el parche: alguien puede fijar la hora
 * de cierre hoy y cambiar el modo mañana, y lo que tiene que ser coherente es lo
 * que queda guardado, no cada petición por separado.
 */
export function checkoutModeIssue(values: AppConfigValues): string | null {
	if (
		values.attendance_checkout_mode === "schedule" &&
		!values.attendance_auto_checkout_time
	) {
		return "Con el modo de salida «por horario» hay que indicar la hora de cierre automático.";
	}
	if (
		values.attendance_checkout_mode === "geofence_exit" &&
		!values.attendance_geofence_exit_minutes
	) {
		return "Con el modo de salida «por salida de geocerca» hay que indicar cuántos minutos fuera cierran la jornada.";
	}
	return null;
}

/**
 * Coherencia de los límites de descansos (spec 10 RN-10.9).
 *
 * Se valida el resultado **efectivo** por el mismo motivo que el modo de salida:
 * alguien puede subir el mínimo hoy y bajar el máximo mañana, y lo que tiene que
 * quedar coherente es lo guardado. Un mínimo por encima del máximo no rechaza una
 * configuración concreta: rechaza **todas**, y deja a la plantilla sin poder
 * guardar sus descansos sin que nadie relacione las dos claves.
 */
export function restLimitsIssue(values: AppConfigValues): string | null {
	if (values.rest_days_min_per_week > values.rest_days_max_per_week) {
		return "El mínimo de descansos por semana no puede ser mayor que el máximo.";
	}
	return null;
}

export type AppConfigValues = z.infer<typeof configSchema>;
export type ConfigKey = keyof typeof configValueSchemas;
export type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];
export type PublicConfigValues = z.infer<typeof publicConfigSchema>;
export type CheckoutMode = z.infer<typeof checkoutModeSchema>;
export type UpdateConfigInput = z.infer<typeof updateConfigInputSchema>;
