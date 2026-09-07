import { describe, expect, test } from "bun:test";
import {
	CRITICAL_INCIDENT_TYPES,
	createIncidentInputSchema,
	INCIDENT_TYPE_LABELS,
	incidentDateIssue,
	incidentRequiresReason,
	incidentTypeSchema,
	reviewIncidentInputSchema,
} from "@elineas/validations";

/**
 * Pruebas de las reglas puras de incidencias (spec 12 RN-12.1, RN-12.3, RN-12.4,
 * RN-12.7), igual que `vacation-rules.test.ts` para la spec 11. La autorización,
 * el ámbito de la bandeja y RN-12.5 —que vive en un índice— se prueban con la
 * base delante en `routes/incidents.test.ts`.
 */

describe("RN-12.1 — motivo obligatorio según el tipo", () => {
	test("los tres tipos críticos de la §4 lo exigen", () => {
		expect([...CRITICAL_INCIDENT_TYPES]).toEqual([
			"forgot_to_mark",
			"late_arrival",
			"early_departure",
		]);
		for (const type of CRITICAL_INCIDENT_TYPES) {
			expect(incidentRequiresReason(type)).toBe(true);
		}
	});

	test("los técnicos no, porque el sistema ya tiene la evidencia", () => {
		expect(incidentRequiresReason("gps_issue")).toBe(false);
		expect(incidentRequiresReason("geofence_issue")).toBe(false);
	});

	test("un tipo crítico sin motivo no valida", () => {
		const result = createIncidentInputSchema.safeParse({
			incidentType: "forgot_to_mark",
			date: "2026-09-01",
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues.at(0)?.path).toEqual(["reason"]);
	});

	test("un motivo de sólo espacios cuenta como vacío", () => {
		expect(
			createIncidentInputSchema.safeParse({
				incidentType: "late_arrival",
				date: "2026-09-01",
				reason: "   ",
			}).success,
		).toBe(false);
	});

	test("un tipo técnico sin motivo sí valida, con motivo vacío y sin marca", () => {
		const result = createIncidentInputSchema.safeParse({
			incidentType: "gps_issue",
			date: "2026-09-01",
		});
		expect(result.success).toBe(true);
		expect(result.data).toEqual({
			incidentType: "gps_issue",
			date: "2026-09-01",
			reason: "",
			attendanceMarkId: null,
		});
	});

	test("cada tipo del vocabulario tiene etiqueta en español", () => {
		for (const type of incidentTypeSchema.options) {
			expect(INCIDENT_TYPE_LABELS[type]).toBeTruthy();
		}
	});
});

describe("RN-12.3 y RN-12.4 — qué fechas se admiten", () => {
	const TODAY = "2026-09-07";

	test("hoy se admite", () => {
		expect(
			incidentDateIssue({ date: TODAY, today: TODAY, windowDays: 0 }),
		).toBeNull();
	});

	test("mañana no: una incidencia describe algo que ya pasó (RN-12.3)", () => {
		expect(
			incidentDateIssue({ date: "2026-09-08", today: TODAY, windowDays: 0 }),
		).toContain("ya pasó");
	});

	test("con plazo 0 la regla está desactivada, por muy vieja que sea la fecha", () => {
		expect(
			incidentDateIssue({ date: "2020-01-01", today: TODAY, windowDays: 0 }),
		).toBeNull();
	});

	test("el plazo es inclusivo en su último día", () => {
		// 7 días atrás con plazo de 7: entra justo.
		expect(
			incidentDateIssue({ date: "2026-08-31", today: TODAY, windowDays: 7 }),
		).toBeNull();
		// 8 días atrás: fuera.
		expect(
			incidentDateIssue({ date: "2026-08-30", today: TODAY, windowDays: 7 }),
		).toContain("plazo");
	});

	test("el mensaje del plazo dice la cifra, y la singulariza", () => {
		expect(
			incidentDateIssue({ date: "2026-09-05", today: TODAY, windowDays: 1 }),
		).toContain("de 1 día");
		expect(
			incidentDateIssue({ date: "2026-08-01", today: TODAY, windowDays: 3 }),
		).toContain("de 3 días");
	});

	test("una fecha futura se rechaza por RN-12.3 antes de mirar el plazo", () => {
		// Con plazo activo, el motivo tiene que seguir siendo el de la fecha
		// futura: decirle "fuera de plazo" a quien pide mañana no explica nada.
		expect(
			incidentDateIssue({ date: "2026-12-31", today: TODAY, windowDays: 7 }),
		).toContain("ya pasó");
	});
});

describe("RN-12.7 — la asimetría de la revisión", () => {
	test("aprobar no exige notas", () => {
		expect(
			reviewIncidentInputSchema.safeParse({ approved: true }).success,
		).toBe(true);
	});

	test("rechazar sin notas falla, y el error apunta al campo", () => {
		const result = reviewIncidentInputSchema.safeParse({ approved: false });
		expect(result.success).toBe(false);
		expect(result.error?.issues.at(0)?.path).toEqual(["notes"]);
	});

	test("rechazar con notas de sólo espacios también falla", () => {
		expect(
			reviewIncidentInputSchema.safeParse({ approved: false, notes: "  " })
				.success,
		).toBe(false);
	});

	test("rechazar con notas pasa", () => {
		expect(
			reviewIncidentInputSchema.safeParse({
				approved: false,
				notes: "El registro de la puerta no coincide con lo que reportas.",
			}).success,
		).toBe(true);
	});
});
