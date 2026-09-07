import {
	absenceReviewResultSchema,
	absenceReviewSchema,
	listAbsenceReviewsQuerySchema,
	pendingAbsenceSchema,
	pendingAbsencesCountSchema,
	pendingAbsencesQuerySchema,
	reviewAbsenceInputSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de justificación de ausencias (spec 13 §6).
 *
 * **Todos los endpoints exigen al menos `department_head`** y se acotan a su
 * ámbito (RN-13.3, RN-03.2). No hay ninguno de `scope=own`, al contrario que en
 * vacaciones e incidencias, y no es un olvido: aquí el empleado no inicia nada
 * (§2 de la [12](./12-incidencias.md)). Su ausencia clasificada le llega por dos
 * vías que ya existen — la notificación de RN-13.7 y el código `AJ`/`ANJ` sobre
 * el día en `GET /attendance/me`, que es donde ya mira su historial.
 *
 * `PUT /absences/:userId/:date` es un **upsert** (RN-13.2): revisar de nuevo el
 * mismo día sobrescribe la decisión y dispara la reversión o la creación del
 * ajuste de nómina. Es `PUT` y no `POST` justamente por eso — la clave del
 * recurso es (`userId`, `date`), la elige el cliente y la operación es
 * idempotente respecto al mismo cuerpo (RN-13.4).
 *
 * Ningún endpoint de nómina aparece aquí, y no hay ninguno en todo el proyecto:
 * la spec 17 no está construida. El efecto económico viaja **en la respuesta de
 * la revisión** (`payrollAdjustment`), que es lo que la §6 pide y lo único
 * compatible con RN-13.5 — quien justifica no tiene acceso a esa tabla.
 */
export const absencesSpec = {
	pending: {
		method: "GET",
		path: "/api/absences/pending",
		query: pendingAbsencesQuerySchema,
		response: z.array(pendingAbsenceSchema),
	},
	pendingCount: {
		method: "GET",
		path: "/api/absences/pending-count",
		query: pendingAbsencesQuerySchema,
		response: pendingAbsencesCountSchema,
	},
	list: {
		method: "GET",
		path: "/api/absences",
		query: listAbsenceReviewsQuerySchema,
		response: z.array(absenceReviewSchema),
	},
	review: {
		method: "PUT",
		path: "/api/absences/:userId/:date",
		body: reviewAbsenceInputSchema,
		response: absenceReviewResultSchema,
	},
} as const;
