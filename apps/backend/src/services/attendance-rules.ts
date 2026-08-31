import {
	type AppRole,
	type DevicePosition,
	formatDistance,
	formatMinutes,
	MARK_REJECTION_MESSAGES,
	type MarkRejectionReason,
	type MarkType,
	type WorkLocation,
} from "@elineas/validations";
import { validateMarkLocation } from "#/services/location-rules.ts";
import {
	type CalendarSnapshot,
	type ScheduleSnapshot,
	validateMarkTime,
	zonedParts,
} from "#/services/schedule-rules.ts";

/**
 * **La validación completa de un marcaje** (spec 09 §4).
 *
 * Es la función que la spec llama *la unidad de test más importante del sistema*, y
 * no hace ninguna cuenta por su cuenta: compone las dos que ya existían —la horaria
 * de la [07](packages/specs/07-horarios-y-calendario.md) y la de ubicación de la
 * [08](packages/specs/08-sedes-y-geocerca.md)— y añade lo que sólo se puede decidir
 * mirando lo que ya está escrito: antirrebote y secuencia.
 *
 * Sigue siendo **pura**: sin base de datos y sin reloj. El instante, el horario, el
 * calendario, las sedes y las marcas recientes entran como argumentos; quien las
 * carga es el handler (spec 09 §4). Eso es lo que permite probar el reloj
 * adelantado, la medianoche y el doble toque sin montar un escenario.
 *
 * El orden es el de la §3, con una desviación deliberada: **el antirrebote se
 * comprueba antes de la ventana horaria**. Un doble toque a las 08:15:59 y
 * 08:16:01 tiene que devolver "ya estaba registrado" y no "fuera de ventana", que
 * es lo que pasaría respetando el orden literal; y un segundo toque tras una
 * entrada válida no puede salir como secuencia inválida. Con el antirrebote delante,
 * repetir una petición siempre devuelve lo mismo, que es lo que significa ser
 * idempotente.
 *
 * Lo que **no** decide esta función: si se escribe la fila. Eso lo hace el servicio,
 * que escribe **siempre** —válida o rechazada (decisión 2 de la §8)— dentro de una
 * transacción.
 */

/** Marca ya registrada y **aceptada**, para el antirrebote y la secuencia. */
export type RecentMark = {
	id: string;
	markType: MarkType;
	markedAt: Date;
	workDate: string | null;
};

export type AttendanceMarkContext = {
	markType: MarkType;
	/** Instante del marcaje. Lo pone el servidor (RN-09.11). */
	at: Date;
	role: AppRole;
	profile: { isActive: boolean };
	/** Nulo = perfil sin departamento (RN-02.3): no hay horario que aplicar. */
	department: {
		id: string;
		name: string;
		isPaused: boolean;
		pauseReason: string | null;
	} | null;
	schedule: ScheduleSnapshot | null;
	calendarByDate?: Readonly<Record<string, CalendarSnapshot>>;
	/** Spec 10, por predicado: esta función no elige la convención de días. */
	isRestDay?: (workDate: string) => boolean;
	/**
	 * RN-09.2 — Costura para la spec 11. Hoy nadie la pone en `true` porque no hay
	 * tabla de vacaciones; cuando exista, es el único punto que hay que conectar.
	 */
	onVacation?: boolean;
	globalToleranceMinutes: number;
	/** Sede que declara el cliente (RN-09.6). */
	requestedLocationId: string | null;
	/** La que el perfil tiene seleccionada (RN-08.5). */
	selectedLocation: WorkLocation | null;
	activeLocations: readonly WorkLocation[];
	position: DevicePosition;
	/** Marcas aceptadas recientes (unas 48 h), para antirrebote y secuencia. */
	recentMarks: readonly RecentMark[];
};

