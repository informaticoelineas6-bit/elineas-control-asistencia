import { z } from "zod";
import { departmentScopeSchema } from "./roles.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Descansos (spec 10): qué días de la semana **no** trabaja cada persona.
 *
 * Aquí vive el vocabulario y, como en la spec 07, la **aritmética que necesitan
 * por igual el servidor y el formulario**: si un día es descanso, si un conjunto
 * de días respeta la separación mínima y cuántos descansos tiene una semana. Se
 * escribe una vez o el aviso en vivo del selector y el 400 del servidor acaban
 * discrepando (RN-10.5 exige las dos validaciones, y que digan lo mismo).
 *
 * Decisiones de la §9 que se cierran aquí, para no volver a discutirlas leyendo
 * el código:
 *
 * 1. **`days_of_week` es 0 = domingo … 6 = sábado** (decisión 1). Es la
 *    convención de `Date.prototype.getDay()` en JavaScript y la de
 *    `extract(dow from …)` en PostgreSQL, que son los dos motores por los que
 *    pasa el dato. Cualquier otra obliga a convertir en cada frontera y la
 *    conversión que alguien olvide corre los descansos un día. Que la semana se
 *    **pinte** empezando en lunes (Cuba, `WEEK_STARTS_ON`) es cosa de la
 *    interfaz, no del almacenamiento.
 * 2. **La lista vacía de `rest_days_min_separation_departments` significa
 *    "todos"** (decisión 2). `rest_days_min_separation` es el interruptor —0
 *    desactiva la regla— y la lista sólo la **acota**. Con el criterio contrario
 *    habría dos formas de decir "a nadie" y ninguna de decir "a todos" sin
 *    enumerar los departamentos y acordarse de añadir cada uno nuevo; y poner el
 *    número sin la lista dejaría una regla configurada que no hace nada, que es
 *    el fallo que nadie nota.
 * 3. **Mínimo y máximo de descansos por semana son configuración**, no un número
 *    escrito en el código (decisión 3): `rest_days_min_per_week` y
 *    `rest_days_max_per_week` en la spec 06, con los defaults que dejan la regla
 *    inerte (0 y 7). La cifra es laboral y la pone el negocio, pero el sitio
 *    donde ponerla tiene que existir ya.
 * 4. **El empleado elige sus descansos, no los propone** (§4). Es lo que hacía
 *    el legacy, con RN-10.5 y RN-10.6 como único freno, y las dos se validan en
 *    servidor. Un flujo de aprobación es otra funcionalidad —estados,
 *    notificaciones, pantalla de pendientes— que nadie ha pedido.
 */

// ── Días de la semana ─────────────────────────────────────────────────────────

/** 0 = domingo … 6 = sábado (decisión 1). */
export const dayOfWeekSchema = z
	.number()
	.int()
	.min(0, "El día de la semana va de 0 (domingo) a 6 (sábado)")
	.max(6, "El día de la semana va de 0 (domingo) a 6 (sábado)");

export const DAYS_IN_WEEK = 7;

/** Nombres en español, indexados por la convención de arriba. */
export const DAY_OF_WEEK_NAMES = [
	"domingo",
	"lunes",
	"martes",
	"miércoles",
	"jueves",
	"viernes",
	"sábado",
] as const;

/** Abreviaturas para cabeceras y botones, donde el ancho importa. */
export const DAY_OF_WEEK_SHORT_NAMES = [
	"Dom",
	"Lun",
	"Mar",
	"Mié",
	"Jue",
	"Vie",
	"Sáb",
] as const;

/**
 * Los siete días **en el orden en que se pintan** en Cuba: lunes primero
 * (`WEEK_STARTS_ON` de la interfaz), con su índice de almacenamiento intacto.
 *
 * Existe para que ninguna pantalla vuelva a escribir la lista a mano —el editor
 * del calendario laboral ya tenía la suya— y para que reordenar la presentación
 * no toque nunca la convención de los datos.
 */
export const DAYS_OF_WEEK_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Conjunto de días tal como sale de la API: sin repetidos y ordenado. */
export const daysOfWeekSchema = z.array(dayOfWeekSchema).max(DAYS_IN_WEEK);

