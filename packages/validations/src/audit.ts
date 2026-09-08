import { z } from "zod";
import { keysetCursorSchema } from "./cursor.ts";
import { isoDateSchema } from "./time.ts";

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

/**
 * Etiquetas en español de cada acción, para el filtro y la tabla de la §7.
 *
 * Es un `Record` **exhaustivo** y no un formateador que parta el identificador
 * por el punto: así añadir una acción al catálogo sin darle nombre no compila, y
 * la pantalla no acaba enseñando `rest_group.members_changed` a una persona.
 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
	// Departamentos (spec 01)
	"department.created": "Departamento creado",
	"department.renamed": "Departamento renombrado",
	"department.rest_groups_changed": "Grupos de descanso del departamento",
	"department.paused": "Departamento pausado",
	"department.resumed": "Departamento reanudado",
	"department.deleted": "Departamento eliminado",
	// Configuración global (spec 06)
	"config.updated": "Configuración modificada",
	// Usuarios y perfiles (spec 02)
	"profile.department_changed": "Departamento de un perfil",
	"profile.updated": "Perfil modificado",
	"profile.contact_updated": "Datos de contacto",
	"profile.deactivated": "Perfil desactivado",
	"profile.reactivated": "Perfil reactivado",
	"profile.deleted": "Perfil eliminado",
	"compensation.updated": "Sueldo modificado",
	// Ámbito departamental (spec 03)
	"profile.responsibilities_changed": "Ámbito departamental",
	// Horarios y calendario (spec 07)
	"schedule.created": "Horario creado",
	"schedule.updated": "Horario modificado",
	"work_calendar.updated": "Calendario laboral",
	// Descansos (spec 10)
	"rest_schedule.updated": "Descansos de una persona",
	"rest_group.created": "Grupo de descanso creado",
	"rest_group.updated": "Grupo de descanso modificado",
	"rest_group.deleted": "Grupo de descanso eliminado",
	"rest_group.members_changed": "Miembros de un grupo",
	// Sedes (spec 08)
	"work_location.created": "Sede creada",
	"work_location.updated": "Sede modificada",
	"work_location.deactivated": "Sede desactivada",
	"work_location.reactivated": "Sede reactivada",
	// Vacaciones (spec 11)
	"vacation.requested": "Vacaciones solicitadas",
	"vacation.reviewed": "Vacaciones revisadas",
	"vacation.cancelled": "Vacaciones canceladas",
	// Incidencias (spec 12)
	"incident.reported": "Incidencia reportada",
	"incident.reviewed": "Incidencia revisada",
	// Justificación de ausencias (spec 13)
	"absence.reviewed": "Ausencia clasificada",
	// Nómina (spec 17)
	"payroll_adjustment.created": "Ajuste de nómina creado",
	"payroll_adjustment.reverted": "Ajuste de nómina revertido",
	// Reportería (spec 16)
	"report_run.enqueued": "Reporte encolado",
	"report_run.completed": "Reporte terminado",
	"report_run.failed": "Reporte fallido",
	"attendance_facts.refreshed": "Hechos diarios recalculados",
};

/**
 * El rótulo de una acción, con el valor crudo como respaldo. Es la única forma
 * de leer `AUDIT_ACTION_LABELS` desde la interfaz: lo que llega de la base es
 * texto, no una clave del catálogo.
 */
export const auditActionLabel = (action: string): string =>
	AUDIT_ACTION_LABELS[action as AuditAction] ?? action;

/** El dominio de una acción: lo que va antes del punto. */
export const auditDomainOf = (action: string): string =>
	action.slice(0, action.indexOf("."));

/**
 * Los dominios, con su nombre. Sirve para **agrupar el selector de acciones**:
 * treinta y nueve opciones planas no se leen.
 */
export const AUDIT_DOMAIN_LABELS: Record<string, string> = {
	department: "Departamentos",
	profile: "Perfiles",
	compensation: "Sueldos",
	config: "Configuración",
	schedule: "Horarios",
	work_calendar: "Calendario laboral",
	rest_schedule: "Descansos",
	rest_group: "Grupos de descanso",
	work_location: "Sedes",
	vacation: "Vacaciones",
	incident: "Incidencias",
	absence: "Ausencias",
	payroll_adjustment: "Nómina",
	report_run: "Reportes",
	attendance_facts: "Hechos diarios",
};

export const AUDIT_ACTIONS = auditActionSchema.options;

// ── §6 · La lectura ───────────────────────────────────────────────────────────

/**
 * Una entrada tal como se lee (§7).
 *
 * `actorName` es nulo en dos casos distintos y conviene no confundirlos: cuando
 * actuó **el sistema** (`actorId` nulo también — un proceso de fondo, spec 16) y
 * cuando el perfil que actuó **ya no existe** (`actorId` con nombre nulo). La
 * bitácora es inmutable (RN-18.6) y por eso sobrevive a quien la generó: borrar
 * un perfil no borra su rastro, que es justamente el punto.
 */
