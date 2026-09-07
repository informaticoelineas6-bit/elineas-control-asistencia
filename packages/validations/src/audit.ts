import { z } from "zod";

/**
 * Catálogo de acciones auditables (spec 18 §3).
 *
 * Es un enum a propósito: en el legacy la bitácora se escribía con cadenas
 * libres desde los puntos de uso, y lo que nadie recordó instrumentar no se
 * auditó (spec 18 §5). Con un vocabulario cerrado, añadir una acción obliga a
 * pasar por aquí y se ve de un vistazo qué está cubierto.
 *
 * Crece con cada spec. Hoy sólo están las acciones que el código ya emite.
 */
export const auditActionSchema = z.enum([
	// Departamentos (spec 01)
	"department.created",
	"department.renamed",
	"department.rest_groups_changed",
	"department.paused",
	"department.resumed",
	"department.deleted",
	// Configuración global (spec 06)
	"config.updated",
	// Usuarios y perfiles (spec 02)
	"profile.department_changed",
	"profile.updated",
	"profile.contact_updated",
	"profile.deactivated",
	"profile.reactivated",
	"profile.deleted",
	"compensation.updated",
	// Ámbito departamental (spec 03 §3, RN-03.8)
	"profile.responsibilities_changed",
	// Horarios y calendario laboral (spec 07)
	"schedule.created",
	"schedule.updated",
	"work_calendar.updated",
	// Descansos (spec 10)
	"rest_schedule.updated",
	"rest_group.created",
	"rest_group.updated",
	"rest_group.deleted",
	"rest_group.members_changed",
	// Sedes y geocerca (spec 08)
	"work_location.created",
	"work_location.updated",
	"work_location.deactivated",
	"work_location.reactivated",
	// Vacaciones (spec 11)
	"vacation.requested",
	"vacation.reviewed",
	"vacation.cancelled",
	// Incidencias de asistencia (spec 12)
	"incident.reported",
	"incident.reviewed",
	// Justificación de ausencias (spec 13)
	"absence.reviewed",
	/**
	 * Nómina (spec 17 RN-17.9). ⚠️ **Hueco del legacy** (punto 76): allí los
	 * ajustes no llegaban a la bitácora, que es justo lo que uno querría leer
	 * cuando alguien pregunta por un descuento. Las escribe el servicio de
	 * nómina dentro de la transacción de la revisión que las origina.
	 */
	"payroll_adjustment.created",
	"payroll_adjustment.reverted",
	/**
	 * Reportería mensual (spec 16 §3). El historial de corridas ya es un registro
	 * en sí mismo (RN-16.4: reintentar crea una fila nueva), así que estas
	 * entradas no lo duplican: añaden **quién** pidió cada una y con qué
	 * resultado, junto al resto de la actividad del sistema.
	 */
	"report_run.enqueued",
	"report_run.completed",
	"report_run.failed",
	/** Recálculo manual de hechos diarios (RN-16.9). */
	"attendance_facts.refreshed",
]);

export type AuditAction = z.infer<typeof auditActionSchema>;
