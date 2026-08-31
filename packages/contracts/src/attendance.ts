import {
	attendanceDaySchema,
	attendanceMarkResultSchema,
	attendanceMarkSchema,
	attendanceRangeQuerySchema,
	attendanceStatusSchema,
	createAttendanceMarkInputSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato del marcaje (spec 09 §6).
 *
 * Los cuatro endpoints son **del usuario sobre sí mismo**: no hay parámetro de
 * persona en ninguno, igual que en `/me` y en las notificaciones (RN-14.1). El
 * historial de otro se ve desde la gestión, que es de las specs 15 y 16.
 *
 * `POST /attendance/marks` es la **única puerta de escritura** a `attendance_marks`
 * (spec 09 §4): no hay endpoint para editar ni borrar una marca (RN-09.12), y las
 * correcciones pasan por incidencias (spec 12).
 */
export const attendanceSpec = {
	create: {
		method: "POST",
		path: "/api/attendance/marks",
		body: createAttendanceMarkInputSchema,
		/** Un rechazo también responde 200: es un hecho, no un fallo de la petición. */
		response: attendanceMarkResultSchema,
	},
	today: {
		method: "GET",
		path: "/api/attendance/marks/today",
		response: z.array(attendanceMarkSchema),
	},
	status: {
		method: "GET",
		path: "/api/attendance/status",
		response: attendanceStatusSchema,
	},
	mine: {
		method: "GET",
		path: "/api/attendance/me",
		query: attendanceRangeQuerySchema,
		response: z.array(attendanceDaySchema),
	},
} as const;
