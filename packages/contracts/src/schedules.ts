import {
	departmentScheduleSchema,
	myScheduleQuerySchema,
	myScheduleSchema,
	updateDepartmentScheduleInputSchema,
	updateWorkCalendarInputSchema,
	workCalendarEntrySchema,
	workCalendarQuerySchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de horarios y calendario laboral (spec 07 §5).
 *
 * Roles mínimos que aplica el backend:
 * - **leer horario y calendario**: `department_head` **con ámbito** sobre ese
 *   departamento — un jefe necesita ver la ventana que se le exige a su gente;
 * - **escribirlos**: `global_manager`, porque el horario es una regla de empresa
 *   y cambiarlo notifica a todos los miembros (RN-07.10);
 * - **`/me/schedule`**: cualquier autenticado, y sólo sobre lo suyo.
 *
 * El horario se escribe con `PUT` y no con `POST`/`PATCH` porque un departamento
 * tiene **un** horario o ninguno (RN-07.1): el cuerpo describe el resultado
 * completo y el servidor hace upsert.
 */
export const schedulesSpec = {
	get: {
		method: "GET",
		path: "/api/departments/:id/schedule",
		/** Nulo mientras el departamento no tenga horario configurado. */
		response: departmentScheduleSchema.nullable(),
	},
	update: {
		method: "PUT",
		path: "/api/departments/:id/schedule",
		body: updateDepartmentScheduleInputSchema,
		response: departmentScheduleSchema,
	},
	/**
	 * Quitar el horario. No está en la §5 de la spec: se añade porque el borrado de
	 * un departamento se bloquea si tiene horario (spec 01 §5.2) y sin esto ese
	 * bloqueo no tendría salida.
	 */
	remove: {
		method: "DELETE",
		path: "/api/departments/:id/schedule",
		response: z.object({ ok: z.literal(true) }),
	},
	calendar: {
		method: "GET",
		path: "/api/departments/:id/calendar",
		query: workCalendarQuerySchema,
		response: z.array(workCalendarEntrySchema),
	},
	updateCalendar: {
		method: "PUT",
		path: "/api/departments/:id/calendar",
		body: updateWorkCalendarInputSchema,
		/** Las filas que quedan de las fechas tocadas, ya resueltas. */
		response: z.array(workCalendarEntrySchema),
	},
	mine: {
		method: "GET",
		path: "/api/me/schedule",
		query: myScheduleQuerySchema,
		response: myScheduleSchema,
	},
} as const;
