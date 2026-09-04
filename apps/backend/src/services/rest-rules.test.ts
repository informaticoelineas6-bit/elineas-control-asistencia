import { describe, expect, test } from "bun:test";
import {
	DAY_OF_WEEK_NAMES,
	dayOfWeekOf,
	describeRestDays,
	isRestDate,
	restCountIssue,
	restDaysIssue,
	restSeparationIssue,
	weekdayDistance,
} from "@elineas/validations";
import {
	effectiveAt,
	NO_REST_CONTEXT,
	type RestContext,
	resolveRestDaysAt,
	restDayPredicate,
} from "#/services/rest-rules.ts";

/**
 * Pruebas de la resolución de descansos (spec 10).
 *
 * Es la función que el marcaje, la agregación diaria y la reportería comparten, y
 * la spec insiste en que sea **una sola implementación**. Por eso se prueba aquí,
 * en puro y exhaustivo, y las pruebas de ruta sólo comprueban que esté conectada.
 *
 * Las fechas de referencia, para no tener que contar días de cabeza:
 *
 * | fecha | día |
 * |---|---|
 * | 2026-08-16 | domingo (0) |
 * | 2026-08-17 | lunes (1) |
 * | 2026-08-18 | martes (2) |
 * | 2026-08-19 | miércoles (3) |
 * | 2026-08-20 | jueves (4) |
 * | 2026-08-21 | viernes (5) |
 * | 2026-08-22 | sábado (6) |
 */

const SUNDAY = "2026-08-16";
const MONDAY = "2026-08-17";
const TUESDAY = "2026-08-18";
const WEDNESDAY = "2026-08-19";
const THURSDAY = "2026-08-20";
const SATURDAY = "2026-08-22";

function context(overrides: Partial<RestContext> = {}): RestContext {
	return { ...NO_REST_CONTEXT, ...overrides };
}

describe("convención de días (decisión 1 de la §9)", () => {
	test("0 es domingo y 6 es sábado, como getDay() y extract(dow)", () => {
		expect(dayOfWeekOf(SUNDAY)).toBe(0);
		expect(dayOfWeekOf(MONDAY)).toBe(1);
		expect(dayOfWeekOf(SATURDAY)).toBe(6);
		expect(DAY_OF_WEEK_NAMES[0]).toBe("domingo");
		expect(DAY_OF_WEEK_NAMES[6]).toBe("sábado");
	});

	/**
	 * La fecha civil se ancla en UTC: si se interpretara en la zona del proceso, el
	 * día de la semana cambiaría según dónde corra el servidor y los descansos se
	 * correrían un día en producción sin fallar ninguna prueba local.
	 */
	test("una fecha civil da el mismo día en cualquier zona del proceso", () => {
		const previous = process.env.TZ;
		try {
			process.env.TZ = "Pacific/Kiritimati";
			expect(dayOfWeekOf(SUNDAY)).toBe(0);
			process.env.TZ = "Pacific/Niue";
			expect(dayOfWeekOf(SUNDAY)).toBe(0);
		} finally {
			process.env.TZ = previous;
		}
	});

	test("isRestDate mira el día de la semana, no la fecha", () => {
		expect(isRestDate([0, 3], WEDNESDAY)).toBe(true);
		expect(isRestDate([0, 3], THURSDAY)).toBe(false);
		expect(isRestDate([], WEDNESDAY)).toBe(false);
	});
});

describe("RN-10.1 — vigencia por fecha", () => {
	const rows = [
		{ effectiveFrom: "2026-08-01", daysOfWeek: [0] },
		{ effectiveFrom: "2026-09-01", daysOfWeek: [3] },
	];

	test("gana la fila más reciente con effective_from ≤ fecha", () => {
		expect(effectiveAt(rows, "2026-08-15")?.daysOfWeek).toEqual([0]);
		expect(effectiveAt(rows, "2026-09-01")?.daysOfWeek).toEqual([3]);
		expect(effectiveAt(rows, "2026-12-31")?.daysOfWeek).toEqual([3]);
	});

	test("antes de la primera vigencia no hay fila", () => {
		expect(effectiveAt(rows, "2026-07-31")).toBeNull();
	});

	/**
	 * El criterio de aceptación de la §8: cambiar los descansos con `effective_from`
	 * futuro **no altera el reporte del mes pasado**. Es la razón de ser de la
	 * columna, así que se prueba como tal y no sólo a través de `effectiveAt`.
	 */
	test("una vigencia futura no toca el pasado", () => {
		const resolver = restDayPredicate(
			context({
				schedules: [
					{ effectiveFrom: "2026-08-01", daysOfWeek: [0] },
					{ effectiveFrom: "2026-09-01", daysOfWeek: [3] },
				],
			}),
		);

		// Agosto sigue descansando domingos, no miércoles.
		expect(resolver(SUNDAY)).toBe(true);
		expect(resolver(WEDNESDAY)).toBe(false);
		// Y en septiembre manda la nueva.
		expect(resolver("2026-09-02")).toBe(true);
		expect(resolver("2026-09-06")).toBe(false);
	});

	test("el orden en que llegan las filas no cambia el resultado", () => {
		const reversed = [...rows].reverse();
		expect(effectiveAt(reversed, "2026-08-15")?.daysOfWeek).toEqual([0]);
	});
});

