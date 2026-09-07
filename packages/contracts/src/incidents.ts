import {
	attendanceMarkSchema,
	createIncidentInputSchema,
	incidentContextSchema,
	incidentSchema,
	listIncidentsQuerySchema,
	ownBlockedMarksQuerySchema,
	pendingIncidentsCountQuerySchema,
	pendingIncidentsCountSchema,
	reviewIncidentInputSchema,
	reviewIncidentResultSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de incidencias de asistencia (spec 12 §7).
 *
 * Roles mínimos que aplica el backend:
 * - **listar las propias / reportar**: cualquier autenticado (RN-12.3, siempre
 *   sobre sí mismo — no hay parámetro de persona en ningún cuerpo ni en ninguna
 *   consulta).
 * - **la bandeja y el conteo con `scope=managed`**: `department_head` con ámbito
 *   sobre el departamento de quien reporta, o `global_manager` (RN-12.6).
 * - **revisar**: igual ámbito, y nunca la propia (RN-12.6).
 *
 * `GET /incidents` es un único endpoint con dos ámbitos por `?scope=`, como el
 * de vacaciones: `own` (default) y `managed`. Y `pending-count` acepta el mismo
 * `scope=` porque el badge del empleado y el del jefe cuentan la misma tabla con
 * distinto alcance (§6 y RN-05.8).
 *
 * `GET /incidents/:id/context` no está en la §7 y se añade por la §6, que pide
 * mostrar el contexto del día junto a cada incidencia de la bandeja: los
 * marcajes de ese día y su estado calculado. Va aparte de la lista para no
 * resolverlo en toda la bandeja cuando el revisor va a abrir una sola.
 */
export const incidentsSpec = {
	list: {
		method: "GET",
		path: "/api/incidents",
		query: listIncidentsQuerySchema,
		response: z.array(incidentSchema),
	},
	report: {
		method: "POST",
		path: "/api/incidents",
		body: createIncidentInputSchema,
		response: incidentSchema,
	},
	pendingCount: {
		method: "GET",
		path: "/api/incidents/pending-count",
		query: pendingIncidentsCountQuerySchema,
		response: pendingIncidentsCountSchema,
	},
	blockedMarks: {
		method: "GET",
		path: "/api/incidents/blocked-marks",
		query: ownBlockedMarksQuerySchema,
		response: z.array(attendanceMarkSchema),
	},
	context: {
		method: "GET",
		path: "/api/incidents/:id/context",
		response: incidentContextSchema,
	},
	review: {
		method: "POST",
		path: "/api/incidents/:id/review",
		body: reviewIncidentInputSchema,
		/**
		 * Devuelve la incidencia **y** el efecto sobre la ausencia del día, si se
		 * pidió justificarla en el mismo acto (spec 12 §9 decisión 1, cerrada con la
		 * spec 13). Sin eso, quien acaba de mover dinero no tendría cómo saberlo.
		 */
		response: reviewIncidentResultSchema,
	},
} as const;
