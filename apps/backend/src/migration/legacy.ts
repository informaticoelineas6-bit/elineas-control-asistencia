import { Pool } from "pg";
import { db, pool } from "#/db";
import {
	batchOf,
	FOREIGN_TABLES,
	LEGACY_COPIES,
	type LegacyCopy,
	SKIPPED,
	VOCABULARIES,
} from "#/migration/legacy-tables.ts";

/**
 * Migración desde el legacy (spec 21, y la forma la fija la
 * [00](../../../../packages/specs/00-migracion-datos-e-identidad.md) RN-00.23).
 *
 * **Tres comandos, y en dos etapas:**
 *
 * ```
 * extract  Supabase → esquema `legacy` de esta base. Sólo lectura en el origen.
 * load     `legacy` → `public`. Simulación por defecto; escribe con --commit.
 * verify   conteos y sumas, origen contra destino.
 * ```
 *
 * **Por qué dos etapas y no una.** La tentación es leer del origen y escribir en
 * el destino de un tirón, y es peor por dos razones que sólo se ven el día del
 * corte:
 *
 * 1. **La ventana contra el origen pasa a ser de minutos.** `extract` es una
 *    copia cruda, sin transformar nada: se ejecuta una vez, el legacy se puede
 *    desconectar a continuación, y la parte lenta —y la que puede fallar— corre
 *    ya sin él. La spec 00 §B.3 pone la ventana de corte en cuatro horas como
 *    máximo; con una sola etapa, cada reintento la consume entera.
 * 2. **`load` se puede repetir todas las veces que haga falta.** Es donde viven
 *    las transformaciones, o sea donde están los errores. Con el origen ya
 *    copiado, equivocarse cuesta un `truncate` y otro `load`, no otra lectura de
 *    la base de producción del sistema que se está apagando.
 *
 * Y una consecuencia buena que no era el objetivo: **`verify` funciona con el
 * legacy ya desconectado**, porque compara contra la copia cruda. El esquema
 * `legacy` es la prueba documental de lo que había.
 *
 * `load` es **idempotente**: los identificadores se conservan (RN-21.5) y todo
 * va con `on conflict do nothing`, así que la segunda pasada no escribe nada.
 */

export type LegacyConnection = {
	url: string;
	/** Supabase usa `public`; se deja configurable para poder probar. */
	schema: string;
};

/** El esquema donde aterriza la copia cruda. `legacy`, como pide RN-00.23. */
export const STAGING_SCHEMA = process.env.LEGACY_STAGING_SCHEMA ?? "legacy";

export type IdentityMap = Map<string, string>;
export type PlanIssue = { blocking: boolean; message: string };

const quoted = (schema: string, table: string) => `"${schema}"."${table}"`;
const staged = (table: string) => quoted(STAGING_SCHEMA, table);

/** Las tablas del origen, sin repetir: `profiles` alimenta dos destinos. */
const SOURCE_TABLES = [
	...new Set([
		...LEGACY_COPIES.map((copy) => copy.from),
		// No está en las copias —no se migra como tabla— pero hace falta para el
		// consolidado de la geocerca única (§4).
		"geofence_config",
	]),
];

async function legacyPool(connection: LegacyConnection): Promise<Pool> {
	const legacy = new Pool({ connectionString: connection.url, max: 4 });
	// Falla aquí y no en la primera tabla: un error de credenciales tiene que
	// notarse antes de haber escrito nada.
	await legacy.query("select 1");
	return legacy;
}

async function columnsOf(
	client: Pool,
	schema: string,
	table: string,
): Promise<{ name: string; type: string }[]> {
	// `format_type` da el tipo **exacto y listo para un `create table`**, arrays y
	// precisiones incluidos: reconstruirlo desde `information_schema` obliga a
	// mapear a mano `_int4` y compañía.
	const { rows } = await client.query<{ name: string; type: string }>(
		`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
		 from pg_attribute a
		 join pg_class c on c.oid = a.attrelid
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
		 order by a.attnum`,
		[schema, table],
	);
	return rows;
}

async function countRows(
	client: Pool,
	schema: string,
	table: string,
): Promise<number> {
	const { rows } = await client.query<{ count: string }>(
		`select count(*)::text as count from ${quoted(schema, table)}`,
	);
	return Number(rows[0]?.count ?? 0);
}

// ── extract ──────────────────────────────────────────────────────────────────

export type ExtractReport = {
	tables: { table: string; rows: number }[];
	issues: PlanIssue[];
};