export type AttendanceMarkDecision = {
	accepted: boolean;
	/** `true` si era repetición: no se escribe nada y se devuelve la de antes. */
	duplicate: boolean;
	duplicateOfId: string | null;
	reason: MarkRejectionReason | null;
	message: string;
	/** Lo que hay que guardar en la fila, ya resuelto. */
	workDate: string | null;
	isLate: boolean;
	lateMinutes: number;
	distanceToCenter: number | null;
	insideGeofence: boolean | null;
	workLocationId: string | null;
};

/** RN-09.10 — Ventana del antirrebote. */
export const DEBOUNCE_SECONDS = 30;

const MARK_LABEL: Record<MarkType, string> = {
	IN: "Entrada",
	OUT: "Salida",
};

export function validateAttendanceMark(
	context: AttendanceMarkContext,
): AttendanceMarkDecision {
	/**
	 * La ubicación se evalúa **siempre**, aunque falle algo anterior: sus números
	 * (distancia y pertenencia) van a la fila del intento rechazado, y sin ellos
	 * soporte no puede reconstruir dónde estaba la persona cuando no la dejó marcar.
	 * El **motivo** sí respeta el orden: sólo se usa el de ubicación si lo anterior
	 * pasó.
	 */
	const location = validateMarkLocation({
		requestedLocationId: context.requestedLocationId,
		selected: context.selectedLocation,
		activeLocations: context.activeLocations,
		position: context.position,
	});

	const base: AttendanceMarkDecision = {
		accepted: false,
		duplicate: false,
		duplicateOfId: null,
		reason: null,
		message: "",
		workDate: null,
		isLate: false,
		lateMinutes: 0,
		distanceToCenter: location.distanceMeters,
		insideGeofence: location.insideGeofence,
		workLocationId: context.selectedLocation?.id ?? null,
	};

	const reject = (
		reason: MarkRejectionReason,
		message?: string,
		extra: Partial<AttendanceMarkDecision> = {},
	): AttendanceMarkDecision => ({
		...base,
		...extra,
		accepted: false,
		reason,
		message: message ?? MARK_REJECTION_MESSAGES[reason],
	});

	// 1 — RN-09.1. La sesión ya la resolvió el middleware; lo que queda por mirar es
	// si la cuenta sigue activa en **este** sistema (RN-00.30).
	if (!context.profile.isActive) return reject("INACTIVE_ACCOUNT");

	// 2 — RN-09.2. Vacaciones aprobadas y vigentes (spec 11 RN-11.9).
	if (context.onVacation) return reject("ON_VACATION");

	// 3 — RN-09.10, adelantado: el antirrebote se mide sólo contra marcas
	// **aceptadas**. Un intento rechazado no puede tapar el marcaje bueno que se
	// intenta veinte segundos después, cuando la persona ya entró en la geocerca.
	const debounceWindowMs = DEBOUNCE_SECONDS * 1000;
	const repeated = context.recentMarks
		.filter(
			(mark) =>
				mark.markType === context.markType &&
				context.at.getTime() - mark.markedAt.getTime() >= 0 &&
				context.at.getTime() - mark.markedAt.getTime() < debounceWindowMs,
		)
		.at(0);

	if (repeated) {
		return {
			...base,
			accepted: true,
			duplicate: true,
			duplicateOfId: repeated.id,
			reason: "DUPLICATE_MARK",
			workDate: repeated.workDate,
			message: `Ya habías registrado tu ${MARK_LABEL[context.markType].toLowerCase()}. No se duplica.`,
		};
	}

	// 4 — RN-09.4, primera parte. Sin departamento no hay horario que aplicar
	// (RN-02.3). Se responde `NO_SCHEDULE` porque es literalmente lo que falta, con
	// un mensaje que dice la causa real en vez de culpar a un departamento que no
	// existe.
	if (!context.department) {
		return reject(
			"NO_SCHEDULE",
			"Todavía no tienes departamento asignado, así que no hay horario que aplicar. Un gestor tiene que asignártelo.",
		);
	}

	// 5 — Rol, pausa del departamento, horario, calendario, descanso, ventana y
	// tardanza: todo eso es la spec 07 §4, y ya está resuelto y probado allí
	// (RN-09.3, RN-09.4, RN-09.5, RN-09.7).
	const schedule = context.schedule;
	const time = validateMarkTime({
		markType: context.markType,
		at: context.at,
		role: context.role,
		department: context.department,
		schedule,
		calendarByDate: context.calendarByDate,
		isRestDay: context.isRestDay,
		globalToleranceMinutes: context.globalToleranceMinutes,
	});

	const withTime: AttendanceMarkDecision = {
		...base,
		workDate: time.workDate ?? null,
		isLate: time.isLate ?? false,
		lateMinutes: time.lateMinutes ?? 0,
	};

	if (!time.allowed) {
		return {
			...withTime,
			accepted: false,
			duplicate: false,
			duplicateOfId: null,
			reason: time.reason ?? "OUTSIDE_TIME_WINDOW",
			message: time.message ?? "",
		};
	}

	// 6 — RN-09.6. Sede seleccionada, activa, geocerca recalculada y precisión.
	if (!location.allowed) {
		return {
			...withTime,
			accepted: false,
			duplicate: false,
			duplicateOfId: null,
			reason: location.reason ?? "INVALID_LOCATION",
			message: location.message,
		};
	}

	// Llegar aquí sin horario es imposible: `validateMarkTime` habría devuelto
	// `NO_SCHEDULE`. La comprobación existe para que el tipo lo sepa, sin recurrir a
	// una aserción de no-nulo.
	if (!schedule) return reject("NO_SCHEDULE");

	/**
	 * La hora de una marca anterior, **en la zona del horario** (RN-07.2). Con
	 * `format` de date-fns saldría la del proceso, que en un contenedor es UTC: el
	 * mensaje diría "desde las 11:50" a quien entró a las 07:50.
	 */
	const localTimeOf = (instant: Date) =>
		formatMinutes(zonedParts(instant, schedule.timezone).minutes);

	// 7 — RN-09.9. Alternancia dentro del día laboral ya resuelto: entrada, salida,
	// entrada, salida… El almuerzo es legítimo; dos entradas seguidas, no.
	const workDate = time.workDate ?? null;
	const previous = context.recentMarks
		.filter((mark) => workDate !== null && mark.workDate === workDate)
		.sort((a, b) => b.markedAt.getTime() - a.markedAt.getTime())
		.at(0);

	if (context.markType === "IN" && previous?.markType === "IN") {
		return reject(
			"INVALID_SEQUENCE",
			`Ya tienes una entrada sin salida desde las ${localTimeOf(previous.markedAt)}. Marca la salida antes de volver a entrar.`,
			withTime,
		);
	}
	if (context.markType === "OUT" && !previous) {
		return reject(
			"INVALID_SEQUENCE",
			"No tienes ninguna entrada registrada en esta jornada, así que no hay salida que marcar.",
			withTime,
		);
	}
	if (context.markType === "OUT" && previous?.markType === "OUT") {
		return reject(
			"INVALID_SEQUENCE",
			`Tu última marca de la jornada ya fue una salida, a las ${localTimeOf(previous.markedAt)}. Marca una entrada antes de otra salida.`,
			withTime,
		);
	}

	// 8 — RN-09.8. Sólo entonces se acepta.
	const late =
		withTime.isLate && withTime.lateMinutes > 0
			? `, con ${withTime.lateMinutes} ${withTime.lateMinutes === 1 ? "minuto" : "minutos"} de tardanza`
			: "";

	return {
		...withTime,
		accepted: true,
		message: `${MARK_LABEL[context.markType]} registrada a las ${time.localTime} en ${context.selectedLocation?.name ?? "tu sede"}, a ${formatDistance(location.distanceMeters ?? 0)} del centro${late}.`,
	};
}
