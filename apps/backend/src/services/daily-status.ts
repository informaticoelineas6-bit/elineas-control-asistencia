import type { AttendanceDayStatus, MarkType } from "@elineas/validations";

/**
 * **Estado de un día para una persona** (spec 15 §2 y §3, adelantado aquí).
 *
 * La spec 09 §5 pide historial —"Mi semana" y el historial de escritorio— y las dos
 * vistas, dice, *usan la misma agregación diaria de la spec 15*. Esa spec aún no
 * está construida, así que aquí va **su función pura**, no una copia paralela: el
 * aviso de la 15 es explícito — en el legacy esta lógica estaba duplicada entre un
 * hook de frontend, una función SQL y una edge function, y **no hay que repetir
 * eso**. Cuando llegue la 15, esta función crece (vacaciones, AJ/ANJ,
 * materialización); no se reescribe en otro sitio.
 *
 * Dos cosas que la 15 deja abiertas y aquí hubo que resolver para poder pintar algo:
 *
 * - **Un día con marcas gana sobre `NO_LABORABLE` y `DESCANSO`** (RN-15.2, que la
 *   spec marca como "confirmar"). Con el marcaje rechazado en origen esto sólo pasa
 *   por importación histórica, y esconder trabajo que existió es peor que contradecir
 *   la precedencia de presentación.
 * - **`worked_minutes` suma los pares entrada→salida**, no `última salida − primera
 *   entrada`. Con la alternancia impuesta (RN-09.9) los pares son inequívocos, y
 *   sumarlos deja fuera el almuerzo; con un solo par da exactamente lo que describe
 *   la §3.
 */

export type DailyMark = {
	markType: MarkType;
	markedAt: Date;
	isLate: boolean;
	lateMinutes: number;
};

export type DailyContext = {
	date: string;
	/** Marcas **aceptadas** de ese día laboral. El orden no importa: se ordenan. */
	marks: readonly DailyMark[];
	/** Del calendario del departamento (spec 07 RN-07.6/7). */
	isWorkday: boolean;
	/** Descansos de la persona (spec 10). Hoy siempre `false`: no hay tabla. */
	isRestDay: boolean;
	/**
	 * `true` si la jornada todavía puede completarse (hoy o futuro). No cambia el
	 * estado —el vocabulario de la 15 no tiene "pendiente"— pero sí deja constancia
	 * de que `AUSENTE` es provisional, para que la interfaz no pinte en rojo a
	 * alguien a media mañana.
	 */
	isOpen?: boolean;
};

export type DailyFact = {
	date: string;
	status: AttendanceDayStatus;
	firstIn: Date | null;
	lastOut: Date | null;
	workedMinutes: number | null;
	incomplete: boolean;
	isLate: boolean;
	lateMinutes: number;
	pending: boolean;
};

export function computeDailyStatus(context: DailyContext): DailyFact {
	const marks = [...context.marks].sort(
		(a, b) => a.markedAt.getTime() - b.markedAt.getTime(),
	);

	const ins = marks.filter((mark) => mark.markType === "IN");
	const outs = marks.filter((mark) => mark.markType === "OUT");
	const firstIn = ins.at(0)?.markedAt ?? null;
	const lastOut = outs.at(-1)?.markedAt ?? null;

	// Pares entrada→salida. Un `IN` sin su `OUT` deja la jornada incompleta y
	// **no se le inventa una salida** (RN-15.3).
	let workedMs = 0;
	let openIn: Date | null = null;
	let incomplete = false;

	for (const mark of marks) {
		if (mark.markType === "IN") {
			openIn = mark.markedAt;
			continue;
		}
		if (openIn) {
			workedMs += mark.markedAt.getTime() - openIn.getTime();
			openIn = null;
		}
	}
	if (openIn) incomplete = true;

	const late = ins.find((mark) => mark.isLate);

	const status: AttendanceDayStatus = (() => {
		// RN-15.2: si hay marcas, hubo presencia, y eso manda sobre la clasificación
		// del día.
		if (marks.length > 0) return late ? "TARDE" : "PRESENTE";
		if (!context.isWorkday) return "NO_LABORABLE";
		if (context.isRestDay) return "DESCANSO";
		return "AUSENTE";
	})();

	return {
		date: context.date,
		status,
		firstIn,
		lastOut,
		workedMinutes:
			marks.length === 0 || incomplete ? null : Math.round(workedMs / 60_000),
		incomplete,
		isLate: !!late,
		lateMinutes: late?.lateMinutes ?? 0,
		pending:
			marks.length === 0 && status === "AUSENTE" && (context.isOpen ?? false),
	};
}
