import { z } from "zod";
import { isoDateSchema } from "./time.ts";

/**
 * Vacaciones (spec 11): saldo acumulado por días trabajados, solicitud,
 * revisión y su efecto en el marcaje y la reportería.
 *
 * Como en la spec 10, aquí vive el vocabulario y la **aritmética que comparten
 * servidor e interfaz**: cuántos días laborables consume un rango
 * (`countWorkableDays`, RN-11.5), si dos rangos se solapan (RN-11.6) y cómo se
 * lee el saldo (`computeBalance`, §2). Se escribe una vez o el consumo que
 * previsualiza el formulario y el que valida el servidor acaban discrepando.
 *
 * Modelo de acumulación, tal como lo describe la spec — **simple y deliberado**,
 * no una implementación de la legislación laboral cubana (decisión abierta 1,
 * sigue sin cerrarse: es de negocio, no técnica):
 *
 * ```
 * earned    = días_trabajados × vacation_days_per_worked_day   (spec 06 §3.4)
 * available = earned − aprobados − pendientes
 * ```
 *
 * Decisiones de la §9 que se cierran aquí:
 *
 * 2. **RN-11.5 — Sólo los días laborables del rango consumen saldo.** Un día no
 *    laborable o de descanso dentro del rango no se descuenta: la persona no
 *    iba a trabajar ese día de todas formas, y contarlo penalizaría el saldo por
 *    algo que no le costó nada. Es además la respuesta a la pregunta que dejaba
 *    abierta RN-15.1: un día de vacaciones que además era descanso **no
 *    consume**, aunque sí sale como `VACACIONES` en la presentación (spec 15
 *    §2, precedencia).
 * 4. **No se piden medios días.** `requested_days` es un entero desde el diseño
 *    de la tabla (§3); admitir medios días es un cambio de tipo que nadie ha
 *    pedido.
 * 5. **No hay caducidad.** El saldo es una cuenta corriente sin fecha de corte,
 *    como describe la fórmula del §2. Si la decisión 1 se cierra alguna vez a
 *    favor de cumplir la normativa cubana, la caducidad puede entrar entonces
 *    como parte de ese cambio, no antes.
 */

export const vacationStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"cancelled",
]);

/**
 * Techo del rango de una solicitud. No es una regla de negocio (la spec no fija
 * un máximo): es la misma cautela técnica que el rango del historial y del
 * calendario laboral (spec 07 y spec 09), para que una fecha mal tecleada no
 * genere una solicitud de miles de días.
 */
export const MAX_VACATION_REQUEST_DAYS = 366;

export const createVacationRequestInputSchema = z
	.object({
		startDate: isoDateSchema,
		endDate: isoDateSchema,
	})
	.refine(({ startDate, endDate }) => startDate <= endDate, {
		message:
			"El rango de fechas está invertido: el inicio es posterior al fin.",
	})
	.refine(
		({ startDate, endDate }) =>
			(Date.parse(`${endDate}T00:00:00.000Z`) -
				Date.parse(`${startDate}T00:00:00.000Z`)) /
				86_400_000 <=
			MAX_VACATION_REQUEST_DAYS,
		{ message: "Ese rango es demasiado largo para una sola solicitud." },
	);

/**
 * RN-11.10 — Rechazar exige comentario; aprobar no. Es la asimetría de la
 * spec: un rechazo sin motivo obliga a la persona a preguntar por qué, y una
 * aprobación no necesita explicarse.
 */
export const reviewVacationRequestInputSchema = z
	.object({
		approved: z.boolean(),
		comment: z.string().trim().max(500).optional(),
	})
	.refine((input) => input.approved || !!input.comment, {
		message: "Un rechazo necesita un comentario que explique el motivo.",
		path: ["comment"],
	});

