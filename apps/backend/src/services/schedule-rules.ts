import { TZDate } from "@date-fns/tz";
import {
	type AppRole,
	describeMarkWindow,
	effectiveToleranceMinutes,
	formatMinutes,
	MARK_REJECTION_MESSAGES,
	type MarkRejectionReason,
	type MarkType,
	MINUTES_PER_DAY,
	markWindow,
	roleCanMark,
	type ScheduleTimes,
} from "@elineas/validations";
import { addDays, format, parseISO } from "date-fns";

/**
 * **Parte horaria de la validación de un marcaje** (spec 07 §4).
 *
 * Es el equivalente del `validate_attendance_mark` del legacy y, según la propia
 * spec, *el corazón de reglas del producto*. Tres propiedades lo sostienen:
 *
 * - **Es pura.** No toca la base ni el reloj del sistema: el instante, el horario,
 *   el calendario, los descansos y el estado del departamento entran como
 *   argumentos. Quien la llama carga el contexto (spec 09 §4). Eso es lo que
 *   permite probar el punto 71 de la deuda del legacy —cero cobertura— sin montar
 *   un escenario en base.
 * - **La zona horaria es explícita en cada conversión** (RN-07.2). La del
 *   departamento, nunca la del servidor: dentro de un contenedor el servidor es
 *   UTC y en La Habana son cuatro o cinco horas menos según la época del año.
 * - **Falla al primer no**, en el orden exacto de la spec 07 §4, y devuelve un
 *   motivo tipado (spec 09 §6) con un mensaje que dice qué hacer.
 *
 * Lo que **no** está aquí, porque es de otras specs: vacaciones (11), sede y
 * geocerca (08), alternancia y antirrebote (09). Esta función responde sólo
 * "¿toca marcar ahora?".
 */

/** El horario tal como lo necesita el cálculo: las cuatro horas y su zona. */
export type ScheduleSnapshot = ScheduleTimes & { timezone: string };

/** Lo que aporta una fila del calendario laboral a la decisión. */
export type CalendarSnapshot = {
	isWorkday: boolean;
	lateToleranceMinutes: number | null;
	note?: string | null;
};

export type MarkTimeInput = {
	markType: MarkType;
	/** Instante del marcaje. Lo pone el servidor, no el cliente (RN-09.11). */
	at: Date;
	/** Rol efectivo de quien marca (RN-03.4, RN-07.12). */
	role: AppRole;
	department: { isPaused: boolean; pauseReason: string | null };
	/** Nulo = el departamento aún no tiene horario (RN-09.4). */
	schedule: ScheduleSnapshot | null;
	/**
	 * Filas del calendario indexadas por fecha `yyyy-MM-dd`. Sólo las que existan:
	 * la ausencia de fila **significa** laborable por defecto (RN-07.7).
	 */
	calendarByDate?: Readonly<Record<string, CalendarSnapshot>>;
	/**
	 * Descansos de esta persona, como predicado sobre el día laboral (spec 10).
	 *
	 * Es un predicado y no un array de días de la semana a propósito: la
	 * convención de `days_of_week` (0 = domingo o 1 = lunes) sigue siendo una
	 * decisión abierta de la spec 10, y esta función no tiene por qué elegirla ni
	 * cambiar cuando se elija.
	 */
	isRestDay?: (workDate: string) => boolean;
	/** Tolerancia global vigente (spec 06), el respaldo de RN-07.8. */
	globalToleranceMinutes: number;
};

export type MarkTimeResult = {
	allowed: boolean;
	reason?: MarkRejectionReason;
	/** Mensaje en español y accionable (RN-05.10, spec 09 §5). */
	message?: string;
	/**
	 * Día laboral al que se atribuye la marca (RN-07.5). En una jornada nocturna
	 * la salida de la madrugada pertenece al día **anterior**, y es este campo el
	 * que lo dice: sin él, la agregación diaria contaría dos días a medias.
	 */
	workDate?: string;
	/** Hora local en la zona del horario, para el mensaje y para el registro. */
	localTime?: string;
	/** Sólo para `IN`: la tardanza no aplica a la salida (RN-09.7). */
	isLate?: boolean;
	lateMinutes?: number;
	/** La que se aplicó, ya resuelta por precedencia (RN-07.8). */
	toleranceMinutes?: number;
	toleranceSource?: "calendar" | "global";
	/** La ventana que se exigió, en hora local, para poder explicar el rechazo. */
	window?: { start: string; end: string };
};

/**
 * Fecha y minutos de reloj de un instante **en una zona concreta**.
 *
 * `TZDate` de date-fns v4 es lo que permite que `getHours()` devuelva la hora de
 * La Habana y no la del proceso. El legacy hacía esto con `Intl.DateTimeFormat` y
 * sin librería (RN-07.2); el resultado es el mismo, pero aquí la zona viaja con
 * el objeto y no hay forma de olvidarla a mitad de un cálculo.
 */
export function zonedParts(
	at: Date,
	timeZone: string,
): { date: string; minutes: number } {
	const zoned = new TZDate(at, timeZone);
	return {
		date: format(zoned, "yyyy-MM-dd"),
		minutes: zoned.getHours() * 60 + zoned.getMinutes(),
	};
}

/** Día anterior a una fecha civil, sin pasar por instantes ni zonas. */
export function previousDate(date: string): string {
	return format(addDays(parseISO(date), -1), "yyyy-MM-dd");
}