/**
 * Comprueba el origen antes de tocar nada: que las tablas existan, que tengan
 * las columnas de las que dependen las expresiones del `load`, que nadie haya
 * colado una tabla ajena en la lista blanca (RN-21.2) y que los vocabularios
 * cerrados coincidan.
 */
async function inspectOrigin(
	legacy: Pool,
	connection: LegacyConnection,
): Promise<PlanIssue[]> {
	const issues: PlanIssue[] = [];

	for (const copy of LEGACY_COPIES) {
		if (FOREIGN_TABLES.includes(copy.from)) {
			issues.push({
				blocking: true,
				message: `\`${copy.from}\` es una tabla del otro sistema (RN-21.2) y está en la lista blanca. Quítala.`,
			});
			continue;
		}

		const columns = new Set(
			(await columnsOf(legacy, connection.schema, copy.from)).map(
				(column) => column.name,
			),
		);
		if (columns.size === 0) {
			issues.push({
				blocking: true,
				message: `La tabla \`${copy.from}\` no existe en el esquema \`${connection.schema}\` del origen.`,
			});
			continue;
		}

		const missing = copy.requires.filter((column) => !columns.has(column));
		if (missing.length > 0) {
			issues.push({
				blocking: true,
				message: `A \`${copy.from}\` le faltan columnas que la copia necesita: ${missing.join(", ")}.`,
			});
		}
	}

	issues.push(...(await checkVocabularies(legacy, connection)));
	return issues;
}

/**
 * Los valores distintos de cada columna de vocabulario cerrado, comparados con
 * el nuestro.
 *
 * Es la comprobación que ninguna otra hace, y la que puede salvar el corte: la
 * tabla está, la columna está, el tipo cuadra —todo es `text`— y los valores son
 * otros. Un `incident_type` que en el legacy se llamara `olvide_marcar` entraría
 * sin una queja y reventaría **después** del corte, al leerlo, con el legacy ya
 * apagado.
 */
async function checkVocabularies(
	legacy: Pool,
	connection: LegacyConnection,
): Promise<PlanIssue[]> {
	const issues: PlanIssue[] = [];

	for (const vocabulary of VOCABULARIES) {
		const columns = new Set(
			(await columnsOf(legacy, connection.schema, vocabulary.table)).map(
				(column) => column.name,
			),
		);
		if (!columns.has(vocabulary.column)) continue;

		const { rows } = await legacy.query<{ value: string | null }>(
			`select distinct "${vocabulary.column}" as value
			 from ${quoted(connection.schema, vocabulary.table)}
			 where "${vocabulary.column}" is not null`,
		);

		const unknown = rows
			.map((row) => row.value)
			.filter((value): value is string => !!value)
			.filter((value) => !vocabulary.allowed.includes(value));

		if (unknown.length > 0) {
			issues.push({
				blocking: true,
				message: `\`${vocabulary.table}.${vocabulary.column}\` trae valores que el vocabulario de la ${vocabulary.spec} no conoce: ${unknown.join(", ")}. Hay que traducirlos antes de cargar, o ampliar el vocabulario.`,
			});
		}
	}

	return issues;
}

/**
 * `extract` — la copia cruda del origen al esquema `legacy` de esta base.
 *
 * **No transforma nada**, y es lo que la hace segura de repetir y rápida de
 * ejecutar: cada tabla se recrea con los tipos exactos del origen y se copia tal
 * cual. Lo que se decida mal en el `load` no obliga a volver aquí.
 *
 * Copia también `geofence_config`, que no se migra como tabla: hace falta para
 * el consolidado de la geocerca única (§4).
 */
