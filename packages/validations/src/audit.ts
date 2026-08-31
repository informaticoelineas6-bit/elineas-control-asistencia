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
	// Sedes y geocerca (spec 08)
	"work_location.created",
	"work_location.updated",
	"work_location.deactivated",
	"work_location.reactivated",
]);

export type AuditAction = z.infer<typeof auditActionSchema>;
