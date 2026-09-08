import { readFile } from "node:fs/promises";
import {
	extractLegacy,
	type IdentityMap,
	type LegacyConnection,
	loadLegacy,
	SKIPPED,
	STAGING_SCHEMA,
	verifyMigration,
} from "#/migration/legacy.ts";

/**
 * La orden de migración (spec 21; la forma la fija la spec 00 RN-00.23).
 *
 * ```
 * bun run migrate:legacy extract          # origen → esquema `legacy`
 * bun run migrate:legacy load             # simulación: no escribe nada
 * bun run migrate:legacy load --commit    # escribe
 * bun run migrate:legacy verify           # conteos y sumas
 * ```
 *
 * **Tres comandos**, que es el criterio medible de la spec 00 §B.3, y el del
 * medio simula por defecto: escribir en la base de producción del corte no puede
 * ser el comportamiento de un comando sin argumentos.
 *
 * Variables:
 *
 * - `LEGACY_DATABASE_URL` — la base del legacy. Sólo se lee de ella, y sólo en
 *   `extract`.
 * - `LEGACY_SCHEMA` — `public` por defecto, que es el de Supabase.
 * - `IDENTITY_MAP` — el archivo de emparejamiento (§5), CSV o JSON. Es lo que
 *   sale del alta masiva del Identity Server: correo e identificador.
 *
 * **La simulación es lo que hay que leer entero**, y no sólo mirar si termina en
 * cero: dice cuántas filas hay en la copia cruda, cuántas hay ya en destino
 * —o sea si esto es un reintento—, qué se deja atrás y por qué, y qué correos no
 * van a poder entrar el lunes.
 */

const [command = "load", ...flags] = process.argv.slice(2);
const line = (text = "") => console.log(text);

function connection(): LegacyConnection {
	const url = process.env.LEGACY_DATABASE_URL;
	if (!url) {
		console.error(
			"Falta LEGACY_DATABASE_URL: la cadena de conexión a la base del legacy (sólo lectura).",
		);
		process.exit(1);
	}
	return { url, schema: process.env.LEGACY_SCHEMA ?? "public" };
}

/**
 * El mapa de identidades, en CSV (`correo,identificador`) o JSON (`[{email,
 * identityUserId}]`).
 *
 * Se admiten los dos porque el alta masiva del IS puede devolver cualquiera y
 * esto no es sitio para pelearse con un formato: lo que importa es que **no
 * falte nadie**, y de eso avisa la simulación.
 */
async function identityMap(): Promise<IdentityMap> {
	const path = process.env.IDENTITY_MAP;
	if (!path) {
		console.error(
			"Falta IDENTITY_MAP: el archivo que empareja cada correo del legacy con su identidad del Identity Server (§5).",
		);
		process.exit(1);
	}

	const raw = await readFile(path, "utf8");
	const map: IdentityMap = new Map();

	if (path.endsWith(".json")) {
		const parsed = JSON.parse(raw) as {
			email: string;
			identityUserId: string;
		}[];
		for (const entry of parsed) {
			map.set(entry.email.trim().toLowerCase(), entry.identityUserId);
		}
		return map;
	}

	for (const row of raw.split("\n")) {
		const [email, identityUserId] = row.split(",");
		if (!email || !identityUserId) continue;
		const key = email.trim().toLowerCase();
		// La cabecera del CSV, si la trae, se descarta sola: "correo" no es un correo.
		if (!key.includes("@")) continue;
		map.set(key, identityUserId.trim());
	}
	return map;
}

function printIssues(issues: { blocking: boolean; message: string }[]): number {
	if (issues.length === 0) return 0;
	line();
	line("Avisos");
	for (const issue of issues) {
		line(`  ${issue.blocking ? "✖" : "·"} ${issue.message}`);
	}
	return issues.filter((issue) => issue.blocking).length;
}

if (command === "extract") {
	const report = await extractLegacy(connection());

	if (report.tables.length > 0) {
		line(`Copiado al esquema \`${STAGING_SCHEMA}\` (crudo, sin transformar)`);
		for (const table of report.tables) {
			line(`  ${String(table.rows).padStart(8)}  ${table.table}`);
		}
	}

	const blocking = printIssues(report.issues);
	line();
	line(
		blocking > 0
			? `El origen no está listo: ${blocking} cosa(s) que arreglar antes de extraer.`
			: "Extracción terminada. El legacy ya se puede desconectar: `load` y `verify` trabajan sobre la copia.",
	);
	process.exit(blocking > 0 ? 1 : 0);
}

if (command === "load") {
	const commit = flags.includes("--commit");
	const report = await loadLegacy({
		identities: await identityMap(),
		commit,
	});

	line(commit ? "Carga" : "Simulación (no se ha escrito nada)");
	line(
		`  ${"en la copia".padStart(12)}  ${(commit ? "escritas" : "ya en destino").padStart(14)}  tabla`,
	);
	for (const table of report.tables) {
		line(
			`  ${String(table.staged).padStart(12)}  ${String(table.written).padStart(14)}  ${table.to}`,
		);
	}

	line();
	line("Identidades (§5)");
	line(`  perfiles en la copia: ${report.identities.profiles}`);
	line(`  emparejados:          ${report.identities.matched}`);
	line(`  sin emparejar:        ${report.identities.unmatched.length}`);
	if (report.identities.duplicated.length > 0) {
		line(`  correos repetidos:    ${report.identities.duplicated.join(", ")}`);
	}

	if (report.geofenceConsolidated) {
		line();
		line("La geocerca única del legacy se consolidó como sede (§4).");
	}

	line();
	line("Lo que NO se trae, y por qué (§4, §7)");
	for (const skipped of SKIPPED) {
		line(`  · ${skipped.table}: ${skipped.because}`);
	}

	const blocking = printIssues(report.issues);
	line();
	if (blocking > 0) {
		line(
			`La carga no se puede hacer todavía: ${blocking} cosa(s) que arreglar.`,
		);
	} else if (commit) {
		line(
			"Carga terminada. Ahora: `verify`, y después recalcular los hechos diarios del histórico (spec 16 RN-16.9) para que la reportería vea lo migrado.",
		);
	} else {
		line("La simulación cuadra. Para escribir: `load --commit`.");
	}
	process.exit(blocking > 0 ? 1 : 0);
}

if (command === "verify") {
	const verification = await verifyMigration();

	line("Conteo copia → destino (RN-21.6)");
	for (const row of verification.tables) {
		line(
			`  ${row.ok ? "·" : "✖"} ${row.to}: ${row.source} → ${row.target}${row.note ? `  (${row.note})` : ""}`,
		);
	}

	line();
	line(
		`${verification.payroll.ok ? "·" : "✖"} Suma de ajustes de nómina (RN-21.4): ${verification.payroll.source} → ${verification.payroll.target}`,
	);

	line();
	line(
		verification.ok
			? "Verificación conforme. Falta lo que esto no puede comprobar: el reporte de un mes cerrado, celda a celda, en los dos sistemas (§9)."
			: "Verificación NO conforme: la migración no está terminada (RN-21.6).",
	);
	process.exit(verification.ok ? 0 : 1);
}

console.error(`Orden desconocida: ${command}. Usa extract, load o verify.`);
process.exit(1);