/** Hoy en la zona indicada, no en la del servidor (RN-07.2). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	return zonedParts(now, timeZone).date;
}

function reject(
	reason: MarkRejectionReason,
	message?: string,
	extra?: Partial<MarkTimeResult>,
): MarkTimeResult {
	return {
		allowed: false,
		reason,
		message: message ?? MARK_REJECTION_MESSAGES[reason],
		...extra,
	};
}

export function validateMarkTime(input: MarkTimeInput): MarkTimeResult {
	// 1 — ¿El rol puede marcar? (RN-03.4, RN-07.12: el gestor global no marca, y
	// su horario sólo importa para la reportería de quien esté en ese
	// departamento sin ser gestor.)
	if (!roleCanMark(input.role)) return reject("ROLE_CANNOT_MARK");

	// 2 — ¿El departamento está activo? (RN-07.9, RN-01.4). El motivo viaja en el
	// mensaje: un rechazo sin motivo obliga a preguntar a alguien.
	if (input.department.isPaused) {
		return reject(
			"DEPARTMENT_PAUSED",
			`Tu departamento está en pausa: ${input.department.pauseReason ?? "sin motivo registrado"}`,
		);
	}

	const schedule = input.schedule;
	if (!schedule) return reject("NO_SCHEDULE");

	const local = zonedParts(input.at, schedule.timezone);
	const window = markWindow(schedule, input.markType);
	const inWindow = (offset: number) =>
		offset >= window.start && offset <= window.end;

	/**
	 * A qué día laboral pertenece el marcaje (RN-07.5).
	 *
	 * Se prueban dos candidatos: el día local y el anterior. El segundo sólo puede
	 * ganar si la ventana se pasa de la medianoche —una jornada nocturna—, porque
	 * su desplazamiento arranca en 1440; para un horario diurno la comprobación
	 * sobra sin hacer daño, y así no hace falta un interruptor de "jornada
	 * nocturna" que alguien pueda dejar mal puesto.
	 */
	const candidates = [
		{ workDate: local.date, offset: local.minutes },
		{
			workDate: previousDate(local.date),
			offset: local.minutes + MINUTES_PER_DAY,
		},
	];
	const resolved =
		candidates.find((candidate) => inWindow(candidate.offset)) ?? candidates[0];
	// `candidates` es un literal de dos elementos: el primero existe siempre.
	if (!resolved) throw new Error("Imposible: no hay día laboral candidato.");

	const entry = input.calendarByDate?.[resolved.workDate];
	const localTime = formatMinutes(local.minutes);
	const shared = {
		workDate: resolved.workDate,
		localTime,
		window: {
			start: formatMinutes(window.start),
			end: formatMinutes(window.end),
		},
	};

	// 3 — ¿La fecha es laborable para el departamento? (RN-07.6 / RN-07.7)
	// Sin fila en el calendario, la fecha es laborable: la ausencia significa algo.
	if (entry && !entry.isWorkday) {
		const because = entry.note ? ` (${entry.note})` : "";
		return reject(
			"NOT_WORKDAY",
			`El ${resolved.workDate} no es laborable para tu departamento${because}. Si trabajaste ese día, repórtalo como incidencia.`,
			shared,
		);
	}

	// 4 — ¿Es día de descanso de esta persona? (spec 10 RN-10.4)
	if (input.isRestDay?.(resolved.workDate)) {
		return reject(
			"REST_DAY",
			`El ${resolved.workDate} es tu día de descanso.`,
			shared,
		);
	}

	// 5 — ¿La hora cae en la ventana del tipo de marca? (RN-07.3 / RN-07.4)
	if (!inWindow(resolved.offset)) {
		return reject(
			"OUTSIDE_TIME_WINDOW",
			`${describeMarkWindow(schedule, input.markType)} En tu departamento son las ${localTime}.`,
			shared,
		);
	}

	// 6 — ¿Hay tardanza? (RN-07.8 para la precedencia, RN-09.7 para el efecto.)
	// No bloquea: sólo etiqueta.
	const tolerance = effectiveToleranceMinutes(
		entry ?? null,
		input.globalToleranceMinutes,
	);

	if (input.markType === "OUT") {
		return {
			allowed: true,
			...shared,
			toleranceMinutes: tolerance.minutes,
			toleranceSource: tolerance.source,
		};
	}

	// Los minutos son de **retraso real** sobre la hora esperada, no lo que sobra
	// de la tolerancia: con 6 minutos y tolerancia de 5, lo que hay que ver en el
	// reporte es 6. La tolerancia sólo decide si cuenta como tardanza.
	const lateMinutes = Math.max(0, resolved.offset - window.expected);

	return {
		allowed: true,
		...shared,
		isLate: lateMinutes > tolerance.minutes,
		lateMinutes,
		toleranceMinutes: tolerance.minutes,
		toleranceSource: tolerance.source,
	};
}

/**
 * Cómo queda un día concreto del calendario de un departamento, con la tolerancia
 * ya resuelta (RN-07.7, RN-07.8).
 *
 * La usan `/me/schedule` y la interfaz del calendario; el marcaje resuelve lo
 * mismo por dentro. Está aquí para que "sin fila = laborable" se escriba una sola
 * vez.
 */
export function resolveWorkday(
	date: string,
	entry: CalendarSnapshot | null | undefined,
	globalToleranceMinutes: number,
) {
	const tolerance = effectiveToleranceMinutes(
		entry ?? null,
		globalToleranceMinutes,
	);

	return {
		date,
		isWorkday: entry ? entry.isWorkday : true,
		fromDefault: !entry,
		lateToleranceMinutes: tolerance.minutes,
		toleranceSource: tolerance.source,
		note: entry?.note ?? null,
	};
}
