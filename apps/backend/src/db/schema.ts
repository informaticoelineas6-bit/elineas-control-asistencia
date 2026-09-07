import { relations, sql } from "drizzle-orm";
import {
	boolean,
	date,
	doublePrecision,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	time,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/**
 * Esquema de la fundación de identidad: departamentos, perfiles y ámbito.
 *
 * El esquema **se redefine aquí, no se importa el DDL de Supabase** (RN-00.2), y
 * todo cambio pasa por una migración de Drizzle versionada (RN-00.3).
 *
 * Nada de contraseñas, sesiones ni `user_roles`: eso vive en el Identity Server
 * (RN-00.27, RN-00.29).
 */

/**
 * Spec 01 §3.
 *
 * Sin semilla: los departamentos los crea el administrador desde cero (decisión
 * 1 de la spec 01), y la organización es **plana** — no hay departamento padre
 * (decisión 2).
 */
export const departments = pgTable(
	"departments",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull().unique(),
		restGroupsEnabled: boolean("rest_groups_enabled").notNull().default(false),
		isPaused: boolean("is_paused").notNull().default(false),
		pauseReason: text("pause_reason"),
		pausedAt: timestamp("paused_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * RN-01.1 en la base, sin distinguir mayúsculas: "Transporte" y
		 * "transporte" son el mismo departamento para quien los lee en un selector.
		 * Con RLS fuera del proyecto (RN-00.1), las reglas que se pueden expresar
		 * como restricción de la base conviene tenerlas ahí además de en el
		 * servicio.
		 */
		uniqueIndex("departments_name_lower_idx").on(sql`lower(${table.name})`),
	],
);

/**
 * Spec 02 §3. 1:1 con el usuario del Identity Server.
 *
 * `identityUserId` guarda el `sub` del JWT y es la clave de vínculo: no hay FK
 * porque la identidad es externa, y no se empareja por correo porque un correo
 * puede cambiar (RN-00.44/45).
 */
export const profiles = pgTable("profiles", {
	id: uuid().primaryKey().defaultRandom(),
	identityUserId: text("identity_user_id").notNull().unique(),
	email: text().notNull(),
	fullName: text("full_name").notNull(),
	/** Nulo = perfil incompleto: entra, pero no puede marcar (RN-02.3). */
	departmentId: uuid("department_id").references(() => departments.id),
	phone: text(),
	/**
	 * El sueldo **no está aquí**: vive en `employee_compensation` (spec 02 §6a).
	 * En el legacy era una columna de esta tabla, protegida sólo por la costumbre
	 * de que ningún consumidor de rol bajo hacía `select *` — hallazgo H-3. Una
	 * tabla aparte convierte esa costumbre en una barrera: un endpoint que
	 * consulta perfiles no puede filtrar lo que no está en la fila.
	 */
	isActive: boolean("is_active").notNull().default(true),
	deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
	/**
	 * Quién desactivó. Sin clave ajena a propósito: si ese perfil se borra, el
	 * dato de quién tomó la decisión no debe desaparecer con él. El borrado real
	 * lo pone a nulo explícitamente (RN-02.8).
	 */
	deactivatedBy: uuid("deactivated_by"),
	deactivationReason: text("deactivation_reason"),
	contractCancelledAt: timestamp("contract_cancelled_at", {
		withTimezone: true,
	}),
	lastConnectionAt: timestamp("last_connection_at", { withTimezone: true }),
	/**
	 * Spec 08 §7, decisión 2 de su §9: la sede contra la que se valida el marcaje de
	 * esta persona (RN-08.5).
	 *
	 * Vive en el perfil y no sólo en el dispositivo por tres razones: sobrevive al
	 * cambio de teléfono y al borrado de datos del navegador; permite que **el
	 * servidor** invalide la selección al desactivar la sede (RN-08.6) en vez de
	 * fiarse de que el cliente se dé cuenta; y sigue siendo por persona, así que dos
	 * operarios que comparten terminal no heredan la del otro (RN-08.8). El cliente
	 * guarda además una copia local, pero es caché, no la verdad.
	 *
	 * `on delete set null` es red de seguridad: una sede no se borra, se desactiva
	 * (RN-08.10).
	 */
	selectedWorkLocationId: uuid("selected_work_location_id").references(
		() => workLocations.id,
		{ onDelete: "set null" },
	),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

/**
 * Spec 03 §3. Departamentos **adicionales** que gestiona un `department_head`.
 *
 * El ámbito es lo único de autorización que sigue viviendo en nuestra base: el
 * IS dice qué rol tiene alguien, no qué departamentos gestiona (RN-00.43).
 */
export const userDepartmentResponsibilities = pgTable(
	"user_department_responsibilities",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		departmentId: uuid("department_id")
			.notNull()
			.references(() => departments.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [unique().on(table.userId, table.departmentId)],
);

export const departmentsRelations = relations(departments, ({ many, one }) => ({
	profiles: many(profiles),
	responsibilities: many(userDepartmentResponsibilities),
	/** Uno como máximo (RN-07.1). */
	schedule: one(departmentSchedules),
	workCalendar: many(workCalendar),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
	department: one(departments, {
		fields: [profiles.departmentId],
		references: [departments.id],
	}),
	responsibilities: many(userDepartmentResponsibilities),
}));

export const responsibilitiesRelations = relations(
	userDepartmentResponsibilities,
	({ one }) => ({
		profile: one(profiles, {
			fields: [userDepartmentResponsibilities.userId],
			references: [profiles.id],
		}),
		department: one(departments, {
			fields: [userDepartmentResponsibilities.departmentId],
			references: [departments.id],
		}),
	}),
);

/**
 * Spec 06 §2. Clave/valor con JSONB, igual que el legacy, pero **tipado al
 * leer**: cada clave tiene su esquema Zod y su default en código
 * (`@elineas/validations/config`), y la base sólo guarda sobrescrituras
 * (RN-06.2).
 *
 * Se adelanta aquí, antes de la spec 06 completa, porque RN-03.6 necesita saber
 * a qué departamento se fuerzan los `global_manager` y esa referencia es
 * configurable, no un nombre escrito en el código.
 */
export const appConfig = pgTable("app_config", {
	key: text().primaryKey(),
	/**
	 * Admite nulo: una clave puede estar **explícitamente puesta a nulo**, que no es
	 * lo mismo que no estar. Para `global_manager_department_id` ambas cosas
	 * significan "regla desactivada", pero una clave futura cuyo default no sea nulo
	 * necesita poder distinguirlas.
	 */
	value: jsonb(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedBy: uuid("updated_by").references(() => profiles.id, {
		onDelete: "set null",
	}),
});

/**
 * Spec 18 §2. Quién hizo qué, cuándo y sobre qué.
 *
 * Se escribe **sólo desde el servidor** (RN-18.3) y **en la transacción de la
 * acción auditada** (RN-18.4): si la acción se revierte, su rastro también.
 * Nunca se actualiza ni se borra desde la aplicación (RN-18.6).
 *
 * `actorId` no lleva FK a `profiles`: una entrada de bitácora debe sobrevivir al
 * borrado del perfil que la originó, o el rastro se pierde justo cuando más
 * falta hace.
 */
export const auditLog = pgTable(
	"audit_log",
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Nulo cuando actúa el sistema, no una persona. */
		actorId: uuid("actor_id"),
		/** Verbo canónico, del catálogo de `@elineas/validations` (spec 18 §3). */
		action: text().notNull(),
		tableName: text("table_name").notNull(),
		recordId: text("record_id"),
		/** Sin contraseñas ni tokens jamás (RN-18.2). */
		oldData: jsonb("old_data"),
		newData: jsonb("new_data"),
		sourceIp: text("source_ip"),
		/** Motivo, user-agent, id de correlación (RN-18.8). */
		metadata: jsonb(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("audit_log_created_at_idx").on(table.createdAt.desc()),
		index("audit_log_record_idx").on(table.tableName, table.recordId),
		index("audit_log_actor_idx").on(table.actorId, table.createdAt.desc()),
	],
);

/**
 * Spec 14 §2. Aislamiento estricto por usuario: nadie ve las de otro, ni un
 * `global_manager` (RN-14.1). Sólo el servidor las crea (RN-14.2).
 *
 * `dedupeKey` permite actualizar en vez de duplicar (spec 14 §5) — el índice
 * único parcial es lo que hace posible el upsert.
 */
export const notifications = pgTable(
	"notifications",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		type: text().notNull(),
		title: text().notNull(),
		body: text().notNull(),
		actionUrl: text("action_url"),
		/** Nulo = no leída. */
		readAt: timestamp("read_at", { withTimezone: true }),
		dedupeKey: text("dedupe_key"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("notifications_user_unread_idx").on(table.userId, table.readAt),
		index("notifications_user_created_idx").on(
			table.userId,
			table.createdAt.desc(),
		),
		uniqueIndex("notifications_dedupe_idx")
			.on(table.userId, table.dedupeKey)
			.where(sql`dedupe_key is not null`),
	],
);

/**
 * Spec 02 §6a. Compensación, separada de `profiles`.
 *
 * Es la respuesta al hallazgo H-3: el sueldo estaba en `profiles` y sólo lo
 * protegía la costumbre de no hacer `select *`. Aquí la separación es física, así
 * que ningún endpoint de perfiles puede devolverlo por descuido — y con la RLS
 * fuera del proyecto (RN-00.1) eso importa más que antes.
 *
 * 1:1 con el perfil, con la clave primaria en `profile_id`: no hay historial de
 * sueldos. Si algún día hace falta, es una tabla nueva con vigencias, no filas
 * duplicadas aquí.
 */
export const employeeCompensation = pgTable("employee_compensation", {
	profileId: uuid("profile_id")
		.primaryKey()
		.references(() => profiles.id, { onDelete: "cascade" }),
	monthlySalary: numeric("monthly_salary", { precision: 12, scale: 2 }),
	/**
	 * Moneda del importe. Vive junto al importe y no en configuración global porque
	 * en la misma plantilla puede haber gente cobrando en monedas distintas.
	 * Vocabulario cerrado en `@elineas/validations` (`currencySchema`).
	 */
	currency: text().notNull().default("CUP"),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedBy: uuid("updated_by"),
});

export const employeeCompensationRelations = relations(
	employeeCompensation,
	({ one }) => ({
		profile: one(profiles, {
			fields: [employeeCompensation.profileId],
			references: [profiles.id],
		}),
	}),
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
	profile: one(profiles, {
		fields: [notifications.userId],
		references: [profiles.id],
	}),
}));

/**
 * Spec 07 §2. La ventana diaria del departamento: desde y hasta cuándo se acepta
 * una entrada, y desde y hasta cuándo una salida.
 *
 * `department_id` es **único**: un horario vigente por departamento, sin turnos
 * múltiples ni horarios por persona (RN-07.1, decisión 1 de la §8 cerrada). Si
 * algún día el negocio necesita turnos, es una tabla nueva con su vigencia, no una
 * columna que se deje preparada aquí "por si acaso".
 *
 * Las cuatro horas son `time` **sin zona**: son horas de reloj de pared, y la zona
 * en la que hay que leerlas está en su propia columna. Guardarlas como
 * `timestamptz` es lo que hace que un horario se corra una hora al cambiar el
 * horario de verano.
 *
 * Se borra con el departamento (`cascade`) porque un horario sin departamento no
 * significa nada; el borrado del departamento, además, está bloqueado mientras
 * exista horario (spec 01 §5.2).
 */
export const departmentSchedules = pgTable("department_schedules", {
	id: uuid().primaryKey().defaultRandom(),
	departmentId: uuid("department_id")
		.notNull()
		.unique()
		.references(() => departments.id, { onDelete: "cascade" }),
	/** Ventana de entrada (RN-07.3). */
	checkinStartTime: time("checkin_start_time").notNull(),
	checkinEndTime: time("checkin_end_time").notNull(),
	/** Ventana de salida (RN-07.4). Puede terminar al día siguiente (RN-07.5). */
	checkoutStartTime: time("checkout_start_time").notNull(),
	checkoutEndTime: time("checkout_end_time").notNull(),
	/**
	 * Zona IANA del departamento. Gana sobre `global_timezone` (RN-06.6) y es la
	 * que se usa en cada conversión instante → hora local: **nunca la del
	 * servidor** (RN-07.2), que en un contenedor es UTC.
	 */
	timezone: text().notNull(),
	allowEarlyCheckin: boolean("allow_early_checkin").notNull().default(false),
	allowLateCheckout: boolean("allow_late_checkout").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

/**
 * Spec 07 §2. Qué fechas concretas son laborables para un departamento, con su
 * tolerancia de tardanza propia.
 *
 * **Ausencia de fila significa algo**: la fecha es laborable con la tolerancia
 * global (RN-07.7, RN-07.8). Por eso la tabla no se siembra con los 365 días del
 * año — sólo guarda las excepciones—, y por eso el `PUT` del calendario admite
 * borrar filas y no sólo escribirlas.
 *
 * `date` es tipo `date` y no `timestamptz`: un feriado es un día del calendario de
 * pared, el mismo para todo el departamento, y convertirlo a instante es lo que
 * hace que se corra de día.
 */
export const workCalendar = pgTable(
	"work_calendar",
	{
		id: uuid().primaryKey().defaultRandom(),
		departmentId: uuid("department_id")
			.notNull()
			.references(() => departments.id, { onDelete: "cascade" }),
		date: date().notNull(),
		isWorkday: boolean("is_workday").notNull(),
		/** Nulo = manda la tolerancia global de la spec 06 (RN-07.8). */
		lateToleranceMinutes: integer("late_tolerance_minutes"),
		/**
		 * Por qué esta fecha es distinta: "Feriado: 1 de mayo", "Inventario".
		 *
		 * No está en la §2 de la spec y se añade por criterio: el calendario existe
		 * para feriados y jornadas especiales, y un día marcado sin etiqueta no dice
		 * de qué se trataba ni en la pantalla ni medio año después, revisando por qué
		 * a alguien no se le exigió asistencia.
		 */
		note: text(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/** Un día no puede ser laborable y no laborable a la vez (spec 07 §2). */
		unique("work_calendar_department_date_key").on(
			table.departmentId,
			table.date,
		),
		/** La consulta real es siempre "el rango de fechas de este departamento". */
		index("work_calendar_department_date_idx").on(
			table.departmentId,
			table.date,
		),
	],
);

export const departmentSchedulesRelations = relations(
	departmentSchedules,
	({ one }) => ({
		department: one(departments, {
			fields: [departmentSchedules.departmentId],
			references: [departments.id],
		}),
	}),
);

export const workCalendarRelations = relations(workCalendar, ({ one }) => ({
	department: one(departments, {
		fields: [workCalendar.departmentId],
		references: [departments.id],
	}),
}));

/**
 * Spec 08 §2. Sedes con geocerca circular: centro, radio y umbral de precisión.
 *
 * **`geofence_config` del legacy no se porta** (spec 08 §2): era la tabla de
 * geocerca única del diseño original y sobrevivía como respaldo con migración
 * automática. Si hay datos que traer, se traen una vez en el script de migración
 * (spec 21) y se descarta.
 *
 * Las coordenadas son `double precision` y no `numeric`: aquí no se suman dineros,
 * se calculan distancias, y la aritmética de coma flotante es la que usa la
 * fórmula. El radio y el umbral son enteros en **metros**, que es la unidad en la
 * que piensa quien configura una sede.
 *
 * No hay borrado (RN-08.10): una sede con marcajes históricos detrás no se elimina,
 * se desactiva — el historial necesita seguir sabiendo contra qué se validó.
 */
export const workLocations = pgTable(
	"work_locations",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull(),
		centerLat: doublePrecision("center_lat").notNull(),
		centerLng: doublePrecision("center_lng").notNull(),
		radiusMeters: integer("radius_meters").notNull(),
		accuracyThreshold: integer("accuracy_threshold").notNull(),
		/** RN-08.3: con `false` la mala precisión sólo advierte y queda registrada. */
		blockOnPoorAccuracy: boolean("block_on_poor_accuracy")
			.notNull()
			.default(false),
		isActive: boolean("is_active").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * Dos sedes con el mismo nombre son indistinguibles en el selector que alguien
		 * usa antes de marcar, así que la base lo impide sin distinguir mayúsculas —
		 * mismo criterio que los departamentos (RN-01.1).
		 */
		uniqueIndex("work_locations_name_lower_idx").on(sql`lower(${table.name})`),
		/** La consulta de cada día es "las sedes activas". */
		index("work_locations_active_idx").on(table.isActive),
	],
);

export const workLocationsRelations = relations(workLocations, ({ many }) => ({
	profiles: many(profiles),
}));

/**
 * Spec 09 §2. **La única escritura crítica del sistema**: todo lo demás lee de aquí.
 *
 * Sólo se escribe desde el handler de `POST /api/attendance/marks` (spec 09 §4).
 * No hay `UPDATE` ni `DELETE` desde la aplicación (RN-09.12): una corrección es una
 * incidencia (spec 12), no una edición.
 *
 * Cuatro campos no están en la §2 de la spec y se añaden por criterio, todos por el
 * mismo motivo — **lo que se puede recalcular hoy no se podrá recalcular mañana**,
 * porque el horario, la tolerancia y la geocerca cambian y los cambios no son
 * retroactivos (RN-06.4):
 *
 * - `work_date`: a qué jornada pertenece la marca (RN-07.5, jornada nocturna).
 * - `is_late` / `late_minutes`: la tardanza con la tolerancia **de entonces** (RN-09.7).
 * - `source`: quién puso la marca, persona o sistema (RN-09.14).
 * - `department_id`: foto del departamento al marcar. Es la denormalización que la
 *   §2 pedía evaluar: la reportería filtra por departamento constantemente, y el
 *   valor correcto para un reporte histórico es el de entonces, no el de hoy.
 */
export const attendanceMarks = pgTable(
	"attendance_marks",
	{
		id: uuid().primaryKey().defaultRandom(),
		/**
		 * Con `cascade`: el borrado real de un perfil sólo lo puede hacer un
		 * `superadmin` (RN-02.8), es excepcional y queda en bitácora. Un historial de
		 * asistencia sin la persona a la que pertenece no le sirve a nadie.
		 */
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		/** `IN` o `OUT`, del vocabulario cerrado de `@elineas/validations`. */
		markType: text("mark_type").notNull(),
		/** Instante según el servidor (RN-09.11). La columna de la spec se llamaba
		 * `timestamp`; aquí es `marked_at` para no llamar a una columna igual que un
		 * tipo de SQL. */
		markedAt: timestamp("marked_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		/** Nulo sólo en un intento rechazado antes de poder resolver la jornada. */
		workDate: date("work_date"),
		latitude: doublePrecision().notNull(),
		longitude: doublePrecision().notNull(),
		accuracy: doublePrecision().notNull(),
		/** Recalculados en el servidor a partir de lat/lng (RN-08.2). */
		distanceToCenter: doublePrecision("distance_to_center"),
		insideGeofence: boolean("inside_geofence"),
		workLocationId: uuid("work_location_id").references(
			() => workLocations.id,
			{ onDelete: "set null" },
		),
		departmentId: uuid("department_id").references(() => departments.id, {
			onDelete: "set null",
		}),
		/** RN-09.8 y decisión 2 de la §8: los intentos rechazados también se guardan. */
		blocked: boolean().notNull().default(false),
		blockReason: text("block_reason"),
		isLate: boolean("is_late").notNull().default(false),
		lateMinutes: integer("late_minutes").notNull().default(0),
		source: text().notNull().default("manual"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("attendance_marks_user_time_idx").on(
			table.userId,
			table.markedAt.desc(),
		),
		index("attendance_marks_time_idx").on(table.markedAt.desc()),
		/** La consulta de la agregación diaria: la jornada de una persona. */
		index("attendance_marks_user_workdate_idx").on(
			table.userId,
			table.workDate,
		),
		/** La de los paneles de departamento (specs 15 y 16). */
		index("attendance_marks_department_workdate_idx").on(
			table.departmentId,
			table.workDate,
		),
		/**
		 * RN-09.10 — Antirrebote **en la base**, que es donde se gana la carrera del
		 * doble toque: dos peticiones simultáneas no se detectan comprobando antes de
		 * insertar, sólo con una restricción.
		 *
		 * Son dos índices y no uno porque válidos y rechazados no compiten: un intento
		 * rechazado a las 08:00:10 no puede impedir que el marcaje válido de las
		 * 08:00:40 —la persona entró en la geocerca entretanto— entre en la misma
		 * minuto. El truncado va con la zona explícita (`at time zone 'UTC'`) porque
		 * sin ella la expresión depende de la sesión y PostgreSQL no la admite en un
		 * índice.
		 */
		uniqueIndex("attendance_marks_valid_minute_idx")
			.on(
				table.userId,
				table.markType,
				sql`date_trunc('minute', ${table.markedAt} at time zone 'UTC')`,
			)
			.where(sql`not blocked`),
		uniqueIndex("attendance_marks_blocked_minute_idx")
			.on(
				table.userId,
				table.markType,
				sql`date_trunc('minute', ${table.markedAt} at time zone 'UTC')`,
			)
			.where(sql`blocked`),
	],
);

export const attendanceMarksRelations = relations(
	attendanceMarks,
	({ one }) => ({
		profile: one(profiles, {
			fields: [attendanceMarks.userId],
			references: [profiles.id],
		}),
		workLocation: one(workLocations, {
			fields: [attendanceMarks.workLocationId],
			references: [workLocations.id],
		}),
	}),
);

/**
 * Spec 10 §2. Descansos **individuales**: qué días de la semana no trabaja una
 * persona, desde cuándo.
 *
 * `days_of_week` es `integer[]` con la convención 0 = domingo … 6 = sábado
 * (decisión 1 de la §9, cerrada en `@elineas/validations/rest`): la de
 * `Date.getDay()` y la de `extract(dow from …)`, que son los dos motores por los
 * que pasa el dato.
 *
 * **`effective_from` es lo que hace correcta la reportería histórica** (RN-10.1):
 * la configuración no se sobrescribe, se apila, y para una fecha D manda la fila
 * más reciente con `effective_from ≤ D`. Un `UPDATE` en su lugar reescribiría el
 * pasado, y el reporte del mes cerrado cambiaría al día siguiente de que alguien
 * mueva su descanso.
 */
export const userRestSchedule = pgTable(
	"user_rest_schedule",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		daysOfWeek: integer("days_of_week").array().notNull(),
		effectiveFrom: date("effective_from").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * Una configuración por persona y fecha de vigencia. Sin esta restricción,
		 * dos filas con el mismo `effective_from` dejarían RN-10.1 sin respuesta
		 * única, y cuál gana dependería del plan de consulta.
		 */
		unique("user_rest_schedule_user_from_key").on(
			table.userId,
			table.effectiveFrom,
		),
		/** La consulta real es siempre "las filas de esta persona, la última primero". */
		index("user_rest_schedule_user_from_idx").on(
			table.userId,
			table.effectiveFrom.desc(),
		),
	],
);

/**
 * Spec 10 §2. Grupos de descanso de un departamento, para operaciones que rotan
 * turnos. Aplican sólo si `departments.rest_groups_enabled` (RN-10.2).
 *
 * `is_active` no está en la §2 y se añade por el mismo criterio que las sedes
 * (RN-08.10): un grupo con historial detrás **no se borra**, porque los reportes
 * de meses cerrados necesitan seguir sabiendo con qué días descansaba su gente.
 * El `DELETE` queda para el grupo que nunca tuvo miembros, que es el que se creó
 * por error.
 */
export const restGroups = pgTable(
	"rest_groups",
	{
		id: uuid().primaryKey().defaultRandom(),
		departmentId: uuid("department_id")
			.notNull()
			.references(() => departments.id, { onDelete: "cascade" }),
		name: text().notNull(),
		daysOfWeek: integer("days_of_week").array().notNull(),
		isActive: boolean("is_active").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * "Grupo A" y "grupo a" son el mismo grupo para quien los lee en un selector
		 * — mismo criterio que departamentos (RN-01.1) y sedes. Único **dentro del
		 * departamento**: dos departamentos pueden tener cada uno su Grupo A.
		 */
		uniqueIndex("rest_groups_department_name_lower_idx").on(
			table.departmentId,
			sql`lower(${table.name})`,
		),
		index("rest_groups_department_idx").on(table.departmentId, table.isActive),
	],
);

/**
 * Spec 10 §2. A qué grupo pertenece una persona, desde cuándo.
 *
 * **`group_id` admite nulo**, y ésa es la decisión de diseño de esta tabla: es la
 * fila que dice "esta persona salió de su grupo en esta fecha". Sin ella, sacar a
 * alguien de un grupo obligaría a borrar sus filas —reescribiendo el pasado, justo
 * lo que RN-10.1 impide— o a dejarla dentro para siempre. Con ella, la tabla es un
 * historial de asignaciones donde "sin grupo" es un hecho fechado como cualquier
 * otro, y la resolución es la misma para todos los casos: la fila más reciente con
 * `effective_from ≤ D`.
 */
export const restGroupMembers = pgTable(
	"rest_group_members",
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Nulo = salió de todo grupo en esa fecha. */
		groupId: uuid("group_id").references(() => restGroups.id, {
			onDelete: "restrict",
		}),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		effectiveFrom: date("effective_from").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * Una asignación por persona y fecha, **en toda la tabla** y no por grupo:
		 * nadie pertenece a dos grupos el mismo día, y si lo hiciera RN-10.1 no
		 * tendría respuesta única.
		 */
		unique("rest_group_members_user_from_key").on(
			table.userId,
			table.effectiveFrom,
		),
		index("rest_group_members_user_from_idx").on(
			table.userId,
			table.effectiveFrom.desc(),
		),
		index("rest_group_members_group_idx").on(table.groupId),
	],
);

export const userRestScheduleRelations = relations(
	userRestSchedule,
	({ one }) => ({
		profile: one(profiles, {
			fields: [userRestSchedule.userId],
			references: [profiles.id],
		}),
	}),
);

export const restGroupsRelations = relations(restGroups, ({ one, many }) => ({
	department: one(departments, {
		fields: [restGroups.departmentId],
		references: [departments.id],
	}),
	members: many(restGroupMembers),
}));

export const restGroupMembersRelations = relations(
	restGroupMembers,
	({ one }) => ({
		group: one(restGroups, {
			fields: [restGroupMembers.groupId],
			references: [restGroups.id],
		}),
		profile: one(profiles, {
			fields: [restGroupMembers.userId],
			references: [profiles.id],
		}),
	}),
);

/**
 * Spec 11 §3. Solicitudes de vacaciones, con el saldo resuelto en
 * `services/vacations.ts` a partir del historial de marcas — no hay columna de
 * saldo aquí, para no tener dos verdades sobre cuánto le queda a alguien.
 *
 * Tres campos no están en la §3 de la spec y se añaden por criterio, todos por
 * el mismo motivo que llevó a añadir columnas parecidas en `attendanceMarks`:
 * **una cancelación es un hecho fechado, no una fila que desaparece**.
 *
 * - `cancelled_by` / `cancelled_at`: quién canceló y cuándo (RN-11.10), que es
 *   una acción distinta de `reviewed_by`/`reviewed_at` — cancelar no es revisar,
 *   y una solicitud cancelada por su propio dueño no debe parecer revisada por
 *   nadie.
 *
 * Ni `reviewed_by` ni `cancelled_by` llevan clave ajena, por el mismo motivo que
 * `deactivated_by` en `profiles` (RN-02.8): si ese perfil se borra, el rastro de
 * quién decidió qué no debe desaparecer con él.
 */
export const vacationRequests = pgTable(
	"vacation_requests",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		startDate: date("start_date").notNull(),
		endDate: date("end_date").notNull(),
		/**
		 * Congelado al crear (RN-11.13): un cambio posterior en el calendario o los
		 * descansos de la persona no debe recalcular hacia atrás cuánto costó una
		 * solicitud ya aprobada — es el mismo principio de `attendanceMarks.isLate`,
		 * que guarda la tardanza de entonces y no la que resultaría de las reglas
		 * de hoy.
		 */
		requestedDays: integer("requested_days").notNull(),
		status: text().notNull().default("pending"),
		reviewComment: text("review_comment"),
		reviewedBy: uuid("reviewed_by"),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		cancelledBy: uuid("cancelled_by"),
		cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * RN-11.1/11.3/11.6: el saldo y el solapamiento se calculan por persona,
		 * filtrando por `pending`/`approved`. Es la consulta que corre en cada
		 * solicitud nueva, dentro de la transacción que la bloquea.
		 */
		index("vacation_requests_user_status_idx").on(table.userId, table.status),
		/** La bandeja de un jefe: sus solicitudes pendientes, la más antigua primero. */
		index("vacation_requests_status_created_idx").on(
			table.status,
			table.createdAt,
		),
	],
);

export const vacationRequestsRelations = relations(
	vacationRequests,
	({ one }) => ({
		profile: one(profiles, {
			fields: [vacationRequests.userId],
			references: [profiles.id],
		}),
	}),
);

/**
 * Spec 12 §3. Incidencias de asistencia: lo que el empleado reporta sobre un
 * problema con su marcaje, y la constancia de que alguien lo revisó.
 *
 * **Aprobar una incidencia no toca `attendance_marks`** (RN-12.9): esta tabla es
 * el registro de un acto documental, no una corrección del historial. Es la otra
 * cara de la nota de `attendance_marks`, que no admite `UPDATE` ni `DELETE`
 * desde la aplicación (RN-09.12) — una corrección es una incidencia, no una
 * edición.
 *
 * Dos campos no están en la §3:
 *
 * - `attendance_mark_id`, la **propuesta RN-12.2**: el marcaje bloqueado que
 *   originó la incidencia. El legacy no lo enlazaba, así que el revisor tenía
 *   que buscar a mano la evidencia de un "intenté marcar y no me dejó" que el
 *   sistema ya tenía guardada (RN-09.8). Con `set null` al borrarse la marca: la
 *   incidencia y su revisión siguen valiendo sin ella.
 * - `updated_at`, que la §3 sí pide pero conviene decir para qué sirve: la
 *   revisión es **irreversible** (RN-12.8), así que es la marca de cuándo se
 *   cerró, no de la última de muchas ediciones.
 *
 * `reviewed_by` no lleva clave ajena, por el mismo motivo que en
 * `vacation_requests`: si ese perfil se borra, el rastro de quién decidió qué no
 * debe desaparecer con él.
 */
export const attendanceIncidents = pgTable(
	"attendance_incidents",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		/** Del vocabulario cerrado de la §4, en `@elineas/validations/incidents`. */
		incidentType: text("incident_type").notNull(),
		/**
		 * El día al que se refiere. Tipo `date` y no `timestamptz` por lo mismo que
		 * en `work_calendar`: es un día del calendario de pared, y convertirlo a
		 * instante es lo que hace que se corra de día.
		 */
		date: date().notNull(),
		/**
		 * Vacío admitido: los tipos técnicos pueden enviarse sin texto (RN-12.1)
		 * porque el sistema ya tiene la evidencia. Es `''` y no nulo para que no
		 * haya dos formas de decir "sin motivo".
		 */
		reason: text().notNull().default(""),
		status: text().notNull().default("pending"),
		managerNotes: text("manager_notes"),
		attendanceMarkId: uuid("attendance_mark_id").references(
			() => attendanceMarks.id,
			{ onDelete: "set null" },
		),
		reviewedBy: uuid("reviewed_by"),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/** Los dos índices que la §3 pide explícitamente, porque los necesita la bandeja. */
		index("attendance_incidents_user_status_idx").on(
			table.userId,
			table.status,
		),
		index("attendance_incidents_date_idx").on(table.date),
		/**
		 * El orden de la bandeja (§6): pendientes primero, luego por fecha
		 * descendente. El tercer índice de la §3 —"por departamento vía join"— no
		 * se crea aquí: el departamento vive en `profiles`, que ya tiene el suyo, y
		 * un índice sobre esta tabla no puede cubrir una columna de la otra.
		 */
		index("attendance_incidents_status_date_idx").on(
			table.status,
			table.date.desc(),
		),
		/**
		 * RN-12.5 — Una por día y tipo mientras esté pendiente, **en la base**. Es
		 * parcial a propósito: una vez revisada, la spec permite crear otra
		 * (RN-12.8, "si hace falta, se crea otra"), así que la restricción sólo
		 * puede alcanzar a las pendientes. Comprobarlo antes de insertar no ganaría
		 * la carrera del doble envío, igual que en el antirrebote del marcaje.
		 */
		uniqueIndex("attendance_incidents_pending_unique_idx")
			.on(table.userId, table.date, table.incidentType)
			.where(sql`status = 'pending'`),
	],
);

export const attendanceIncidentsRelations = relations(
	attendanceIncidents,
	({ one }) => ({
		profile: one(profiles, {
			fields: [attendanceIncidents.userId],
			references: [profiles.id],
		}),
		mark: one(attendanceMarks, {
			fields: [attendanceIncidents.attendanceMarkId],
			references: [attendanceMarks.id],
		}),
	}),
);

/**
 * Spec 13 §2. La decisión del jefe sobre un día ausente: justificada o no.
 *
 * **Una fila por (`user_id`, `date`)** (RN-13.2), y la escritura es un upsert:
 * revisar de nuevo el mismo día sobrescribe la decisión y dispara la reversión o
 * la creación del ajuste de nómina. No hay historial de decisiones en esta tabla
 * porque el rastro está donde importa — la bitácora guarda el valor anterior
 * (RN-13.8) y `payroll_adjustments` no borra nada (RN-17.4)—, así que apilar
 * filas aquí sólo daría una tercera versión de la misma verdad.
 *
 * **No hay `is_justified` nulo ni estado "pendiente".** Una ausencia sin revisar
 * es *la ausencia de una fila*, no una fila con un tercer valor: es lo que hace
 * que RN-13.10 —sin decisión, ANJ en el reporte y **sin** descuento— se lea de
 * un vistazo en vez de dependiendo de cómo se interprete un nulo.
 */
export const attendanceAbsenceReviews = pgTable(
	"attendance_absence_reviews",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		/** Día del calendario de pared, como en `work_calendar`. */
		date: date().notNull(),
		isJustified: boolean("is_justified").notNull(),
		notes: text(),
		/**
		 * Sin clave ajena, por lo mismo que `reviewed_by` en `vacation_requests` y
		 * `deactivated_by` en `profiles`: si ese perfil se borra, el rastro de quién
		 * decidió mover dinero no debe desaparecer con él.
		 */
		reviewedBy: uuid("reviewed_by").notNull(),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/** RN-13.2 — Una decisión por día, en la base. Es el destino del upsert. */
		unique("attendance_absence_reviews_user_date_key").on(
			table.userId,
			table.date,
		),
		/** La consulta del historial y de la superposición AJ/ANJ: el rango de una persona. */
		index("attendance_absence_reviews_user_date_idx").on(
			table.userId,
			table.date,
		),
	],
);

export const attendanceAbsenceReviewsRelations = relations(
	attendanceAbsenceReviews,
	({ one }) => ({
		profile: one(profiles, {
			fields: [attendanceAbsenceReviews.userId],
			references: [profiles.id],
		}),
	}),
);

/**
 * Spec 17 §2. Ajustes económicos sobre el sueldo de una persona.
 *
 * ⚠️ **La spec 17 no está construida.** Esta tabla existe porque RN-13.4 la
 * necesita: el descuento por ausencia injustificada nace **dentro** de la
 * transacción de la revisión (RN-13.5), no en un módulo aparte que se llame
 * después. Lo que falta de la 17 es su superficie de administración —ajustes
 * manuales, edición de sueldos, `/payroll/*`, totales por periodo—, no su
 * modelo: crear media tabla ahora y migrarla luego habría sido peor que
 * declararla entera y dejar sin escribir lo que todavía no se usa.
 *
 * Tres decisiones de diseño que la §2 de esa spec deja al implementador:
 *
 * - **`amount` es `numeric` con signo** (negativo = descuento). Un campo de tipo
 *   y otro de valor absoluto obligarían a recordar el signo en cada suma; con el
 *   signo dentro, el total de un periodo es un `sum()`.
 * - **`effective_period` es el día 1 del mes de la ausencia**, no de la fecha de
 *   registro (spec 17 §7): un descuento por una ausencia de marzo registrado en
 *   abril pertenece a marzo.
 * - **`source_type`/`source_id` en vez de una clave ajena a
 *   `attendance_absence_reviews`.** La 17 admite ajustes manuales, que no tienen
 *   origen, y otros automáticos que vendrán de otras tablas; una FK a la
 *   revisión ataría la tabla al único origen que existe hoy.
 */
export const payrollAdjustments = pgTable(
	"payroll_adjustments",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		/** Con signo. Misma precisión que `employee_compensation.monthly_salary`. */
		amount: numeric({ precision: 12, scale: 2 }).notNull(),
		/** El importe nunca viaja sin su moneda: se copia de la compensación de entonces. */
		currency: text().notNull().default("CUP"),
		category: text().notNull(),
		description: text(),
		status: text().notNull().default("active"),
		sourceType: text("source_type"),
		sourceId: uuid("source_id"),
		/** Día 1 del mes al que se imputa (§7). */
		effectivePeriod: date("effective_period").notNull(),
		/** Nulo cuando lo crea el sistema y no una persona, como en la bitácora. */
		createdBy: uuid("created_by"),
		revertedBy: uuid("reverted_by"),
		revertedAt: timestamp("reverted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		/**
		 * RN-17.5 — **Un mismo origen no puede tener dos ajustes activos**, y la spec
		 * pide explícitamente que la restricción esté en la base y no sólo en el
		 * código. Parcial porque los revertidos sí conviven: RN-13.4 dice que volver
		 * a "injustificada" crea un ajuste **nuevo**, no resucita el anterior, así
		 * que un origen acumula filas revertidas y como mucho una activa.
		 *
		 * Es además lo que hace idempotente la cadena de RN-13.4 bajo concurrencia:
		 * dos revisiones simultáneas del mismo día no pueden crear dos descuentos.
		 */
		uniqueIndex("payroll_adjustments_active_source_idx")
			.on(table.sourceType, table.sourceId)
			.where(sql`status = 'active' and source_id is not null`),
		/** El listado del periodo (spec 17 §6) y los totales por empleado. */
		index("payroll_adjustments_period_idx").on(
			table.effectivePeriod,
			table.userId,
		),
		index("payroll_adjustments_user_status_idx").on(table.userId, table.status),
	],
);

export const payrollAdjustmentsRelations = relations(
	payrollAdjustments,
	({ one }) => ({
		profile: one(profiles, {
			fields: [payrollAdjustments.userId],
			references: [profiles.id],
		}),
	}),
);
