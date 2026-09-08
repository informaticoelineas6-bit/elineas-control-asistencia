/**
 * Qué se trae del legacy, tabla por tabla (spec 21 §4).
 *
 * **Es una lista blanca explícita, y eso es RN-21.1.** La base del legacy está
 * compartida con otro sistema: quince tablas del esquema `public` no son de este
 * producto (§3, hallazgo H-2). Copiar "todo lo que haya" traería datos ajenos, y
 * dos de esas tablas son **homónimos** de las nuestras —`audit_logs` frente a
 * `audit_log`, `incidents` frente a `attendance_incidents`— así que el error no
 * daría ni un aviso: cuadraría de tipos y entraría (RN-21.2).
 *
 * El orden del array **es el orden de inserción**, y respeta las claves ajenas:
 * departamentos antes que perfiles, perfiles antes que todo lo que cuelga de una
 * persona.
 *
 * ## Lo que no es una copia
 *
 * Cinco transformaciones que este archivo declara y que conviene leer antes de
 * ejecutar nada:
 *
 * 1. **El id de un perfil sale de `profiles.user_id`, no de `profiles.id`.** En
 *    el legacy el perfil era 1:1 con `auth.users` y **todo el historial cuelga
 *    del id de autenticación**: `attendance_marks.user_id`, `reviewed_by`,
 *    `created_by`, `source_id`. Conservar el `id` de la fila de perfil en vez
 *    del `user_id` dejaría todas esas referencias apuntando al vacío — y sin
 *    error, porque son uuids válidos. Es la trampa más cara de esta migración.
 * 2. **El sueldo se muda de columna a tabla.** `profiles.monthly_salary` pasa a
 *    `employee_compensation` (hallazgo H-3): es lo que convierte "ningún hook de
 *    rol bajo hace `select *`" en una barrera de verdad.
 * 3. **`work_date` no existe en el legacy y hay que calcularlo.** Es una columna
 *    de la spec 09 §2, y sin ella la agregación diaria no encuentra los marcajes
 *    —consulta por (persona, `work_date`)— así que el reporte de un mes migrado
 *    saldría vacío y el criterio de la §9 sería imposible de cumplir.
 * 4. **Un ajuste de nómina no traía moneda ni periodo.** La moneda se toma del
 *    sueldo de esa persona y el periodo se imputa desde `created_at`, que es
 *    justamente la fragilidad que la spec 17 §7 describe: en el legacy los
 *    ajustes se filtraban por fecha de creación, así que **es la única respuesta
 *    disponible** para lo ya escrito. De aquí en adelante sale de la fecha de la
 *    ausencia.
 * 5. **`geofence_config` no se migra como tabla**: si el legacy no tenía sedes,
 *    su geocerca única se convierte en una `work_locations` (spec 08).
 */

/** Una copia declarada: de dónde, a dónde, y con qué expresiones. */
export type LegacyCopy = {
	/** Tabla en el legacy. */
	from: string;
	/** Tabla destino, por su nombre en la base. */
	to: string;
	/**
	 * Columna destino ← expresión SQL sobre la fila del legacy. Las expresiones
	 * van tal cual al `SELECT`, así que aquí caben los `coalesce` y los casts que
	 * cada tabla necesite.
	 */
	select: Record<string, string>;
	/** Columnas del legacy que tienen que existir; se comprueban antes de copiar. */
	requires: readonly string[];
	/** Orden estable, para que la paginación por lotes no repita ni se salte filas. */
	orderBy: string;
	/** Tamaño de lote. El de asistencia es el único que lo necesita de verdad. */
	batch?: number;
	/**
	 * Columnas destino que son `jsonb`.
	 *
	 * ⚠️ **Hay que declararlas, y esto lo encontró una prueba.** El cliente de
	 * PostgreSQL devuelve un `jsonb` **ya parseado** —un objeto o una cadena de
	 * JavaScript— y al volver a mandarlo como parámetro lo serializa como texto
	 * plano: un valor `"del legacy"` sale del origen como la cadena
	 * `del legacy` y entra como JSON inválido. Con la columna declarada, se lee
	 * como texto (`::text`) y se reinserta con un `::jsonb` explícito, así que el
	 * documento viaja tal cual sin pasar dos veces por un parser.
	 */
	json?: readonly string[];
	/** Para el informe: por qué esta tabla es especial. */
	note?: string;
};

const DEFAULT_BATCH = 2_000;