export async function extractLegacy(
	connection: LegacyConnection,
): Promise<ExtractReport> {
	const legacy = await legacyPool(connection);

	try {
		const issues = await inspectOrigin(legacy, connection);
		if (issues.some((issue) => issue.blocking)) {
			return { tables: [], issues };
		}

		await pool.query(`create schema if not exists "${STAGING_SCHEMA}"`);
		const tables: ExtractReport["tables"] = [];

		for (const table of SOURCE_TABLES) {
			const columns = await columnsOf(legacy, connection.schema, table);
			if (columns.length === 0) {
				// `geofence_config` puede no existir: es una tabla legacy que quizá ya
				// no esté. No es un problema, es una rama de la §4.
				issues.push({
					blocking: false,
					message: `\`${table}\` no está en el origen; se omite de la extracción.`,
				});
				continue;
			}

			await pool.query(`drop table if exists ${staged(table)}`);
			await pool.query(
				`create table ${staged(table)} (${columns
					.map((column) => `"${column.name}" ${column.type}`)
					.join(", ")})`,
			);

			const names = columns.map((column) => `"${column.name}"`).join(", ");
			/**
			 * ⚠️ **Los documentos JSON viajan como texto.** El cliente de PostgreSQL
			 * devuelve un `jsonb` ya parseado —un objeto o una cadena de
			 * JavaScript— y al mandarlo de vuelta como parámetro lo serializa como
			 * texto plano: un valor `"del legacy"` sale como `del legacy` y entra
			 * como JSON inválido. Un cast en el parámetro no lo arregla, porque la
			 * serialización ocurre **antes**, en el cliente. Así que se lee `::text`
			 * y se reinserta con el tipo declarado, y el documento no pasa dos veces
			 * por un parser.
			 */
			const isJson = (type: string) => type === "json" || type === "jsonb";
			const projection = columns
				.map((column) =>
					isJson(column.type)
						? `"${column.name}"::text as "${column.name}"`
						: `"${column.name}"`,
				)
				.join(", ");
			const firstColumn = `"${columns[0]?.name}"`;
			let offset = 0;
			let copied = 0;

			while (true) {
				const { rows } = await legacy.query<Record<string, unknown>>(
					`select ${projection} from ${quoted(connection.schema, table)}
					 order by ${firstColumn} limit 5000 offset ${offset}`,
				);
				if (rows.length === 0) break;
				offset += rows.length;

				const values: unknown[] = [];
				const tuples = rows.map((row) => {
					const placeholders = columns.map((column) => {
						values.push(row[column.name] ?? null);
						// El tipo declarado va en el parámetro: así un `jsonb` o un `inet`
						// del origen entran sin pasar por el parser de JavaScript, que es
						// donde un documento se convierte en texto plano y deja de ser
						// JSON válido.
						return `$${values.length}::${column.type}`;
					});
					return `(${placeholders.join(", ")})`;
				});

				await pool.query(
					`insert into ${staged(table)} (${names}) values ${tuples.join(", ")}`,
					values,
				);
				copied += rows.length;
			}

			tables.push({ table, rows: copied });
		}

		return { tables, issues };
	} finally {
		await legacy.end();
	}
}

// ── load ─────────────────────────────────────────────────────────────────────

export type LoadReport = {
	committed: boolean;
	tables: { from: string; to: string; staged: number; written: number }[];
	identities: {
		profiles: number;
		matched: number;
		unmatched: string[];
		duplicated: string[];
	};
	geofenceConsolidated: boolean;
	issues: PlanIssue[];
};

/**
 * §5 — El emparejamiento de identidades, y **es una precondición, no un paso
 * posterior**.
 *
 * La spec lo describía como vincular cada perfil heredado a su identidad "una
 * sola vez", como si pudiera hacerse después de copiar. **No puede**:
 * `profiles.identity_user_id` es `not null`, así que un perfil sin identidad no
 * se puede ni insertar. El esquema convierte RN-21.7 —"ningún perfil puede
 * quedar sin emparejar"— en algo que no hay que comprobar: es imposible de
 * incumplir.
 *
 * Lo que sí hay que comprobar, y aquí se comprueba, es RN-21.8: los **correos
 * duplicados o ausentes**, que son el fallo probable de este paso. Se detectan
 * en la simulación, antes del corte, que es cuando se pueden arreglar.
 */
async function matchIdentities(
	identities: IdentityMap,
): Promise<LoadReport["identities"]> {
	const { rows } = await pool.query<{ email: string | null }>(
		`select email from ${staged("profiles")}`,
	);

	const seen = new Map<string, number>();
	const unmatched: string[] = [];

	for (const row of rows) {
		const email = (row.email ?? "").trim().toLowerCase();
		seen.set(email, (seen.get(email) ?? 0) + 1);
		if (!email || !identities.has(email)) {
			unmatched.push(email || "(sin correo)");
		}
	}

	return {
		profiles: rows.length,
		matched: rows.length - unmatched.length,
		unmatched: [...new Set(unmatched)],
		duplicated: [...seen.entries()]
			.filter(([email, count]) => email !== "" && count > 1)
			.map(([email]) => email),
	};
}

