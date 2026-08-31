import { z } from "zod";
import type { MarkType } from "./attendance.ts";
import { departmentScopeSchema } from "./roles.ts";
import {
	dayOffset,
	describeMinutes,
	formatMinutes,
	isoDateSchema,
	MINUTES_PER_DAY,
	minutesOfDay,
	timeOfDaySchema,
	timezoneSchema,
} from "./time.ts";

/**
 * Horario por departamento y calendario laboral (spec 07).
 *
 * Dos piezas complementarias que juntas responden **cuándo** se puede marcar: el
 * horario da la ventana diaria y el calendario dice qué fechas concretas son
 * laborables, con su tolerancia propia.
 *
 * Aquí vive además la **aritmética de la ventana**, que es lo único de la spec 07
 * que necesitan por igual el servidor (para aceptar o rechazar un marcaje) y el
 * formulario (para previsualizar "Puedes entrar entre 07:45 y 08:15"). Está en
 * `@elineas/validations` por el mismo motivo que `checkoutModeIssue` de la spec
 * 06: si la cuenta se hiciera dos veces, el aviso del formulario y el 400 del
 * servidor acabarían discrepando.
 *
 * Decisiones cerradas de la §8, para no volver a discutirlas al leer el código:
 *
 * 1. **Un horario por departamento** (RN-07.1). No hay turnos múltiples ni
 *    horarios por persona; `department_id` es único en la tabla.
 * 2. **Sí se soportan jornadas que cruzan medianoche** (RN-07.5): la salida
 *    pertenece al día laboral anterior.
 * 3. **En día no laborable el marcaje se rechaza** con `NOT_WORKDAY` (RN-07.6);
 *    si de verdad se trabajó, se corrige por incidencias (spec 12).
 * 4. **Los feriados se cargan a mano**, con edición masiva por rango. No hay
 *    siembra automática de fechas que nadie pidió.
 */

// ── Horario ───────────────────────────────────────────────────────────────────

/**
 * Lo que hace falta para calcular una ventana. Se pide de forma estructural para
 * que sirva igual la fila de la base, la respuesta de la API y el borrador a
 * medio teclear del formulario.
 */
export type ScheduleTimes = {
	checkinStartTime: string;
	checkinEndTime: string;
	checkoutStartTime: string;
	checkoutEndTime: string;
	allowEarlyCheckin: boolean;
	allowLateCheckout: boolean;
};