export const LEGACY_COPIES: readonly LegacyCopy[] = [
	{
		from: "departments",
		to: "departments",
		requires: ["id", "name"],
		orderBy: "id",
		select: {
			id: "id",
			name: "name",
			rest_groups_enabled: "coalesce(rest_groups_enabled, false)",
			is_paused: "coalesce(is_paused, false)",
			pause_reason: "pause_reason",
			paused_at: "paused_at",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "profiles",
		to: "profiles",
		// `user_id` es la clave de todo el historial: si no está, no hay migración.
		requires: ["user_id", "email", "full_name"],
		orderBy: "user_id",
		note: "El id destino sale de `user_id`; `identity_user_id` lo pone el emparejamiento.",
		select: {
			id: "user_id",
			email: "email",
			full_name: "full_name",
			department_id: "department_id",
			phone: "phone",
			is_active: "coalesce(is_active, true)",
			deactivated_at: "deactivated_at",
			deactivated_by: "deactivated_by",
			deactivation_reason: "deactivation_reason",
			contract_cancelled_at: "contract_cancelled_at",
			last_connection_at: "last_connection_at",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "profiles",
		to: "employee_compensation",
		requires: ["user_id"],
		orderBy: "user_id",
		note: "Hallazgo H-3: el sueldo se muda de columna de perfil a tabla propia.",
		select: {
			profile_id: "user_id",
			monthly_salary: "monthly_salary",
			// El legacy no guardaba moneda: la empresa paga en peso cubano salvo
			// excepción, y las excepciones se corrigen a mano después (spec 02 §6a).
			currency: "'CUP'",
			updated_at: "coalesce(updated_at, now())",
		},
	},
	{
		from: "user_department_responsibilities",
		to: "user_department_responsibilities",
		requires: ["user_id", "department_id"],
		orderBy: "user_id, department_id",
		select: {
			user_id: "user_id",
			department_id: "department_id",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "department_schedules",
		to: "department_schedules",
		requires: ["department_id", "checkin_start_time", "timezone"],
		orderBy: "department_id",
		select: {
			id: "id",
			department_id: "department_id",
			checkin_start_time: "checkin_start_time",
			checkin_end_time: "checkin_end_time",
			checkout_start_time: "checkout_start_time",
			checkout_end_time: "checkout_end_time",
			timezone: "timezone",
			allow_early_checkin: "coalesce(allow_early_checkin, false)",
			allow_late_checkout: "coalesce(allow_late_checkout, false)",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "work_calendar",
		to: "work_calendar",
		requires: ["department_id", "date", "is_workday"],
		orderBy: "department_id, date",
		select: {
			id: "id",
			department_id: "department_id",
			date: "date",
			is_workday: "is_workday",
			late_tolerance_minutes: "late_tolerance_minutes",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "work_locations",
		to: "work_locations",
		requires: ["id", "name", "center_lat", "center_lng", "radius_meters"],
		orderBy: "id",
		select: {
			id: "id",
			name: "name",
			center_lat: "center_lat",
			center_lng: "center_lng",
			radius_meters: "radius_meters",
			accuracy_threshold: "accuracy_threshold",
			block_on_poor_accuracy: "coalesce(block_on_poor_accuracy, false)",
			is_active: "coalesce(is_active, true)",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "rest_groups",
		to: "rest_groups",
		requires: ["id", "department_id", "name", "days_of_week"],
		orderBy: "id",
		note: "Convención de `days_of_week`: 0 = domingo (spec 10 §9). Verificar en el origen.",
		select: {
			id: "id",
			department_id: "department_id",
			name: "name",
			days_of_week: "days_of_week",
			is_active: "coalesce(is_active, true)",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "rest_group_members",
		to: "rest_group_members",
		requires: ["group_id", "user_id"],
		orderBy: "group_id, user_id",
		select: {
			id: "id",
			group_id: "group_id",
			user_id: "user_id",
			effective_from: "effective_from",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "user_rest_schedule",
		to: "user_rest_schedule",
		requires: ["user_id", "days_of_week"],
		orderBy: "user_id",
		select: {
			id: "id",
			user_id: "user_id",
			days_of_week: "days_of_week",
			effective_from: "effective_from",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "attendance_marks",
		to: "attendance_marks",
		requires: ["id", "user_id", "mark_type"],
		orderBy: "id",
		batch: 5_000,
		note: "El volumen mayor. `work_date` y `department_id` se calculan: el legacy no los guardaba.",
		select: {
			id: "id",
			user_id: "user_id",
			mark_type: "mark_type",
			// El instante: `timestamp` en el legacy, `marked_at` aquí — no conviene
			// llamar a una columna igual que un tipo de SQL (spec 09 §2).
			marked_at: 'coalesce("timestamp", created_at, now())',
			latitude: "latitude",
			longitude: "longitude",
			accuracy: "accuracy",
			distance_to_center: "distance_to_center",
			inside_geofence: "inside_geofence",
			work_location_id: "work_location_id",
			// `department_id` y `work_date` no salen del origen: los pone el
			// transformador de `legacy.ts`, que es donde se sabe a qué departamento
			// pertenece cada persona y en qué zona hay que leer la hora.
			department_id: "null::uuid",
			work_date: "null::date",
			blocked: "coalesce(blocked, false)",
			block_reason: "block_reason",
			// La tardanza la recalcula la agregación diaria con el horario de
			// entonces (spec 09 RN-09.7 guarda la de la marca, pero el legacy no la
			// tenía en esta tabla): entra en cero y el reporte no la usa de aquí.
			is_late: "false",
			late_minutes: "0",
			source: "'manual'",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "attendance_incidents",
		to: "attendance_incidents",
		requires: ["id", "user_id", "incident_type", "date", "status"],
		orderBy: "id",
		select: {
			id: "id",
			user_id: "user_id",
			incident_type: "incident_type",
			date: "date",
			reason: "reason",
			status: "status",
			manager_notes: "manager_notes",
			reviewed_by: "reviewed_by",
			reviewed_at: "reviewed_at",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "attendance_absence_reviews",
		to: "attendance_absence_reviews",
		requires: ["user_id", "date", "is_justified"],
		orderBy: "user_id, date",
		note: "Conserva revisor y fecha: son las decisiones de las que cuelga la nómina.",
		select: {
			id: "id",
			user_id: "user_id",
			date: "date",
			is_justified: "is_justified",
			notes: "notes",
			reviewed_by: "reviewed_by",
			reviewed_at: "coalesce(reviewed_at, created_at, now())",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "vacation_requests",
		to: "vacation_requests",
		requires: ["id", "user_id", "start_date", "end_date", "status"],
		orderBy: "id",
		select: {
			id: "id",
			user_id: "user_id",
			start_date: "start_date",
			end_date: "end_date",
			requested_days: "requested_days",
			status: "status",
			review_comment: "review_comment",
			reviewed_by: "reviewed_by",
			reviewed_at: "reviewed_at",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "payroll_adjustments",
		to: "payroll_adjustments",
		requires: ["id", "user_id", "amount", "category", "status"],
		orderBy: "id",
		note: "RN-21.4: historial económico. Íntegro, revertidos incluidos, y se verifica por suma.",
		select: {
			id: "id",
			user_id: "user_id",
			amount: "amount",
			// El legacy no guardaba moneda ni periodo. Ver la nota 4 de la cabecera.
			currency: "'CUP'",
			category: "category",
			description: "description",
			status: "status",
			source_type: "source_type",
			source_id: "source_id",
			effective_period:
				"date_trunc('month', coalesce(created_at, now()))::date",
			created_by: "created_by",
			reverted_by: "reverted_by",
			reverted_at: "reverted_at",
			created_at: "coalesce(created_at, now())",
		},
	},
	{
		from: "app_config",
		to: "app_config",
		requires: ["key"],
		orderBy: "key",
		note: "Las claves que el catálogo de la spec 06 no conoce se descartan al leer, no aquí.",
		json: ["value"],
		select: {
			key: "key",
			value: "value::text",
			updated_at: "coalesce(updated_at, now())",
		},
	},
	{
		from: "audit_log",
		to: "audit_log",
		// ⚠️ `audit_log`, **no** `audit_logs`: ésa es del otro sistema (RN-21.2).
		requires: ["id", "action", "table_name"],
		orderBy: "id",
		batch: 5_000,
		json: ["old_data", "new_data", "metadata"],
		select: {
			id: "id",
			actor_id: "actor_id",
			action: "action",
			table_name: "table_name",
			record_id: "record_id",
			old_data: "old_data::text",
			new_data: "new_data::text",
			// `inet` a texto: la columna nueva es `text` (spec 18 §2).
			source_ip: "source_ip::text",
			metadata: "metadata::text",
			created_at: "coalesce(created_at, now())",
		},
	},
];

export const batchOf = (copy: LegacyCopy): number =>
	copy.batch ?? DEFAULT_BATCH;

/**
 * **Los vocabularios cerrados, comprobados contra el origen antes de copiar.**
 *
 * Es el riesgo que ninguna comprobación de columnas atrapa: la tabla existe, la
 * columna existe, el tipo cuadra —todo es `text`— y los **valores** son otros.
 * Un `incident_type` que en el legacy se llamara `forgot` entraría sin una queja
 * y reventaría después, al leerlo: los esquemas de `@elineas/validations` son
 * enums cerrados, así que la pantalla de incidencias fallaría al parsear una
 * fila migrada. Y fallaría **después del corte**, con el legacy ya apagado.
 *
 * Aquí sólo están los vocabularios que **no** toleran un valor desconocido. Los
 * dos que sí lo toleran, por decisión de sus specs, se quedan fuera a propósito:
 * una clave de configuración que el catálogo de la spec 06 no conoce se descarta
 * con un aviso al leer, y un verbo de bitácora fuera del catálogo se rotula con
 * su valor crudo (spec 18 RN-18.6 — una bitácora que esconde una fila deja de
 * serlo).
 */
export const VOCABULARIES: readonly {
	table: string;
	column: string;
	allowed: readonly string[];
	spec: string;
}[] = [
	{
		table: "attendance_marks",
		column: "mark_type",
		allowed: ["IN", "OUT"],
		spec: "spec 09",
	},
	{
		table: "attendance_incidents",
		column: "incident_type",
		allowed: [
			"forgot_to_mark",
			"late_arrival",
			"early_departure",
			"gps_issue",
			"geofence_issue",
		],
		spec: "spec 12",
	},
	{
		table: "attendance_incidents",
		column: "status",
		allowed: ["pending", "approved", "rejected"],
		spec: "spec 12",
	},
	{
		table: "vacation_requests",
		column: "status",
		allowed: ["pending", "approved", "rejected", "cancelled"],
		spec: "spec 11",
	},
	{
		table: "payroll_adjustments",
		column: "category",
		allowed: ["unjustified_absence", "vacation", "other"],
		spec: "spec 17",
	},
	{
		table: "payroll_adjustments",
		column: "status",
		allowed: ["active", "reverted"],
		spec: "spec 17",
	},
];

/**
 * Lo que **no** se trae, y por qué. Se imprime en el plan: una migración que no
 * dice lo que deja atrás invita a que alguien lo eche en falta en producción y
 * lo copie a mano.
 */
export const SKIPPED: readonly { table: string; because: string }[] = [
	{
		table: "user_roles",
		because:
			"Los roles pasan al Identity Server (spec 00 Parte C). Sirve como lista de referencia para recrearlos allí (RN-21.9) y se descarta.",
	},
	{
		table: "auth.users",
		because:
			"Las identidades y las contraseñas son del Identity Server; las de Supabase no son reutilizables (§5).",
	},
	{
		table: "attendance_daily_facts",
		because:
			"Se recalculan, no se copian (spec 16 RN-16.10). Copiarlos traería el estado que calculó otro sistema con otras reglas.",
	},
	{
		table: "attendance_rule_versions",
		because:
			"La versión de reglas se crea al primer recálculo, con la configuración de ahora (spec 16 §5).",
	},
	{
		table: "report_runs",
		because:
			"Decisión 3 de la §10, cerrada: los reportes se regeneran. Un artefacto del legacy trae la matriz del legacy.",
	},
	{
		table: "notifications",
		because:
			"Avisos ya leídos de un sistema que se apaga. La spec ya lo daba por probable (§4).",
	},
	{
		table: "geofence_config",
		because:
			"No se migra como tabla: si no había sedes, su geocerca se convierte en una `work_locations` (§4, spec 08).",
	},
	{
		table: "app_releases",
		because:
			"La app móvil salió del alcance: no hay APK que publicar (spec 19 §2.7).",
	},
];

/**
 * Las quince tablas del otro sistema (§3). No se copian, y el plan comprueba
 * que ninguna se haya colado en la lista blanca — es una comprobación tonta que
 * cuesta nada y que atrapa el error de RN-21.2 el día que alguien añada una
 * tabla a la lista de arriba mirando el nombre de reojo.
 */
export const FOREIGN_TABLES: readonly string[] = [
	"activos",
	"guardias",
	"requests",
	"request_comments",
	"request_feedback",
	"request_histories",
	"request_trash",
	"worklogs",
	"knowledge_base",
	"automation_rules",
	"automation_logs",
	"chat_logs",
	"app_users",
	"audit_logs",
	"incidents",
];