describe("RN-10.2 — precedencia de los grupos", () => {
	const withBoth = context({
		restGroupsEnabled: true,
		schedules: [{ effectiveFrom: "2026-01-01", daysOfWeek: [0] }],
		memberships: [{ effectiveFrom: "2026-01-01", groupId: "a" }],
		groupsById: { a: { id: "a", name: "Grupo A", daysOfWeek: [3] } },
	});

	test("con grupos activados manda el grupo y lo individual se ignora", () => {
		const resolution = resolveRestDaysAt(withBoth, WEDNESDAY);
		expect(resolution.source).toBe("group");
		expect(resolution.daysOfWeek).toEqual([3]);
		expect(resolution.group).toEqual({ id: "a", name: "Grupo A" });
	});

	test("apagar el interruptor devuelve la configuración individual intacta", () => {
		const resolution = resolveRestDaysAt(
			{ ...withBoth, restGroupsEnabled: false },
			SUNDAY,
		);
		expect(resolution.source).toBe("individual");
		expect(resolution.daysOfWeek).toEqual([0]);
	});

	/**
	 * Sin grupo asignado la respuesta es "sin descansos", no la configuración
	 * individual: caer a lo individual escondería el hueco que RN-10.10 tiene que
	 * recordar.
	 */
	test("con grupos activados y sin asignación, no hay descansos", () => {
		const resolution = resolveRestDaysAt(
			{ ...withBoth, memberships: [] },
			SUNDAY,
		);
		expect(resolution.source).toBe("none");
		expect(resolution.daysOfWeek).toEqual([]);
	});

	test("la fila con group_id nulo saca a la persona del grupo en esa fecha", () => {
		const resolver = restDayPredicate({
			...withBoth,
			memberships: [
				{ effectiveFrom: "2026-08-01", groupId: "a" },
				{ effectiveFrom: "2026-08-20", groupId: null },
			],
		});

		expect(resolver(WEDNESDAY)).toBe(true);
		expect(resolver("2026-08-26")).toBe(false);
	});

	test("una asignación a un grupo desconocido no inventa descansos", () => {
		const resolution = resolveRestDaysAt(
			{ ...withBoth, groupsById: {} },
			WEDNESDAY,
		);
		expect(resolution.source).toBe("none");
	});
});

describe("RN-10.3 — sin configuración no hay descansos", () => {
	test("ninguna fila vigente: se exigen todos los días laborables", () => {
		const resolver = restDayPredicate(NO_REST_CONTEXT);
		for (const date of [SUNDAY, MONDAY, TUESDAY, WEDNESDAY, SATURDAY]) {
			expect(resolver(date)).toBe(false);
		}
	});
});

describe("RN-10.5 — separación mínima", () => {
	test("0 desactiva la regla", () => {
		expect(restSeparationIssue([1, 2, 3], 0)).toBeNull();
	});

	test("rechaza dos descansos consecutivos con separación 2", () => {
		const issue = restSeparationIssue([2, 3], 2);
		expect(issue).toContain("martes");
		expect(issue).toContain("miércoles");
		expect(issue).toContain("2 días de separación");
	});

	test("acepta martes y jueves con separación 2", () => {
		expect(restSeparationIssue([2, 4], 2)).toBeNull();
	});

	/**
	 * La distancia es circular: sábado y domingo están a un día. Medirla en línea
	 * recta daría 6 y dejaría pasar justo el caso que la regla quiere evitar.
	 */
	test("la semana es circular: sábado y domingo están a un día", () => {
		expect(weekdayDistance(6, 0)).toBe(1);
		expect(restSeparationIssue([0, 6], 2)).not.toBeNull();
	});

	test("un solo descanso nunca incumple la separación", () => {
		expect(restSeparationIssue([3], 7)).toBeNull();
	});
});

describe("RN-10.9 — número de descansos por semana", () => {
	test("los defaults (0 y 7) no excluyen ningún conjunto", () => {
		const limits = { minPerWeek: 0, maxPerWeek: 7 };
		expect(restCountIssue([], limits)).toBeNull();
		expect(restCountIssue([0, 1, 2, 3, 4, 5, 6], limits)).toBeNull();
	});

	test("mínimo configurado: rechaza quedarse corto", () => {
		expect(restCountIssue([0], { minPerWeek: 2, maxPerWeek: 7 })).toContain(
			"al menos 2",
		);
	});

	test("máximo configurado: rechaza pasarse", () => {
		expect(
			restCountIssue([0, 3, 5], { minPerWeek: 0, maxPerWeek: 2 }),
		).toContain("más de 2");
	});
});

describe("restDaysIssue — el orden en que se leen los avisos", () => {
	/**
	 * El número va antes que la separación a propósito: si alguien eligió cuatro
	 * días con un máximo de dos, decirle primero que dos de ellos están juntos le
	 * hace corregir algo que va a tener que deshacer.
	 */
	test("el número manda sobre la separación", () => {
		const issue = restDaysIssue([1, 2, 3, 4], {
			minSeparationDays: 2,
			minPerWeek: 0,
			maxPerWeek: 2,
		});
		expect(issue).toContain("más de 2");
	});

	test("sin problemas devuelve null", () => {
		expect(
			restDaysIssue([0, 3], {
				minSeparationDays: 2,
				minPerWeek: 1,
				maxPerWeek: 2,
			}),
		).toBeNull();
	});
});

describe("describeRestDays", () => {
	test("enumera en el orden en que se pinta la semana, lunes primero", () => {
		expect(describeRestDays([0, 3])).toBe("miércoles y domingo");
		expect(describeRestDays([3])).toBe("miércoles");
		expect(describeRestDays([])).toBe("ninguno");
		expect(describeRestDays([1, 4, 6])).toBe("lunes, jueves y sábado");
	});
});