export const auditLogEntrySchema = z.object({
	id: z.uuid(),
	actorId: z.uuid().nullable(),
	actorName: z.string().nullable(),
	actorEmail: z.string().nullable(),
	/**
	 * **Se lee como texto, no como el enum del catálogo**, y es deliberado: la
	 * columna es `text`, el catálogo es el contrato de **escritura**, y una fila
	 * escrita por una versión anterior seguiría ahí después de revertirla
	 * (RN-18.6: la bitácora es inmutable). Validarla contra el enum al leer
	 * obligaría a esconder esa fila o a tumbar la página entera; una bitácora que
	 * esconde una fila porque su verbo ya no está en el catálogo deja de ser una
	 * bitácora. La interfaz rotula con `auditActionLabel`, que cae al valor crudo.
	 */
	action: z.string(),
	tableName: z.string(),
	recordId: z.string().nullable(),
	oldData: z.unknown().nullable(),
	newData: z.unknown().nullable(),
	sourceIp: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
	createdAt: z.iso.datetime(),
});

/**
 * El cursor de esta lista es **el compartido** (`cursor.ts`): la lista completa
 * de notificaciones (spec 14 §8) tiene exactamente la misma forma —crece por el
 * extremo que se lee y se ordena por `created_at desc, id desc`— y dos
 * implementaciones del mismo *keyset* acabarían divergiendo en el caso raro, que
 * aquí es el de dos filas con el mismo milisegundo.
 */

export const listAuditQuerySchema = z.object({
	actorId: z.uuid().optional(),
	/** Texto por el mismo motivo que en la entrada: es una igualdad, no un enum. */
	action: z.string().max(80).optional(),
	/** Dominio entero: todas las acciones que empiezan por esto. */
	domain: z.string().max(40).optional(),
	tableName: z.string().max(80).optional(),
	recordId: z.string().max(80).optional(),
	/**
	 * RN-18.8 — Todas las entradas de una misma cascada.
	 *
	 * Sin este filtro, el identificador de correlación estaría **guardado pero no
	 * consultable**, y la regla no pide guardarlo: pide *"poder leer la cadena
	 * completa"*. Es la diferencia entre un dato y una respuesta.
	 */
	correlationId: z.uuid().optional(),
	/** Rango por fecha civil, inclusivo en los dos extremos. */
	from: isoDateSchema.optional(),
	to: isoDateSchema.optional(),
	cursor: keysetCursorSchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Una página de bitácora.
 *
 * `nextCursor` nulo significa "no hay más", y se calcula pidiendo **una fila
 * más** de las que se devuelven: así no hace falta un `count(*)` sobre una tabla
 * que sólo crece para saber si queda algo detrás.
 */
export const auditPageSchema = z.object({
	entries: z.array(auditLogEntrySchema),
	nextCursor: z.string().nullable(),
});

// ── §7 · La diferencia visual ────────────────────────────────────────────────

export type AuditFieldChange = {
	field: string;
	before: unknown;
	after: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * §7 — La diferencia campo a campo entre `old_data` y `new_data`.
 *
 * La spec lo pide explícitamente y explica por qué: *"leer dos bloques de JSON
 * crudo no sirve"*. Una entrada de `config.updated` con quince claves dentro
 * obliga a comparar a ojo para encontrar la que cambió, y eso es exactamente lo
 * que alguien viene a buscar aquí.
 *
 * Vive en `@elineas/validations` y no en el frontend porque es una función pura
 * con casos de borde que merecen prueba —el alta sin estado anterior, la baja
 * sin estado nuevo, el valor que no es un objeto— y porque la comparación de
 * valores anidados se hace por su forma serializada, que es la única definición
 * de "cambió" que coincide con lo que se guardó.
 */
export function auditDiff(
	oldData: unknown,
	newData: unknown,
): AuditFieldChange[] {
	// Un valor que no es un objeto no tiene campos que comparar: se enseña como
	// un solo cambio sin nombre, y la interfaz decide cómo rotularlo.
	if (!isPlainObject(oldData) && !isPlainObject(newData)) {
		if (oldData === null && newData === null) return [];
		return [{ field: "", before: oldData ?? null, after: newData ?? null }];
	}

	const before = isPlainObject(oldData) ? oldData : {};
	const after = isPlainObject(newData) ? newData : {};
	const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];

	return fields
		.map((field) => ({
			field,
			before: before[field] ?? null,
			after: after[field] ?? null,
		}))
		.filter(
			(change) =>
				JSON.stringify(change.before) !== JSON.stringify(change.after),
		);
}

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;