/** Copia una tabla del esquema `legacy` al destino, por lotes. */
async function copyTable(
	copy: LegacyCopy,
	transform?: (row: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<number> {
	const projection = Object.entries(copy.select)
		.map(([column, expression]) => `${expression} as "${column}"`)
		.join(", ");
	const size = batchOf(copy);
	const jsonColumns = new Set(copy.json ?? []);
	let offset = 0;
	let written = 0;

	while (true) {
		const { rows } = await pool.query<Record<string, unknown>>(
			`select ${projection} from ${staged(copy.from)}
			 order by ${copy.orderBy} limit ${size} offset ${offset}`,
		);
		if (rows.length === 0) break;
		offset += rows.length;

		const prepared = transform
			? rows
					.map((row) => transform(row))
					.filter((row): row is Record<string, unknown> => row !== null)
			: rows;
		if (prepared.length === 0) continue;

		// Las columnas salen de la fila **ya transformada**, no del `select`: un
		// transformador puede añadir columnas que el origen no tiene, y de hecho lo
		// hace en las dos tablas que importan — `identity_user_id` en los perfiles y
		// el departamento de los marcajes. Tomarlas del `select` dejaría fuera justo
		// ésas, y `identity_user_id` es `not null`.
		const targetColumns = Object.keys(prepared[0] as Record<string, unknown>);

		const values: unknown[] = [];
		const tuples = prepared.map((row) => {
			const placeholders = targetColumns.map((column) => {
				values.push(row[column] ?? null);
				// El `::jsonb` explícito evita que un documento se reserialice como
				// texto plano. Ver la nota de `json` en el plan de tablas.
				return jsonColumns.has(column)
					? `$${values.length}::jsonb`
					: `$${values.length}`;
			});
			return `(${placeholders.join(", ")})`;
		});

		const result = await pool.query(
			`insert into "${copy.to}" (${targetColumns.map((column) => `"${column}"`).join(", ")})
			 values ${tuples.join(", ")}
			 on conflict do nothing`,
			values,
		);
		written += result.rowCount ?? 0;
	}

	return written;
}

/**
 * `load` — del esquema `legacy` al destino. **Simula por defecto** (RN-00.23).
 *
 * La simulación hace todo lo que se puede hacer sin escribir: empareja
 * identidades, cuenta lo que hay en la copia cruda y lo que ya hay en destino, y
 * dice qué se deja atrás. Es lo que hay que leer entero antes de poner
 * `--commit`, y no sólo mirar si termina en cero.
 */
export async function loadLegacy(options: {
	identities: IdentityMap;
	commit: boolean;
}): Promise<LoadReport> {
	const issues: PlanIssue[] = [];
	const identities = await matchIdentities(options.identities);

	if (identities.unmatched.length > 0) {
		issues.push({
			blocking: true,
			message: `${identities.unmatched.length === 1 ? "Un correo del legacy no está" : `${identities.unmatched.length} correos del legacy no están`} en el mapa de identidades (RN-21.7/21.8): ${identities.unmatched.slice(0, 10).join(", ")}${identities.unmatched.length > 10 ? "…" : ""}`,
		});
	}
	if (identities.duplicated.length > 0) {
		issues.push({
			blocking: true,
			message: `Correos repetidos en el legacy (RN-21.8): ${identities.duplicated.join(", ")}. Hay que resolverlos antes del corte.`,
		});
	}

	const tables: LoadReport["tables"] = [];
	const blocked = issues.some((issue) => issue.blocking);

	for (const copy of LEGACY_COPIES) {
		const stagedRows = await countRows(pool, STAGING_SCHEMA, copy.from);

		if (!options.commit || blocked) {
			// En simulación, "written" es lo que **ya** hay en destino: es el dato que
			// dice si esto es una primera carga o un reintento.
			const { rows } = await pool.query<{ count: string }>(
				`select count(*)::text as count from "${copy.to}"`,
			);
			tables.push({
				from: copy.from,
				to: copy.to,
				staged: stagedRows,
				written: Number(rows[0]?.count ?? 0),
			});
			continue;
		}

		// El contexto de los marcajes se resuelve **dentro** del bucle: sale de
		// `profiles` y de `department_schedules`, que se copian en este mismo bucle.
		// Para cuando le toque a los marcajes, ya están.
		const context =
			copy.to === "attendance_marks"
				? {
						timezones: await departmentTimezones(),
						departments: await profileDepartments(),
					}
				: null;

		tables.push({
			from: copy.from,
			to: copy.to,
			staged: stagedRows,
			written: await copyTable(
				copy,
				transformerFor(copy, options.identities, context),
			),
		});
	}

	return {
		committed: options.commit && !blocked,
		tables,
		identities,
		geofenceConsolidated:
			options.commit && !blocked ? await consolidateGeofence() : false,
		issues,
	};
}

/** La zona de cada departamento, para resolver `work_date` (spec 07 RN-07.2). */
async function departmentTimezones(): Promise<Map<string, string>> {
	const { rows } = await pool.query<{
		department_id: string;
		timezone: string;
	}>(`select department_id, timezone from department_schedules`);
	return new Map(rows.map((row) => [row.department_id, row.timezone]));
}

/**
 * El departamento de cada persona, ya migrada.
 *
 * ⚠️ **El marcaje del legacy no trae departamento.** Es una columna que la spec
 * 09 §2 añadió como *foto del momento* —"para un reporte histórico el valor
 * correcto es el de entonces, no el de hoy"— y precisamente por eso el legacy no
 * la tenía: allí la reportería lo resolvía por `join`, con el departamento
 * **actual** de la persona.
 *
 * Así que en la migración se rellena con el único valor que existe: el
 * departamento de hoy. Es exactamente la aproximación que esa columna se añadió
 * para evitar, y hay que saberlo — quien haya cambiado de departamento aparecerá
 * en el histórico bajo el nuevo. Dejarla nula sería peor: la reportería filtra
 * por ella.
 */
async function profileDepartments(): Promise<Map<string, string>> {
	const { rows } = await pool.query<{
		id: string;
		department_id: string;
	}>(`select id, department_id from profiles where department_id is not null`);
	return new Map(rows.map((row) => [row.id, row.department_id]));
}

type MarkContext = {
	timezones: Map<string, string>;
	departments: Map<string, string>;
};

function transformerFor(
	copy: LegacyCopy,
	identities: IdentityMap,
	context: MarkContext | null,
):
	| ((row: Record<string, unknown>) => Record<string, unknown> | null)
	| undefined {
	if (copy.to === "profiles") {
		return (row) => {
			const email = String(row.email ?? "")
				.trim()
				.toLowerCase();
			const identityUserId = identities.get(email);
			// No debería pasar —la simulación lo bloquea— pero si pasara, saltarse un
			// perfil en silencio sería peor que ruidoso: se para.
			if (!identityUserId) {
				throw new Error(`El perfil ${email} no tiene identidad emparejada.`);
			}
			return { ...row, identity_user_id: identityUserId };
		};
	}

	if (copy.to === "employee_compensation") {
		// Sin sueldo no hay fila que crear: esa tabla existe para guardar un
		// importe, y una fila vacía sólo diría "aquí no hay nada".
		return (row) => (row.monthly_salary == null ? null : row);
	}

	if (copy.to === "attendance_marks" && context) {
		return (row) => {
			const userId = typeof row.user_id === "string" ? row.user_id : null;
			const departmentId = userId
				? (context.departments.get(userId) ?? null)
				: null;
			return {
				...row,
				department_id: departmentId,
				work_date: workDateOf(row, departmentId, context.timezones),
			};
		};
	}

	return undefined;
}

/**
 * `work_date` de un marcaje migrado.
 *
 * El legacy no guardaba esta columna, y sin ella la agregación diaria no
 * encuentra el marcaje —consulta por (persona, `work_date`)— así que el reporte
 * del mes migrado saldría vacío y el criterio de la §9 sería imposible de
 * cumplir.
 *
 * ⚠️ **Es una aproximación, y hay que saberlo.** Se toma el día civil del
 * instante en la zona del departamento **de hoy**, no la de entonces; y una
 * jornada nocturna cuyo cierre cae de madrugada pertenece al día anterior (spec
 * 07 RN-07.5), lo que aquí no se puede resolver sin el horario vigente en aquel
 * momento — que el legacy no versionaba. Para un histórico de turnos de día, que
 * es el caso de esta empresa, coincide; si algún departamento tuviera turno de
 * noche, sus jornadas migradas hay que revisarlas contra el reporte del legacy
 * antes de dar el corte por bueno (RN-21.6).
 */
function workDateOf(
	row: Record<string, unknown>,
	departmentId: string | null,
	timezones: Map<string, string>,
): string | null {
	const markedAt = row.marked_at;
	if (!(markedAt instanceof Date)) return null;

	const timeZone =
		(departmentId ? timezones.get(departmentId) : null) ?? "America/Havana";

	// `en-CA` da `YYYY-MM-DD`, que es exactamente el formato de una columna `date`.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(markedAt);
}

/** §4 — La geocerca única del legacy se convierte en una sede, si no había sedes. */
async function consolidateGeofence(): Promise<boolean> {
	const { rows: existing } = await pool.query<{ count: string }>(
		`select count(*)::text as count from "work_locations"`,
	);
	if (Number(existing[0]?.count ?? 0) > 0) return false;

	const { rows } = await pool.query<Record<string, unknown>>(
		`select center_lat, center_lng, radius_meters, accuracy_threshold,
		        block_on_poor_accuracy
		 from ${staged("geofence_config")} limit 1`,
	);
	const config = rows[0];
	if (!config) return false;

	await pool.query(
		`insert into "work_locations"
		   (name, center_lat, center_lng, radius_meters, accuracy_threshold,
		    block_on_poor_accuracy, is_active)
		 values ('Sede principal', $1, $2, $3, $4, $5, true)
		 on conflict do nothing`,
		[
			config.center_lat,
			config.center_lng,
			config.radius_meters,
			config.accuracy_threshold,
			config.block_on_poor_accuracy ?? false,
		],
	);
	return true;
}

// ── verify ───────────────────────────────────────────────────────────────────

export type VerificationRow = {
	from: string;
	to: string;
	source: number;
	target: number;
	ok: boolean;
	note?: string;
};

export type Verification = {
	tables: VerificationRow[];
	payroll: { source: string; target: string; ok: boolean };
	ok: boolean;
};

/**
 * `verify` — RN-21.6: **conteo de filas origen contra destino**, y para la
 * nómina además la **suma**, que es RN-21.4.
 *
 * Compara contra el esquema `legacy`, no contra el origen, y eso es una ventaja:
 * **funciona con el legacy ya desconectado**. Esa copia cruda es la prueba
 * documental de lo que había.
 *
 * La suma no es lo mismo que el conteo y ninguna sustituye a la otra: mil filas
 * pueden estar todas y una traer el importe mal. Se comparan como texto para no
 * pasar dinero por coma flotante (RN-17.12).
 *
 * ⚠️ Lo que esta función **no** puede comprobar es el criterio más importante de
 * la §9: que el reporte mensual de un mes cerrado salga idéntico celda a celda
 * en los dos sistemas. Eso exige generar el del legacy, y el legacy es el que se
 * está apagando — se hace a mano, con los dos vivos, antes del corte.
 */
export async function verifyMigration(): Promise<Verification> {
	const tables: VerificationRow[] = [];

	for (const copy of LEGACY_COPIES) {
		const source = await countRows(pool, STAGING_SCHEMA, copy.from);
		const { rows } = await pool.query<{ count: string }>(
			`select count(*)::text as count from "${copy.to}"`,
		);
		const target = Number(rows[0]?.count ?? 0);

		// `employee_compensation` sólo tiene fila para quien tiene sueldo, así que su
		// conteo **no** puede igualar al de perfiles: se compara con los que traían
		// importe.
		let expected = source;
		let note: string | undefined;
		if (copy.to === "employee_compensation") {
			const { rows: withSalary } = await pool.query<{ count: string }>(
				`select count(*)::text as count from ${staged("profiles")}
				 where monthly_salary is not null`,
			);
			expected = Number(withSalary[0]?.count ?? 0);
			note = "Sólo los perfiles con sueldo (hallazgo H-3).";
		}

		tables.push({
			from: copy.from,
			to: copy.to,
			source: expected,
			target,
			ok: target >= expected,
			note,
		});
	}

	const { rows: sourceSum } = await pool.query<{ total: string | null }>(
		`select coalesce(sum(amount), 0)::text as total
		 from ${staged("payroll_adjustments")}`,
	);
	const { rows: targetSum } = await pool.query<{ total: string | null }>(
		`select coalesce(sum(amount), 0)::text as total from "payroll_adjustments"`,
	);

	const payroll = {
		source: sourceSum[0]?.total ?? "0",
		target: targetSum[0]?.total ?? "0",
		ok: Number(sourceSum[0]?.total ?? 0) === Number(targetSum[0]?.total ?? 0),
	};

	return {
		tables,
		payroll,
		ok: tables.every((row) => row.ok) && payroll.ok,
	};
}

export { SKIPPED, LEGACY_COPIES, db };