export const vacationRequestSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	/** Resuelto para las listas por ámbito: quién pidió qué. */
	userFullName: z.string(),
	startDate: isoDateSchema,
	endDate: isoDateSchema,
	/** Congelado al crear (RN-11.13): un cambio de horario después no lo recalcula. */
	requestedDays: z.number().int().nonnegative(),
	status: vacationStatusSchema,
	reviewComment: z.string().nullable(),
	reviewedBy: z.uuid().nullable(),
	reviewedAt: z.iso.datetime().nullable(),
	cancelledBy: z.uuid().nullable(),
	cancelledAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * `GET /vacations/requests?status=&scope=`.
 *
 * `scope` decide **de quién** son las solicitudes, no `departmentId` por sí
 * solo: sin `scope=managed`, el endpoint siempre devuelve las propias —
 * el mismo criterio que `/attendance/me`, sin parámetro de persona posible.
 * `scope=managed` es la bandeja de un `department_head` o `global_manager`
 * sobre su ámbito (RN-03.2), y `departmentId` la acota a un departamento
 * concreto dentro de ese ámbito.
 */
export const listVacationRequestsQuerySchema = z.object({
	status: vacationStatusSchema.optional(),
	scope: z.enum(["own", "managed"]).default("own"),
	departmentId: z.uuid().optional(),
});

/**
 * El saldo (§2), ya resuelto. `available` puede ser fraccionario —la tasa lo
 * es— y se redondea a dos decimales, lo bastante fino para no perder un día de
 * ocho horas y lo bastante grueso para no enseñar el error de coma flotante.
 *
 * **No lleva `canRequest`.** Es tentador añadirlo —"¿puede esta persona pedir
 * vacaciones?"—, pero contestarlo exige el rol de **a quién pertenece el
 * saldo**, y este sistema sólo conoce roles ajenos al propio mientras esa
 * persona esté autenticada (RN-00.43): no hay tabla local de roles con la que
 * resolverlo para un perfil cualquiera (ver la nota de cabecera de
 * `services/vacations.ts`). Para el saldo **propio** el rol ya lo tiene quien
 * pregunta, en su propia sesión — `roleCanMark(session.effectiveRole)` —, así
 * que añadir el campo aquí sólo duplicaría un dato que el cliente ya tiene y
 * fingiría resolverlo también para el ajeno, que es donde no se puede.
 */
export const vacationBalanceSchema = z.object({
	userId: z.uuid(),
	earned: z.number(),
	used: z.number(),
	pending: z.number(),
	available: z.number(),
});

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** §2, en una sola función para que servidor e interfaz lean el mismo número. */
export function computeBalance(input: {
	earnedDays: number;
	approvedDays: number;
	pendingDays: number;
}): { earned: number; used: number; pending: number; available: number } {
	const earned = round2(input.earnedDays);
	const used = round2(input.approvedDays);
	const pending = round2(input.pendingDays);
	return { earned, used, pending, available: round2(earned - used - pending) };
}

/** RN-11.6 — Dos rangos inclusivos se solapan si ninguno termina antes de que empiece el otro. */
export function rangesOverlap(
	a: { startDate: string; endDate: string },
	b: { startDate: string; endDate: string },
): boolean {
	return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/**
 * RN-11.5 — Cuántos días del rango consumen saldo: los laborables que además no
 * son descanso. `dates` son las fechas `yyyy-MM-dd` del rango, inclusive en los
 * dos extremos.
 *
 * Es la misma pregunta que resuelve `computeDailyStatus` para clasificar un día
 * —¿es laborable?, ¿es descanso?— pero mirando hacia adelante en vez de hacia
 * atrás: aquí no hay marcas que consultar, sólo el calendario y los descansos.
 */
export function countWorkableDays(
	dates: readonly string[],
	isWorkday: (date: string) => boolean,
	isRestDay: (date: string) => boolean,
): number {
	let count = 0;
	for (const date of dates) {
		if (isWorkday(date) && !isRestDay(date)) count += 1;
	}
	return count;
}

export type VacationStatus = z.infer<typeof vacationStatusSchema>;
export type VacationRequest = z.infer<typeof vacationRequestSchema>;
export type CreateVacationRequestInput = z.infer<
	typeof createVacationRequestInputSchema
>;
export type ReviewVacationRequestInput = z.infer<
	typeof reviewVacationRequestInputSchema
>;
export type ListVacationRequestsQuery = z.infer<
	typeof listVacationRequestsQuerySchema
>;
export type VacationBalance = z.infer<typeof vacationBalanceSchema>;
