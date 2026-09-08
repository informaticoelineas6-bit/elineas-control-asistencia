import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "#/db";
import {
	appConfig,
	attendanceAbsenceReviews,
	attendanceIncidents,
	attendanceMarks,
	auditLog,
	departmentSchedules,
	departments,
	employeeCompensation,
	payrollAdjustments,
	profiles,
	restGroupMembers,
	restGroups,
	userDepartmentResponsibilities,
	userRestSchedule,
	vacationRequests,
	workLocations,
} from "#/db/schema";

const TAG = `zz_mig_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const SCHEMA = `${TAG}_legacy`;

/**
 * El esquema de escala se fija **antes de importar el migrador**, que lo lee al
 * cargarse.
 *
 * No es una comodidad: por defecto se llama `legacy`, que es el nombre real que
 * usaría un ensayo del corte (spec 00 RN-00.25), y el `afterAll` de esta prueba
 * lo **borra**. Sin esto, correr las pruebas mientras alguien ensaya la
 * migración destruiría su copia cruda.
 */
process.env.LEGACY_STAGING_SCHEMA = `${TAG}_stage`;

const { extractLegacy, loadLegacy, STAGING_SCHEMA, verifyMigration } =
	await import("#/migration/legacy.ts");
/**
 * Los dos tipos que hacen falta aquí, escritos a mano: importarlos con `import
 * type` obligaría a un import estático del módulo que arriba se carga de forma
 * dinámica, y con eso se perdería el orden que hace segura esta prueba.
 */
type IdentityMap = Map<string, string>;
type LegacyConnection = { url: string; schema: string };

/**
 * Pruebas de la migración desde el legacy (spec 21 §9).
 *
 * **El problema de probar esto es que el legacy no está aquí**, y un migrador que
 * nadie ha ejecutado es una hoja de instrucciones, no una herramienta. Así que la
 * prueba **fabrica el origen**: crea un esquema con la forma que `old-docs.md`
 * §3 documenta —incluidas las dos tablas homónimas del otro sistema (§3, hallazgo
 * H-2)—, lo siembra, migra contra la base real y comprueba el resultado.
 *
 * De paso, el esquema de abajo es lo más parecido a una declaración ejecutable de
 * **qué se espera encontrar en el origen**: si el legacy real no cuadra con él,
 * el `plan` lo dice antes de escribir nada, que es justo lo que se quiere el fin
 * de semana del corte.
 *
 * Lo que estas pruebas cubren de la §9: el conteo por tabla, la suma de nómina
 * (RN-21.4), que **ningún dato de las tablas ajenas entra** (RN-21.2), que las
 * referencias cruzadas resuelven (RN-21.5), y que un perfil sin identidad
 * emparejada **detiene la carga** (RN-21.7/21.8).
 *
 * Las dos etapas de la spec 00 RN-00.23 se prueban en su orden: `extract` deja
 * la copia cruda —y a partir de ahí el origen ya no se toca, que es la razón de
 * que sean dos— y `load` transforma y escribe.
 *
 * Requiere el Postgres del compose (`docker compose up -d postgres` y
 * `bun run db:migrate`).
 */

/** Ids fijos: la migración los conserva (RN-21.5) y así se pueden afirmar. */
const ids = {
	departmentA: crypto.randomUUID(),
	departmentB: crypto.randomUUID(),
	/** Ojo: es el `user_id` del legacy, que pasa a ser el `id` del perfil. */
	ana: crypto.randomUUID(),
	beto: crypto.randomUUID(),
	/** Su perfil en el legacy tenía otro `id`: es la trampa que se comprueba. */
	anaProfileRow: crypto.randomUUID(),
	location: crypto.randomUUID(),
	markIn: crypto.randomUUID(),
	markOut: crypto.randomUUID(),
	review: crypto.randomUUID(),
	incident: crypto.randomUUID(),
	vacation: crypto.randomUUID(),
	adjustment: crypto.randomUUID(),
	revertedAdjustment: crypto.randomUUID(),
	auditEntry: crypto.randomUUID(),
	restGroup: crypto.randomUUID(),
	schedule: crypto.randomUUID(),
};

const emailOf = (name: string) => `${TAG}.${name}@legacy.local`;

const connection: LegacyConnection = {
	// La misma base: lo que cambia es el esquema, que es para lo que existe
	// `LEGACY_SCHEMA` — en producción es `public`, el de Supabase.
	url: process.env.DATABASE_URL ?? "",
	schema: SCHEMA,
};

let identities: IdentityMap;
let mapPath = "";

/**
 * El esquema del legacy tal como lo documenta `old-docs.md` §3.
 *
 * Sin claves ajenas y con casi todo nullable a propósito: es un origen del que
 * se **lee**, y ponerle restricciones aquí probaría el fixture en vez de probar
 * el migrador.
 */
const LEGACY_SCHEMA_SQL = `
create schema "${SCHEMA}";