export const departmentScheduleSchema = z.object({
	id: z.uuid(),
	departmentId: z.uuid(),
	/** Ventana de entrada (RN-07.3). */
	checkinStartTime: timeOfDaySchema,
	checkinEndTime: timeOfDaySchema,
	/** Ventana de salida (RN-07.4). */
	checkoutStartTime: timeOfDaySchema,
	checkoutEndTime: timeOfDaySchema,
	/**
	 * Zona horaria del departamento. Gana sobre `global_timezone` (RN-06.6) y es
	 * la que se usa en **cada** conversión instante → hora local (RN-07.2): nunca
	 * la del servidor, que en un contenedor es UTC y no dice nada de la planta.
	 */
	timezone: z.string(),
	/** Admite marcar entrada antes de que abra la ventana (RN-07.3). */
	allowEarlyCheckin: z.boolean(),
	/** Admite marcar salida después de que cierre la ventana (RN-07.4). */
	allowLateCheckout: z.boolean(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * `PUT` del horario: describe el horario completo, no un parche. Es un upsert —
 * el departamento tiene uno o no tiene ninguno (RN-07.1)— y por eso no hay
 * `POST` aparte.
 *
 * `timezone` es opcional: sin ella se toma `global_timezone` (RN-06.6), que es lo
 * que quiere el 95 % de los departamentos.
 */
export const updateDepartmentScheduleInputSchema = z.object({
	checkinStartTime: timeOfDaySchema,
	checkinEndTime: timeOfDaySchema,
	checkoutStartTime: timeOfDaySchema,
	checkoutEndTime: timeOfDaySchema,
	timezone: timezoneSchema.optional(),
	allowEarlyCheckin: z.boolean().default(false),
	allowLateCheckout: z.boolean().default(false),
});

// ── Aritmética de la ventana ──────────────────────────────────────────────────

/**
 * Ventanas del horario en **minutos absolutos** contados desde la medianoche del
 * día laboral. Pasar de 1440 significa "del día siguiente", que es exactamente lo
 * que permite expresar una jornada nocturna sin casos especiales repartidos por
 * el código (RN-07.5).
 */
export type ScheduleWindows = {
	checkinStart: number;
	checkinEnd: number;
	checkoutStart: number;
	checkoutEnd: number;
	/** `true` si la jornada termina en el día natural siguiente (RN-07.5). */
	crossesMidnight: boolean;
};

/**
 * El siguiente instante ≥ `previous` que cae a esa hora de reloj.
 *
 * Es la pieza que hace innecesario un interruptor de "jornada nocturna": las
 * cuatro horas se van anclando en orden y la que "va hacia atrás" en el reloj se
 * entiende como del día siguiente.
 */
function nextAtOrAfter(previous: number, minuteOfDay: number): number {
	const dayStart = Math.floor(previous / MINUTES_PER_DAY) * MINUTES_PER_DAY;
	const candidate = dayStart + minuteOfDay;
	return candidate >= previous ? candidate : candidate + MINUTES_PER_DAY;
}

const dayStartOf = (minutes: number) =>
	Math.floor(minutes / MINUTES_PER_DAY) * MINUTES_PER_DAY;

const dayEndOf = (minutes: number) => dayStartOf(minutes) + MINUTES_PER_DAY - 1;

/**
 * Las cuatro horas del horario, ancladas al día laboral.
 *
 * La salida se ancla a la **apertura de la entrada** y no a su cierre para que un
 * horario con ventanas solapadas (entrar de 08:00 a 12:00, salir de 11:00 a
 * 20:00) no se interprete como nocturno.
 */
export function scheduleWindows(schedule: ScheduleTimes): ScheduleWindows {
	const checkinStart = minutesOfDay(schedule.checkinStartTime);
	const checkinEnd = nextAtOrAfter(
		checkinStart,
		minutesOfDay(schedule.checkinEndTime),
	);
	const checkoutStart = nextAtOrAfter(
		checkinStart,
		minutesOfDay(schedule.checkoutStartTime),
	);
	const checkoutEnd = nextAtOrAfter(
		checkoutStart,
		minutesOfDay(schedule.checkoutEndTime),
	);

	return {
		checkinStart,
		checkinEnd,
		checkoutStart,
		checkoutEnd,
		crossesMidnight: checkoutEnd >= MINUTES_PER_DAY,
	};
}

/** RN-07.5: ¿la jornada de este horario termina al día siguiente? */
export function scheduleCrossesMidnight(schedule: ScheduleTimes): boolean {
	return scheduleWindows(schedule).crossesMidnight;
}

export type MarkWindow = {
	/** Minutos absolutos desde la medianoche del día laboral. */
	start: number;
	end: number;
	/** La hora que el horario espera: la apertura de la ventana sin extender. */
	expected: number;
	/** `true` si el interruptor de anticipada/tardía está ensanchando la ventana. */
	extended: boolean;
};

/**
 * Ventana efectiva del tipo de marca, con los dos interruptores ya aplicados
 * (RN-07.3, RN-07.4).
 *
 * **Hasta dónde ensanchan.** `allow_early_checkin` abre la entrada desde la
 * medianoche del día laboral y `allow_late_checkout` cierra la salida al final
 * del día natural en que termina la jornada. El límite es el día, no un margen en
 * minutos, porque un margen habría que inventarlo: la spec no lo fija y un número
 * plausible metido a mano se queda ahí para siempre decidiendo rechazos que nadie
 * revisa (mismo criterio que los defaults de la spec 06 §3.1). Con el día como
 * frontera, la interfaz puede decir la hora exacta hasta la que se acepta.
 */
export function markWindow(
	schedule: ScheduleTimes,
	markType: MarkType,
): MarkWindow {
	const windows = scheduleWindows(schedule);

	if (markType === "IN") {
		return {
			start: schedule.allowEarlyCheckin
				? dayStartOf(windows.checkinStart)
				: windows.checkinStart,
			end: windows.checkinEnd,
			expected: windows.checkinStart,
			extended: schedule.allowEarlyCheckin,
		};
	}

	return {
		start: windows.checkoutStart,
		end: schedule.allowLateCheckout
			? dayEndOf(windows.checkoutEnd)
			: windows.checkoutEnd,
		expected: windows.checkoutStart,
		extended: schedule.allowLateCheckout,
	};
}

/**
 * Coherencia del horario, con el mismo criterio que `checkoutModeIssue` de la
 * spec 06: **la misma función** en el servidor y en el formulario, para que el
 * aviso salga al teclear y no al recibir el 400.
 *
 * Acepta un borrador incompleto porque es lo que hay mientras alguien rellena las
 * cuatro horas.
 */
export function scheduleIssue(draft: Partial<ScheduleTimes>): string | null {
	const times = [
		draft.checkinStartTime,
		draft.checkinEndTime,
		draft.checkoutStartTime,
		draft.checkoutEndTime,
	];

	if (times.some((time) => !time)) {
		return "Completa las cuatro horas: la ventana de entrada y la de salida.";
	}
	if (times.some((time) => !timeOfDaySchema.safeParse(time).success)) {
		return "Alguna de las horas no tiene el formato HH:mm.";
	}

	const schedule = draft as ScheduleTimes;

	// La entrada no cruza la medianoche: lo que la spec admite que cruce es la
	// jornada por su ventana de salida (RN-07.5). Una entrada de 23:00 a 01:00
	// dejaría dos días laborales candidatos para la misma marca.
	if (
		minutesOfDay(schedule.checkinEndTime) <=
		minutesOfDay(schedule.checkinStartTime)
	) {
		return "La ventana de entrada tiene que cerrar después de abrir, dentro del mismo día.";
	}

	const windows = scheduleWindows(schedule);

	if (windows.checkoutEnd <= windows.checkoutStart) {
		return "La ventana de salida tiene que cerrar después de abrir.";
	}
	if (windows.checkoutEnd - windows.checkinStart > MINUTES_PER_DAY) {
		return "La jornada no puede durar más de 24 horas. Revisa la hora de entrada y la de salida.";
	}

	return null;
}

/**
 * "entre las 07:45 y las 08:15", con la coletilla del día siguiente si toca — una
 * sola vez cuando las dos horas caen el mismo día, o se lee como un trabalenguas.
 */
function describeRange(start: number, end: number): string {
	if (dayOffset(start) === dayOffset(end)) {
		return `entre las ${formatMinutes(start)} y las ${describeMinutes(end)}`;
	}
	return `entre las ${describeMinutes(start)} y las ${describeMinutes(end)}`;
}

/**
 * La frase que pide la spec 07 §6 para el previsualizador del formulario. Se
 * escribe una vez y la usan la tarjeta de horario y la vista del empleado.
 */
export function describeMarkWindow(
	schedule: ScheduleTimes,
	markType: MarkType,
): string {
	const window = markWindow(schedule, markType);
	const verb = markType === "IN" ? "entrar" : "salir";
	const base = `Puedes ${verb} ${describeRange(window.start, window.end)}.`;

	if (!window.extended) return base;

	return markType === "IN"
		? `${base} La entrada se espera a las ${describeMinutes(window.expected)}; con entrada anticipada se acepta desde la medianoche.`
		: `${base} La salida se espera a las ${describeMinutes(window.expected)}; con salida tardía se acepta hasta el final del día.`;
}

/** Aviso de jornada nocturna para la interfaz (RN-07.5). */
export function describeMidnightCrossing(
	schedule: ScheduleTimes,
): string | null {
	const windows = scheduleWindows(schedule);
	if (!windows.crossesMidnight) return null;

	return `La jornada cruza la medianoche: una salida a las ${formatMinutes(windows.checkoutEnd)} del día siguiente cuenta para el día laboral anterior.`;
}

// ── Calendario laboral ────────────────────────────────────────────────────────

/** RN-07.8: mismos límites que `late_tolerance_minutes` de la spec 06. */
export const lateToleranceMinutesSchema = z
	.number()
	.int("La tolerancia se mide en minutos enteros")
	.min(0, "La tolerancia no puede ser negativa")
	.max(240, "La tolerancia no puede pasar de 240 minutos");

export const workCalendarNoteSchema = z
	.string()
	.trim()
	.max(120, "La nota no puede pasar de 120 caracteres");

export const workCalendarEntrySchema = z.object({
	id: z.uuid(),
	departmentId: z.uuid(),
	date: isoDateSchema,
	isWorkday: z.boolean(),
	/** Nulo = se usa la tolerancia global de la spec 06 (RN-07.8). */
	lateToleranceMinutes: lateToleranceMinutesSchema.nullable(),
	/**
	 * Por qué esta fecha es distinta: "Feriado: 1 de mayo", "Inventario".
	 *
	 * No está en la §2 de la spec y se añade por criterio: el calendario existe
	 * para feriados y jornadas especiales, y sin una etiqueta un día en rojo no
	 * dice de qué se trata — ni en la pantalla ni seis meses después revisando por
	 * qué a alguien no se le exigió asistencia.
	 */
	note: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/** `?from=&to=`, ambos inclusive. */
export const workCalendarQuerySchema = z
	.object({ from: isoDateSchema, to: isoDateSchema })
	.refine(({ from, to }) => from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	})
	.refine(
		({ from, to }) =>
			(Date.parse(`${to}T00:00:00.000Z`) -
				Date.parse(`${from}T00:00:00.000Z`)) /
				86_400_000 <=
			1830,
		{ message: "El rango no puede pasar de cinco años." },
	);

/**
 * `GET /me/schedule?from=&to=`: el rango es opcional porque el caso normal es
 * "el mes en curso", y quién decide cuál es el mes en curso es el servidor —en la
 * zona del horario, no en la del navegador (RN-07.2).
 */
export const myScheduleQuerySchema = z
	.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
	.refine(({ from, to }) => !from || !to || from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	})
	.refine(({ from, to }) => (from ? !!to : !to), {
		message: "Indica las dos fechas del rango, o ninguna.",
	});

export const workCalendarEntryInputSchema = z.object({
	date: isoDateSchema,
	isWorkday: z.boolean(),
	lateToleranceMinutes: lateToleranceMinutesSchema.nullable().default(null),
	note: workCalendarNoteSchema.nullable().default(null),
});

/**
 * `PUT` del calendario: **upsert por lote** (spec 07 §5).
 *
 * `clearDates` existe porque "no laborable" y "sin fila" no son lo mismo: sin
 * fila la fecha es laborable por defecto (RN-07.7), y hacía falta una forma de
 * volver a ese estado sin inventar un tercer valor de `isWorkday`. Van en la
 * misma petición que las altas para que un mes entero se guarde en una
 * transacción y deje una sola entrada de bitácora.
 */
export const updateWorkCalendarInputSchema = z
	.object({
		entries: z.array(workCalendarEntryInputSchema).max(400).default([]),
		clearDates: z.array(isoDateSchema).max(400).default([]),
	})
	.refine(({ entries, clearDates }) => entries.length + clearDates.length > 0, {
		message: "No hay ninguna fecha que guardar.",
	})
	.refine(
		({ entries }) =>
			new Set(entries.map((entry) => entry.date)).size === entries.length,
		{ message: "Hay fechas repetidas en el lote." },
	)
	.refine(
		({ entries, clearDates }) => {
			const cleared = new Set(clearDates);
			return entries.every((entry) => !cleared.has(entry.date));
		},
		{ message: "Una misma fecha no puede guardarse y limpiarse a la vez." },
	);

/**
 * RN-07.8 — Precedencia de la tolerancia: la de la fecha gana, y si no hay,
 * manda la global de la spec 06. Una sola implementación, usada por el marcaje,
 * por la vista del empleado y por el editor del calendario.
 */
export function effectiveToleranceMinutes(
	entry: { lateToleranceMinutes: number | null } | null | undefined,
	globalToleranceMinutes: number,
): { minutes: number; source: "calendar" | "global" } {
	if (entry && entry.lateToleranceMinutes !== null) {
		return { minutes: entry.lateToleranceMinutes, source: "calendar" };
	}
	return { minutes: globalToleranceMinutes, source: "global" };
}

/**
 * Cómo queda un día concreto una vez resueltos calendario y tolerancia. Es lo que
 * la interfaz necesita para pintar el día y lo que el marcaje necesita para
 * decidir.
 */
export const workdayResolutionSchema = z.object({
	date: isoDateSchema,
	/** RN-07.6/7: sin fila en el calendario, la fecha es laborable. */
	isWorkday: z.boolean(),
	/** `true` si no hay fila y por tanto se aplicó el default. */
	fromDefault: z.boolean(),
	lateToleranceMinutes: lateToleranceMinutesSchema,
	toleranceSource: z.enum(["calendar", "global"]),
	note: z.string().nullable(),
});

/**
 * `GET /me/schedule` (spec 07 §5): el horario que le aplica a quien pregunta.
 *
 * Trae además las filas del calendario del rango pedido —por defecto el mes en
 * curso— porque un empleado no tiene ámbito sobre
 * `GET /departments/:id/calendar` y sin esto no podría ver sus propios días no
 * laborables. Sólo salen las de **su** departamento.
 */
export const myScheduleSchema = z.object({
	department: departmentScopeSchema.nullable(),
	schedule: departmentScheduleSchema.nullable(),
	/** La zona en la que se hacen las cuentas: la del horario o la global. */
	timezone: z.string(),
	/** Hoy en esa zona, no en la del servidor (RN-07.2). */
	today: workdayResolutionSchema,
	from: isoDateSchema,
	to: isoDateSchema,
	entries: z.array(workCalendarEntrySchema),
	/** RN-03.4 y RN-07.12: el gestor global no marca, aunque tenga horario. */
	canMark: z.boolean(),
	/** Tolerancia global vigente, para explicar de dónde sale la del día. */
	globalToleranceMinutes: lateToleranceMinutesSchema,
});

export type DepartmentSchedule = z.infer<typeof departmentScheduleSchema>;
export type UpdateDepartmentScheduleInput = z.infer<
	typeof updateDepartmentScheduleInputSchema
>;
export type WorkCalendarEntry = z.infer<typeof workCalendarEntrySchema>;
export type WorkCalendarEntryInput = z.infer<
	typeof workCalendarEntryInputSchema
>;
export type UpdateWorkCalendarInput = z.infer<
	typeof updateWorkCalendarInputSchema
>;
export type WorkCalendarQuery = z.infer<typeof workCalendarQuerySchema>;
export type MyScheduleQuery = z.infer<typeof myScheduleQuerySchema>;
export type WorkdayResolution = z.infer<typeof workdayResolutionSchema>;
export type MySchedule = z.infer<typeof myScheduleSchema>;
