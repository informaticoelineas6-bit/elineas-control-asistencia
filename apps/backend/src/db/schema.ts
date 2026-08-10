import { relations } from "drizzle-orm";
import {
	boolean,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
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

/** Spec 01 §3. */
export const departments = pgTable("departments", {
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
});

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
	/** Dato financiero sensible: nunca se expone fuera de global_manager+. */
	monthlySalary: numeric("monthly_salary", { precision: 12, scale: 2 }),
	isActive: boolean("is_active").notNull().default(true),
	deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
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