create table "${SCHEMA}".departments (
  id uuid primary key, name text not null, rest_groups_enabled boolean,
  is_paused boolean, pause_reason text, paused_at timestamptz,
  created_at timestamptz default now()
);

-- 1:1 con auth.users: el perfil tiene su propio id **y** un user_id.
create table "${SCHEMA}".profiles (
  id uuid primary key, user_id uuid not null, email text, full_name text,
  department_id uuid, phone text, monthly_salary numeric(12,2),
  last_connection_at timestamptz, is_active boolean, deactivated_at timestamptz,
  deactivated_by uuid, deactivation_reason text, contract_cancelled_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table "${SCHEMA}".user_roles (
  id uuid primary key default gen_random_uuid(), user_id uuid, role text
);

create table "${SCHEMA}".user_department_responsibilities (
  id uuid primary key default gen_random_uuid(), user_id uuid, department_id uuid,
  created_at timestamptz default now()
);

create table "${SCHEMA}".department_schedules (
  id uuid primary key, department_id uuid, checkin_start_time time,
  checkin_end_time time, checkout_start_time time, checkout_end_time time,
  timezone text, allow_early_checkin boolean, allow_late_checkout boolean,
  created_at timestamptz default now()
);

create table "${SCHEMA}".work_calendar (
  id uuid primary key default gen_random_uuid(), department_id uuid, date date,
  is_workday boolean, late_tolerance_minutes integer,
  created_at timestamptz default now()
);

create table "${SCHEMA}".user_rest_schedule (
  id uuid primary key default gen_random_uuid(), user_id uuid,
  days_of_week integer[], effective_from date, created_at timestamptz default now()
);

create table "${SCHEMA}".rest_groups (
  id uuid primary key, department_id uuid, name text, days_of_week integer[],
  is_active boolean, created_at timestamptz default now()
);

create table "${SCHEMA}".rest_group_members (
  id uuid primary key default gen_random_uuid(), group_id uuid, user_id uuid,
  effective_from date, created_at timestamptz default now()
);

create table "${SCHEMA}".geofence_config (
  id uuid primary key default gen_random_uuid(), center_lat double precision,
  center_lng double precision, radius_meters integer, accuracy_threshold integer,
  block_on_poor_accuracy boolean
);

create table "${SCHEMA}".work_locations (
  id uuid primary key, name text, center_lat double precision,
  center_lng double precision, radius_meters integer, accuracy_threshold integer,
  block_on_poor_accuracy boolean, is_active boolean,
  created_at timestamptz default now()
);

-- Sin work_date, sin department_id y con la columna llamada "timestamp": las
-- tres diferencias con el esquema nuevo (spec 09 §2).
create table "${SCHEMA}".attendance_marks (
  id uuid primary key, user_id uuid, mark_type text, "timestamp" timestamptz,
  latitude double precision, longitude double precision, accuracy double precision,
  distance_to_center double precision, inside_geofence boolean, blocked boolean,
  block_reason text, work_location_id uuid, created_at timestamptz default now()
);

create table "${SCHEMA}".attendance_incidents (
  id uuid primary key, user_id uuid, incident_type text, date date, reason text,
  status text, manager_notes text, reviewed_by uuid, reviewed_at timestamptz,
  created_at timestamptz default now()
);

create table "${SCHEMA}".attendance_absence_reviews (
  id uuid primary key, user_id uuid, date date, is_justified boolean, notes text,
  reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz default now()
);

create table "${SCHEMA}".vacation_requests (
  id uuid primary key, user_id uuid, start_date date, end_date date,
  requested_days integer, status text, review_comment text, reviewed_by uuid,
  reviewed_at timestamptz, created_at timestamptz default now()
);

-- Sin currency y sin effective_period: los dos los añadió la spec 17.
create table "${SCHEMA}".payroll_adjustments (
  id uuid primary key, user_id uuid, amount numeric(12,2), category text,
  description text, status text, source_type text, source_id uuid,
  created_by uuid, reverted_by uuid, reverted_at timestamptz,
  created_at timestamptz default now()
);

create table "${SCHEMA}".app_config (
  key text primary key, value jsonb, updated_at timestamptz default now()
);

create table "${SCHEMA}".audit_log (
  id uuid primary key, actor_id uuid, action text, table_name text,
  record_id text, old_data jsonb, new_data jsonb, source_ip inet, metadata jsonb,
  created_at timestamptz default now()
);

-- Las dos homónimas del OTRO sistema (§3, RN-21.2). Ninguna debe migrarse.
create table "${SCHEMA}".audit_logs (
  id uuid primary key default gen_random_uuid(), accion text, usuario text
);
create table "${SCHEMA}".incidents (
  id uuid primary key default gen_random_uuid(), titulo text, estado text
);
create table "${SCHEMA}".activos (
  id uuid primary key default gen_random_uuid(), serie text
);
`;

async function seed() {
	const q = (text: string, values: unknown[] = []) => pool.query(text, values);

	await q(
		`insert into "${SCHEMA}".departments (id, name, rest_groups_enabled, is_paused)
		 values ($1, $2, true, false), ($3, $4, false, true)`,
		[
			ids.departmentA,
			`${TAG} Expedición`,
			ids.departmentB,
			`${TAG} Transporte`,
		],
	);

	await q(
		`insert into "${SCHEMA}".profiles
		   (id, user_id, email, full_name, department_id, phone, monthly_salary, is_active)
		 values ($1, $2, $3, $4, $5, '+53 5 1111111', 3000.00, true),
		        (gen_random_uuid(), $6, $7, $8, $9, null, null, true)`,
		[
			ids.anaProfileRow,
			ids.ana,
			emailOf("ana"),
			`${TAG} Ana`,
			ids.departmentA,
			ids.beto,
			emailOf("beto"),
			`${TAG} Beto`,
			ids.departmentB,
		],
	);

	await q(
		`insert into "${SCHEMA}".user_roles (user_id, role) values ($1, 'department_head')`,
		[ids.ana],
	);

	await q(
		`insert into "${SCHEMA}".user_department_responsibilities (user_id, department_id)
		 values ($1, $2)`,
		[ids.ana, ids.departmentB],
	);

	await q(
		`insert into "${SCHEMA}".department_schedules
		   (id, department_id, checkin_start_time, checkin_end_time,
		    checkout_start_time, checkout_end_time, timezone,
		    allow_early_checkin, allow_late_checkout)
		 values ($1, $2, '07:00', '09:00', '16:00', '19:00', 'America/Havana', false, true)`,
		[ids.schedule, ids.departmentA],
	);

	await q(
		`insert into "${SCHEMA}".work_calendar (department_id, date, is_workday, late_tolerance_minutes)
		 values ($1, '2026-03-16', true, 5), ($1, '2026-03-22', false, null)`,
		[ids.departmentA],
	);

	await q(
		`insert into "${SCHEMA}".user_rest_schedule (user_id, days_of_week, effective_from)
		 values ($1, '{0,6}', '2026-01-01')`,
		[ids.beto],
	);

	await q(
		`insert into "${SCHEMA}".rest_groups (id, department_id, name, days_of_week, is_active)
		 values ($1, $2, 'Grupo A', '{0,6}', true)`,
		[ids.restGroup, ids.departmentA],
	);

	await q(
		`insert into "${SCHEMA}".rest_group_members (group_id, user_id, effective_from)
		 values ($1, $2, '2026-01-01')`,
		[ids.restGroup, ids.ana],
	);

	await q(
		`insert into "${SCHEMA}".work_locations
		   (id, name, center_lat, center_lng, radius_meters, accuracy_threshold,
		    block_on_poor_accuracy, is_active)
		 values ($1, $2, 23.1136, -82.3666, 150, 50, false, true)`,
		[ids.location, `${TAG} Nave 1`],
	);

	// Dos marcajes de la misma jornada, a las 07:55 y a las 17:05 de La Habana
	// (UTC-4 en marzo): el día civil es el 16 en las dos.
	await q(
		`insert into "${SCHEMA}".attendance_marks
		   (id, user_id, mark_type, "timestamp", latitude, longitude, accuracy,
		    distance_to_center, inside_geofence, blocked, work_location_id)
		 values ($1, $2, 'IN',  '2026-03-16T11:55:00Z', 23.1136, -82.3666, 12, 4, true, false, $4),
		        ($3, $2, 'OUT', '2026-03-16T21:05:00Z', 23.1136, -82.3666, 15, 6, true, false, $4)`,
		[ids.markIn, ids.ana, ids.markOut, ids.location],
	);

	await q(
		`insert into "${SCHEMA}".attendance_incidents
		   (id, user_id, incident_type, date, reason, status, reviewed_by, reviewed_at)
		 values ($1, $2, 'forgot_to_mark', '2026-03-17', 'Olvidé marcar la salida',
		         'approved', $3, now())`,
		[ids.incident, ids.beto, ids.ana],
	);

	await q(
		`insert into "${SCHEMA}".attendance_absence_reviews
		   (id, user_id, date, is_justified, notes, reviewed_by, reviewed_at)
		 values ($1, $2, '2026-03-18', false, 'Sin aviso', $3, now())`,
		[ids.review, ids.beto, ids.ana],
	);

	await q(
		`insert into "${SCHEMA}".vacation_requests
		   (id, user_id, start_date, end_date, requested_days, status)
		 values ($1, $2, '2026-04-06', '2026-04-10', 5, 'approved')`,
		[ids.vacation, ids.ana],
	);

	// Uno activo y uno revertido: RN-21.4 pide que se migre **íntegro**.
	await q(
		`insert into "${SCHEMA}".payroll_adjustments
		   (id, user_id, amount, category, description, status, source_type, source_id, created_by, created_at)
		 values ($1, $2, -100.00, 'unjustified_absence', 'Ausencia del 18', 'active',
		         'absence_review', $3, $4, '2026-03-20T12:00:00Z'),
		        ($5, $2, -250.00, 'other', 'Rotura', 'reverted', null, null, $4,
		         '2026-02-10T12:00:00Z')`,
		[ids.adjustment, ids.beto, ids.review, ids.ana, ids.revertedAdjustment],
	);

	await q(
		`insert into "${SCHEMA}".app_config (key, value)
		 values ('${TAG}_probe', '"del legacy"'::jsonb)`,
	);

	await q(
		`insert into "${SCHEMA}".audit_log
		   (id, actor_id, action, table_name, record_id, new_data, source_ip)
		 values ($1, $2, 'profile.updated', 'profiles', $3::text,
		         '{"phone":"+53 5 1111111"}'::jsonb, '10.0.0.5')`,
		[ids.auditEntry, ids.ana, ids.beto],
	);

	// Y datos del otro sistema, para que se pueda demostrar que NO entran.
	await q(
		`insert into "${SCHEMA}".audit_logs (accion, usuario) values ('borró un activo', 'otro-sistema')`,
	);
	await q(
		`insert into "${SCHEMA}".incidents (titulo, estado) values ('Impresora atascada', 'abierta')`,
	);
	await q(`insert into "${SCHEMA}".activos (serie) values ('SN-0001')`);
}

beforeAll(async () => {
	await pool.query(LEGACY_SCHEMA_SQL);
	await seed();

	identities = new Map([
		[emailOf("ana").toLowerCase(), `is-${TAG}-ana`],
		[emailOf("beto").toLowerCase(), `is-${TAG}-beto`],
	]);

	const directory = await mkdtemp(join(tmpdir(), "elineas-migracion-"));
	mapPath = join(directory, "identidades.json");
	await writeFile(
		mapPath,
		JSON.stringify(
			[...identities].map(([email, identityUserId]) => ({
				email,
				identityUserId,
			})),
		),
	);
});

afterAll(async () => {
	const people = [ids.ana, ids.beto];

	await db
		.delete(attendanceMarks)
		.where(inArray(attendanceMarks.userId, people));
	await db
		.delete(attendanceIncidents)
		.where(inArray(attendanceIncidents.userId, people));
	await db
		.delete(attendanceAbsenceReviews)
		.where(inArray(attendanceAbsenceReviews.userId, people));
	await db
		.delete(vacationRequests)
		.where(inArray(vacationRequests.userId, people));
	await db
		.delete(payrollAdjustments)
		.where(inArray(payrollAdjustments.userId, people));
	await db.delete(auditLog).where(eq(auditLog.id, ids.auditEntry));
	await db
		.delete(restGroupMembers)
		.where(inArray(restGroupMembers.userId, people));
	await db.delete(restGroups).where(eq(restGroups.id, ids.restGroup));
	await db
		.delete(userRestSchedule)
		.where(inArray(userRestSchedule.userId, people));
	await db
		.delete(userDepartmentResponsibilities)
		.where(inArray(userDepartmentResponsibilities.userId, people));
	await db
		.delete(employeeCompensation)
		.where(inArray(employeeCompensation.profileId, people));
	await db
		.delete(departmentSchedules)
		.where(eq(departmentSchedules.id, ids.schedule));
	await db.delete(workLocations).where(eq(workLocations.id, ids.location));
	await db.delete(profiles).where(inArray(profiles.id, people));
	await db
		.delete(departments)
		.where(inArray(departments.id, [ids.departmentA, ids.departmentB]));
	await db.delete(appConfig).where(eq(appConfig.key, `${TAG}_probe`));

	await pool.query(`drop schema "${SCHEMA}" cascade`);
	await pool.query(`drop schema if exists "${STAGING_SCHEMA}" cascade`);
});

describe("extract — la copia cruda", () => {
	test("trae el origen sin transformarlo y sin tocar el destino", async () => {
		const before = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(profiles);

		const report = await extractLegacy(connection);
		expect(report.issues.filter((issue) => issue.blocking)).toEqual([]);

		const copied = new Map(report.tables.map((row) => [row.table, row.rows]));
		expect(copied.get("departments")).toBe(2);
		expect(copied.get("profiles")).toBe(2);
		expect(copied.get("attendance_marks")).toBe(2);
		expect(copied.get("payroll_adjustments")).toBe(2);
		// Las homónimas del otro sistema no están en la lista blanca, así que ni se
		// extraen: RN-21.2 empieza aquí.
		expect(copied.has("audit_logs")).toBe(false);
		expect(copied.has("incidents")).toBe(false);

		// Cruda de verdad: en la copia, `profiles` conserva **las dos** claves del
		// legacy —`id` y `user_id`— y el sueldo sigue siendo una columna del perfil.
		const { rows } = await pool.query(
			`select id, user_id, monthly_salary from "${STAGING_SCHEMA}".profiles
			 where user_id = $1`,
			[ids.ana],
		);
		expect(rows[0]).toMatchObject({ id: ids.anaProfileRow });

		// Y el destino sigue intacto: extraer no es cargar.
		const after = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(profiles);
		expect(after[0]?.count).toBe(before[0]?.count ?? 0);
	});
});

describe("load — la simulación", () => {
	test("no escribe nada y dice qué haría", async () => {
		const before = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(profiles);

		const report = await loadLegacy({ identities, commit: false });

		expect(report.committed).toBe(false);
		expect(report.identities.profiles).toBe(2);
		expect(report.identities.matched).toBe(2);
		expect(report.identities.unmatched).toEqual([]);
		expect(report.issues.filter((issue) => issue.blocking)).toEqual([]);
		expect(
			report.tables.find((table) => table.to === "attendance_marks")?.staged,
		).toBe(2);

		const after = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(profiles);
		expect(after[0]?.count).toBe(before[0]?.count ?? 0);
	});

	test("RN-21.7/21.8 — un correo sin emparejar bloquea la carga", async () => {
		// Es el fallo probable del corte: un perfil sin identidad es alguien que no
		// puede entrar el lunes. Tiene que detenerlo **antes**, no durante.
		const incomplete = new Map(identities);
		incomplete.delete(emailOf("beto").toLowerCase());

		const report = await loadLegacy({ identities: incomplete, commit: true });
		const blockers = report.issues.filter((issue) => issue.blocking);

		expect(report.identities.unmatched).toEqual([
			emailOf("beto").toLowerCase(),
		]);
		expect(blockers.length).toBeGreaterThan(0);
		expect(
			blockers.some((issue) => issue.message.includes("mapa de identidades")),
		).toBe(true);
		// Y con `--commit` puesto: la orden se acepta y **no escribe**.
		expect(report.committed).toBe(false);
		expect(
			await db.select().from(profiles).where(eq(profiles.id, ids.ana)),
		).toHaveLength(0);
	});
});

describe("load --commit — la copia", () => {
	test("migra todo y deja las referencias resolviendo", async () => {
		const result = await loadLegacy({ identities, commit: true });
		expect(result.committed).toBe(true);
		const written = new Map(result.tables.map((row) => [row.to, row.written]));

		expect(written.get("departments")).toBe(2);
		expect(written.get("profiles")).toBe(2);
		expect(written.get("attendance_marks")).toBe(2);
		expect(written.get("payroll_adjustments")).toBe(2);

		// RN-21.5 — El id del perfil sale de `user_id`, **no** del id de su fila en
		// el legacy. Es la trampa más cara de esta migración: con el otro id, todo
		// el historial apuntaría a un uuid válido que no es nadie.
		const [ana] = await db
			.select()
			.from(profiles)
			.where(eq(profiles.id, ids.ana));
		expect(ana).toBeDefined();
		expect(ana?.email).toBe(emailOf("ana"));
		expect(ana?.identityUserId).toBe(`is-${TAG}-ana`);
		expect(
			await db
				.select()
				.from(profiles)
				.where(eq(profiles.id, ids.anaProfileRow)),
		).toHaveLength(0);

		// Y las referencias cruzadas resuelven contra ese id.
		const [review] = await db
			.select()
			.from(attendanceAbsenceReviews)
			.where(eq(attendanceAbsenceReviews.id, ids.review));
		expect(review?.userId).toBe(ids.beto);
		expect(review?.reviewedBy).toBe(ids.ana);

		const [adjustment] = await db
			.select()
			.from(payrollAdjustments)
			.where(eq(payrollAdjustments.id, ids.adjustment));
		// El ajuste sigue apuntando a la revisión que lo originó (RN-21.5).
		expect(adjustment?.sourceId).toBe(ids.review);
		expect(adjustment?.createdBy).toBe(ids.ana);
	});

	test("hallazgo H-3 — el sueldo se muda de columna a tabla", async () => {
		const rows = await db
			.select()
			.from(employeeCompensation)
			.where(inArray(employeeCompensation.profileId, [ids.ana, ids.beto]));

		// Sólo Ana tenía sueldo: una fila vacía para Beto sólo diría "aquí no hay nada".
		expect(rows).toHaveLength(1);
		expect(rows[0]?.profileId).toBe(ids.ana);
		expect(rows[0]?.monthlySalary).toBe("3000.00");
		expect(rows[0]?.currency).toBe("CUP");
	});

	test("el marcaje gana `work_date` y `department_id`, que el legacy no tenía", async () => {
		const marks = await db
			.select()
			.from(attendanceMarks)
			.where(eq(attendanceMarks.userId, ids.ana));

		expect(marks).toHaveLength(2);
		for (const mark of marks) {
			// 11:55Z y 21:05Z de un 16 de marzo son las 07:55 y las 17:05 en La
			// Habana: la misma jornada, el día 16. Sin esto, la agregación diaria no
			// encontraría el marcaje y el reporte del mes migrado saldría vacío.
			expect(mark.workDate).toBe("2026-03-16");
			expect(mark.departmentId).toBe(ids.departmentA);
			expect(mark.source).toBe("manual");
		}
	});

	test("el ajuste gana moneda y periodo, imputado desde su fecha", async () => {
		const rows = await db
			.select()
			.from(payrollAdjustments)
			.where(inArray(payrollAdjustments.userId, [ids.beto]));

		const active = rows.find((row) => row.id === ids.adjustment);
		const reverted = rows.find((row) => row.id === ids.revertedAdjustment);

		expect(active?.currency).toBe("CUP");
		// Creado el 20 de marzo → periodo de marzo. Es la única respuesta
		// disponible para lo ya escrito (spec 17 §7).
		expect(active?.effectivePeriod).toBe("2026-03-01");
		// RN-21.4 — El revertido también se migra: es historial económico.
		expect(reverted?.status).toBe("reverted");
		expect(reverted?.effectivePeriod).toBe("2026-02-01");
	});

	test("RN-21.2 — ningún dato de las tablas ajenas entró", async () => {
		// Los homónimos son el fallo silencioso de esta migración: `audit_logs` del
		// otro sistema cuadraría de tipos con nuestro `audit_log`.
		const entries = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.id, ids.auditEntry));
		expect(entries).toHaveLength(1);
		expect(entries[0]?.action).toBe("profile.updated");

		const foreign = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(auditLog)
			.where(sql`${auditLog.action} = 'borró un activo'`);
		expect(foreign[0]?.count).toBe(0);

		const foreignIncidents = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(attendanceIncidents)
			.where(sql`${attendanceIncidents.reason} = 'Impresora atascada'`);
		expect(foreignIncidents[0]?.count).toBe(0);
	});

	test("es repetible: la segunda pasada no escribe nada", async () => {
		// Los identificadores se conservan (RN-21.5) y todo va con `on conflict do
		// nothing`, así que se puede cargar, revisar y volver a cargar. Es lo que
		// permite ensayar el corte entero sobre una copia (spec 00 RN-00.25).
		const again = await loadLegacy({ identities, commit: true });
		expect(again.tables.every((row) => row.written === 0)).toBe(true);
	});
});

describe("verify — RN-21.6", () => {
	test("cuadra el conteo por tabla y la suma de nómina", async () => {
		// Compara contra la copia cruda, no contra el origen: **funciona con el
		// legacy ya desconectado**, que es media razón de que haya dos etapas.
		const verification = await verifyMigration();

		expect(verification.ok).toBe(true);
		expect(
			verification.tables.find((row) => row.to === "attendance_marks")?.source,
		).toBe(2);

		// RN-21.4 — La suma, que es distinta del conteo: mil filas pueden estar
		// todas y una traer el importe mal.
		expect(verification.payroll.ok).toBe(true);
	});

	test("una fila que falta en el destino lo hace fallar", async () => {
		// Sin esto, `verify` podría ser una función que siempre dice que sí.
		await db.delete(attendanceMarks).where(eq(attendanceMarks.id, ids.markOut));

		const verification = await verifyMigration();
		expect(verification.ok).toBe(false);
		expect(
			verification.tables.find((row) => row.to === "attendance_marks")?.ok,
		).toBe(false);
	});
});