/**
 * El mismo conjunto **de entrada**, normalizado: se quitan repetidos y se ordena.
 * Guardar `[3, 0, 3]` y `[0, 3]` como filas distintas haría que dos
 * configuraciones idénticas no se reconozcan como iguales al comparar.
 */
export const daysOfWeekInputSchema = daysOfWeekSchema.transform((days) =>
	[...new Set(days)].sort((a, b) => a - b),
);

/**
 * Día de la semana de una fecha `yyyy-MM-dd`.
 *
 * Se ancla en UTC a propósito: una fecha civil no es un instante (spec 07 §2), y
 * dejar que el motor la interprete en la zona del proceso es lo que hace que un
 * descanso se corra un día según dónde corra el servidor.
 */
export function dayOfWeekOf(date: string): number {
	return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** RN-10.4 — ¿Esa fecha cae en uno de esos días de descanso? */
export function isRestDate(
	daysOfWeek: readonly number[],
	date: string,
): boolean {
	return daysOfWeek.includes(dayOfWeekOf(date));
}

// ── Reglas sobre el conjunto de días ──────────────────────────────────────────

/**
 * Distancia entre dos días de la semana **en el ciclo semanal**, que es circular:
 * sábado y domingo están a un día, no a seis. Sin esto, descansar sábado y
 * domingo pasaría cualquier separación mínima justo en el caso que la regla
 * quiere evitar.
 */
export function weekdayDistance(a: number, b: number): number {
	const straight = Math.abs(a - b);
	return Math.min(straight, DAYS_IN_WEEK - straight);
}

/** Los límites vigentes que se aplican a una persona (spec 06 §3.3). */
export type RestLimits = {
	/** RN-10.5. 0 = regla desactivada. */
	minSeparationDays: number;
	/** RN-10.9. 0 = sin mínimo. */
	minPerWeek: number;
	/** RN-10.9. 7 = sin máximo. */
	maxPerWeek: number;
};

/**
 * RN-10.5 — Separación mínima entre dos descansos de la misma persona.
 *
 * Devuelve el primer par que la incumple, con los dos días por su nombre: un
 * "configuración inválida" a secas obliga a probar combinaciones hasta acertar.
 */
export function restSeparationIssue(
	daysOfWeek: readonly number[],
	minSeparationDays: number,
): string | null {
	if (minSeparationDays <= 0) return null;

	const days = [...daysOfWeek].sort((a, b) => a - b);
	for (const [index, day] of days.entries()) {
		for (const other of days.slice(index + 1)) {
			const distance = weekdayDistance(day, other);
			if (distance < minSeparationDays) {
				return `No puedes descansar ${DAY_OF_WEEK_NAMES[day]} y ${DAY_OF_WEEK_NAMES[other]}: se exigen ${minSeparationDays} ${minSeparationDays === 1 ? "día" : "días"} de separación entre descansos.`;
			}
		}
	}
	return null;
}

/** RN-10.9 — Cuántos descansos admite una semana. */
export function restCountIssue(
	daysOfWeek: readonly number[],
	limits: Pick<RestLimits, "minPerWeek" | "maxPerWeek">,
): string | null {
	const count = new Set(daysOfWeek).size;

	if (count < limits.minPerWeek) {
		return `Hacen falta al menos ${limits.minPerWeek} ${limits.minPerWeek === 1 ? "día" : "días"} de descanso a la semana.`;
	}
	if (count > limits.maxPerWeek) {
		return `No se admiten más de ${limits.maxPerWeek} ${limits.maxPerWeek === 1 ? "día" : "días"} de descanso a la semana.`;
	}
	return null;
}

/**
 * Todas las reglas del conjunto de una vez, en el orden en que conviene leerlas.
 * Es la función que llaman el selector del empleado y el handler: una sola
 * implementación, para que el aviso en vivo y el rechazo del servidor coincidan
 * palabra por palabra.
 */
export function restDaysIssue(
	daysOfWeek: readonly number[],
	limits: RestLimits,
): string | null {
	return (
		restCountIssue(daysOfWeek, limits) ??
		restSeparationIssue(daysOfWeek, limits.minSeparationDays)
	);
}

/** "domingo y jueves" / "martes" / "ninguno". Para mensajes y para la interfaz. */
export function describeRestDays(daysOfWeek: readonly number[]): string {
	const names = DAYS_OF_WEEK_DISPLAY_ORDER.filter((day) =>
		daysOfWeek.includes(day),
	).map((day) => DAY_OF_WEEK_NAMES[day]);

	if (names.length === 0) return "ninguno";
	if (names.length === 1) return names[0] as string;
	return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
}

// ── Esquemas ──────────────────────────────────────────────────────────────────

/** De dónde salen los descansos que aplican a una persona (RN-10.2). */
export const restSourceSchema = z.enum([
	/** Su propia configuración (`user_rest_schedule`). */
	"individual",
	/** El grupo del departamento al que pertenece. */
	"group",
	/** No hay ninguna fila vigente: no tiene descansos (RN-10.3). */
	"none",
]);

/** Una fila de `user_rest_schedule`. */
export const restScheduleSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	daysOfWeek: daysOfWeekSchema,
	/** Desde cuándo rige esta configuración (RN-10.1). */
	effectiveFrom: isoDateSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export const restGroupMemberSchema = z.object({
	userId: z.uuid(),
	fullName: z.string(),
	/** Desde cuándo pertenece al grupo (RN-10.1). */
	effectiveFrom: isoDateSchema,
});

export const restGroupSchema = z.object({
	id: z.uuid(),
	departmentId: z.uuid(),
	name: z.string(),
	daysOfWeek: daysOfWeekSchema,
	/**
	 * Un grupo con historial no se borra, se desactiva — mismo criterio que las
	 * sedes (RN-08.10) y misma razón: los reportes de meses pasados necesitan
	 * seguir sabiendo con qué días descansaba su gente.
	 */
	isActive: z.boolean(),
	/** Miembros **vigentes hoy**, ya resueltos por RN-10.1. */
	members: z.array(restGroupMemberSchema),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * Los descansos de una persona **resueltos para una fecha**: la respuesta de
 * `resolveRestDays` (spec 10 §6) tal como viaja por la API.
 */
export const resolvedRestScheduleSchema = z.object({
	userId: z.uuid(),
	/** Fecha para la que se resolvió. */
	date: isoDateSchema,
	daysOfWeek: daysOfWeekSchema,
	source: restSourceSchema,
	/** Desde cuándo rige la fila que ganó. Nulo si no había ninguna (RN-10.3). */
	effectiveFrom: isoDateSchema.nullable(),
	/** El grupo que manda, si el departamento los tiene activados (RN-10.2). */
	group: z.object({ id: z.uuid(), name: z.string() }).nullable(),
	restGroupsEnabled: z.boolean(),
	/** `true` si `date` es descanso de esta persona (RN-10.4). */
	isRestDay: z.boolean(),
});

export const restLimitsSchema = z.object({
	/** RN-10.5, ya acotada al departamento de la persona. 0 = desactivada. */
	minSeparationDays: z.number().int().nonnegative(),
	minPerWeek: z.number().int().nonnegative(),
	maxPerWeek: z.number().int().nonnegative(),
});

/**
 * Lo que devuelven `GET /me/rest-schedule` y `GET /users/:id/rest-schedule`.
 *
 * Incluye los límites vigentes porque el selector tiene que poder avisar **antes**
 * de guardar con la misma regla que va a aplicar el servidor (§7), y el suelo de
 * `effective_from` porque RN-10.7 lo mide contra hoy **en la zona del
 * departamento** (RN-07.2), no en la del navegador.
 */
export const restScheduleViewSchema = z.object({
	resolved: resolvedRestScheduleSchema,
	/** Configuraciones individuales de esta persona, la más reciente primero. */
	schedules: z.array(restScheduleSchema),
	limits: restLimitsSchema,
	/**
	 * `false` cuando manda el grupo (RN-10.2) o cuando quien pregunta no puede
	 * escribir: el selector se pinta igual, en modo lectura, porque saber qué días
	 * descansas es útil aunque no puedas cambiarlos.
	 */
	canEdit: z.boolean(),
	/** `true` si quien pide puede fechar hacia atrás (RN-10.7). */
	canBackdate: z.boolean(),
	department: departmentScopeSchema.nullable(),
	/** Hoy en la zona del departamento: el suelo de `effective_from` (RN-10.7). */
	today: isoDateSchema,
});

/** Quién descansa cada día de un rango, para el calendario del equipo (§7). */
export const departmentRestDaysSchema = z.object({
	departmentId: z.uuid(),
	restGroupsEnabled: z.boolean(),
	from: isoDateSchema,
	to: isoDateSchema,
	days: z.array(
		z.object({
			date: isoDateSchema,
			people: z.array(
				z.object({
					userId: z.uuid(),
					fullName: z.string(),
					source: restSourceSchema,
					groupName: z.string().nullable(),
				}),
			),
		}),
	),
	/** Miembros activos sin ningún descanso vigente: los que dispara RN-10.10. */
	withoutRestDays: z.array(
		z.object({ userId: z.uuid(), fullName: z.string() }),
	),
});

// ── Entradas ──────────────────────────────────────────────────────────────────

/**
 * `PUT` de la configuración individual. Describe el resultado completo, no un
 * parche: el cuerpo son los días que se descansan a partir de `effectiveFrom`.
 *
 * `effectiveFrom` es opcional y por omisión es **hoy en la zona del
 * departamento**, que es lo que quiere quien cambia sus descansos ahora mismo y
 * lo único que RN-10.7 le permite sin rol administrativo.
 */
export const updateRestScheduleInputSchema = z.object({
	daysOfWeek: daysOfWeekInputSchema,
	effectiveFrom: isoDateSchema.optional(),
});

const restGroupNameSchema = z
	.string()
	.trim()
	.min(1, "El grupo necesita un nombre")
	.max(60, "El nombre del grupo es demasiado largo");

export const createRestGroupInputSchema = z.object({
	name: restGroupNameSchema,
	daysOfWeek: daysOfWeekInputSchema,
});

export const updateRestGroupInputSchema = z
	.object({
		name: restGroupNameSchema.optional(),
		daysOfWeek: daysOfWeekInputSchema.optional(),
		isActive: z.boolean().optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "No hay nada que cambiar en el grupo",
	});

/**
 * `PUT` de los miembros de un grupo: **reemplazo**, no añadido. El cuerpo dice
 * quiénes son los miembros del grupo a partir de `effectiveFrom`, y quien deja de
 * estar en la lista sale del grupo **en esa fecha** — no se le borra el pasado,
 * que es lo que RN-10.1 necesita para que los reportes viejos sigan cuadrando.
 */
export const updateRestGroupMembersInputSchema = z.object({
	userIds: z
		.array(z.uuid("El identificador de perfil no es válido."))
		.max(500, "Demasiadas personas en una sola operación"),
	effectiveFrom: isoDateSchema.optional(),
});

/** `?date=`: para qué fecha se resuelven. Sin ella, hoy. */
export const restScheduleQuerySchema = z.object({
	date: isoDateSchema.optional(),
});

/** `?from=&to=`, ambos inclusive, como el calendario laboral (spec 07). */
export const restDaysRangeQuerySchema = z
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
			92,
		{ message: "El rango no puede pasar de tres meses." },
	);

export type DayOfWeek = z.infer<typeof dayOfWeekSchema>;
export type RestSource = z.infer<typeof restSourceSchema>;
export type RestSchedule = z.infer<typeof restScheduleSchema>;
export type RestGroup = z.infer<typeof restGroupSchema>;
export type RestGroupMember = z.infer<typeof restGroupMemberSchema>;
export type ResolvedRestSchedule = z.infer<typeof resolvedRestScheduleSchema>;
export type RestScheduleView = z.infer<typeof restScheduleViewSchema>;
export type DepartmentRestDays = z.infer<typeof departmentRestDaysSchema>;
export type UpdateRestScheduleInput = z.infer<
	typeof updateRestScheduleInputSchema
>;
export type CreateRestGroupInput = z.infer<typeof createRestGroupInputSchema>;
export type UpdateRestGroupInput = z.infer<typeof updateRestGroupInputSchema>;
export type UpdateRestGroupMembersInput = z.infer<
	typeof updateRestGroupMembersInputSchema
>;
export type RestScheduleQuery = z.infer<typeof restScheduleQuerySchema>;
export type RestDaysRangeQuery = z.infer<typeof restDaysRangeQuerySchema>;
