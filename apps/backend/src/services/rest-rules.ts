import { isRestDate, type RestSource } from "@elineas/validations";

/**
 * **Resolución de descansos** (spec 10 §6): qué días descansa una persona en una
 * fecha dada.
 *
 * Es la *única implementación* que pide la spec —"usada por el marcaje, la
 * agregación diaria y la reportería"— y es **pura**: no toca la base ni el reloj.
 * Las filas de vigencia, la asignación de grupo, los grupos y el interruptor del
 * departamento entran como argumentos; quien los carga es `rest-schedules.ts`.
 *
 * Dos reglas viven aquí y en ningún otro sitio:
 *
 * - **RN-10.1 — vigencia por fecha.** Para una fecha D manda la fila más reciente
 *   con `effective_from ≤ D`. Es lo que hace que cambiar los descansos no
 *   reescriba el pasado, y por tanto lo que hace que un reporte cerrado siga
 *   dando el mismo número el mes que viene.
 * - **RN-10.2 — precedencia.** Con `rest_groups_enabled`, mandan los grupos y la
 *   configuración individual **se ignora, no se borra**: apagar el interruptor la
 *   devuelve intacta (RN-01.6).
 *
 * Y una tercera por omisión: **RN-10.3 — sin ninguna fila vigente, no hay
 * descansos** y se exigen todos los días laborables del calendario. Es el caso
 * que dispara el recordatorio de RN-10.10, y es deliberadamente el caso por
 * defecto: inventarle descansos a quien no los tiene configurados dejaría de
 * exigirle días sin que nadie lo haya decidido.
 */

/** Una fila de `user_rest_schedule`, con lo que necesita el cálculo. */
export type RestScheduleRow = {
	daysOfWeek: number[];
	effectiveFrom: string;
};

/** Una fila de `rest_group_members`. `groupId` nulo = salió del grupo esa fecha. */
export type RestMembershipRow = {
	groupId: string | null;
	effectiveFrom: string;
};

export type RestGroupSnapshot = {
	id: string;
	name: string;
	daysOfWeek: number[];
};

export type RestContext = {
	/** RN-10.2. Del departamento de la persona; `false` si no tiene departamento. */
	restGroupsEnabled: boolean;
	/** Filas individuales de esta persona, en cualquier orden. */
	schedules: readonly RestScheduleRow[];
	/** Asignaciones de grupo de esta persona, en cualquier orden. */
	memberships: readonly RestMembershipRow[];
	/** Los grupos que esas asignaciones pueden referenciar, por id. */
	groupsById: Readonly<Record<string, RestGroupSnapshot>>;
};

export type RestResolution = {
	daysOfWeek: number[];
	source: RestSource;
	/** Desde cuándo rige la fila que ganó. Nulo si no había ninguna. */
	effectiveFrom: string | null;
	group: { id: string; name: string } | null;
};

/** Nadie descansa: el contexto de quien no tiene departamento ni filas. */
export const NO_REST_CONTEXT: RestContext = {
	restGroupsEnabled: false,
	schedules: [],
	memberships: [],
	groupsById: {},
};

const NO_REST_DAYS: RestResolution = {
	daysOfWeek: [],
	source: "none",
	effectiveFrom: null,
	group: null,
};

/**
 * RN-10.1 — La fila vigente en una fecha: la más reciente con `effective_from ≤
 * date`.
 *
 * Las fechas son `yyyy-MM-dd`, así que se comparan como cadenas y el orden
 * lexicográfico **es** el cronológico. Convertirlas a `Date` para compararlas
 * obligaría a elegir una zona horaria para algo que no es un instante (spec 07
 * §2).
 */
export function effectiveAt<T extends { effectiveFrom: string }>(
	rows: readonly T[],
	date: string,
): T | null {
	let winner: T | null = null;
	for (const row of rows) {
		if (row.effectiveFrom > date) continue;
		if (!winner || row.effectiveFrom > winner.effectiveFrom) winner = row;
	}
	return winner;
}

/** `resolveRestDays` de la spec 10 §6, en su forma pura. */
export function resolveRestDaysAt(
	context: RestContext,
	date: string,
): RestResolution {
	// RN-10.2 — Con los grupos activados no se mira la configuración individual, ni
	// como respaldo: si el departamento rota turnos y a alguien no se le ha
	// asignado grupo, la respuesta correcta es "sin descansos" (RN-10.3), que es la
	// que dispara el recordatorio. Caer a lo individual escondería el hueco.
	if (context.restGroupsEnabled) {
		const membership = effectiveAt(context.memberships, date);
		if (!membership?.groupId) return NO_REST_DAYS;

		const group = context.groupsById[membership.groupId];
		if (!group) return NO_REST_DAYS;

		return {
			daysOfWeek: group.daysOfWeek,
			source: "group",
			effectiveFrom: membership.effectiveFrom,
			group: { id: group.id, name: group.name },
		};
	}

	const schedule = effectiveAt(context.schedules, date);
	if (!schedule) return NO_REST_DAYS;

	return {
		daysOfWeek: schedule.daysOfWeek,
		source: "individual",
		effectiveFrom: schedule.effectiveFrom,
		group: null,
	};
}

/**
 * El predicado que consumen el marcaje (spec 09) y la agregación diaria (spec
 * 15): `isRestDay(workDate)`.
 *
 * Se resuelve **por fecha** y no una vez para todo el rango a propósito: en un
 * historial de un mes puede haber un cambio de configuración a mitad, y precalcular
 * un único conjunto de días daría el mismo resultado para el día 1 y para el 30.
 */
export function restDayPredicate(
	context: RestContext,
): (date: string) => boolean {
	return (date: string) =>
		isRestDate(resolveRestDaysAt(context, date).daysOfWeek, date);
}
