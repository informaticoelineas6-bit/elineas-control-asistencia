import { relations, sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	numeric,
	pgTable,
	text,
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

export const departmentsRelations = relations(departments, ({ many }) => ({
	profiles: many(profiles),
	responsibilities: many(userDepartmentResponsibilities),
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
