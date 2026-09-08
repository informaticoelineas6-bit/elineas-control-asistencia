/**
 * Paso 5 del CI (spec 22 §2) — **el esquema del repositorio y sus migraciones no
 * se pueden separar.**
 *
 * Es el punto 70 del legacy, la *deriva de esquema*: allí había tablas en la base
 * que no estaban en ninguna migración y migraciones que nadie había aplicado, así
 * que nadie sabía qué esquema era el de verdad.
 *
 * La comprobación es simple y no necesita base de datos: `drizzle-kit generate`
 * compara `schema.ts` con las instantáneas de `drizzle/meta`. **Si genera algo,
 * es que el esquema cambió y su migración no se escribió.** Un cambio así pasa
 * las pruebas —que corren sobre una base migrada a mano en desarrollo— y se cae
 * en el despliegue siguiente, que es el peor momento para descubrirlo.
 *
 * Lo que este chequeo **no** cubre es la otra mitad de esa deriva: que la base
 * *desplegada* esté al día. Eso es del despliegue (`bun run db:migrate`) y de la
 * [21](../packages/specs/21-migracion-desde-legacy.md) §8.
 */

const DRIZZLE_DIR = "apps/backend/drizzle";

async function git(...args: string[]): Promise<string> {
	const result = Bun.spawnSync(["git", ...args]);
	return new TextDecoder().decode(result.stdout).trim();
}

const dirtyBefore = await git("status", "--porcelain", DRIZZLE_DIR);
if (dirtyBefore) {
	// En local, con migraciones a medio escribir, este chequeo no puede distinguir
	// "deriva" de "trabajo en curso" — y limpiar el directorio sería destruirlo.
	console.log(
		`Hay cambios sin confirmar en ${DRIZZLE_DIR}; el chequeo de deriva se salta.`,
	);
	console.log(dirtyBefore);
	process.exit(0);
}

const generate = Bun.spawnSync({
	cmd: ["bunx", "drizzle-kit", "generate", "--name", "drift_check"],
	cwd: "apps/backend",
	// `drizzle.config.ts` exige la variable aunque `generate` no se conecte a
	// nada: compara contra las instantáneas del repositorio, no contra la base.
	env: {
		...process.env,
		DATABASE_URL:
			process.env.DATABASE_URL ?? "postgresql://drift:drift@127.0.0.1:5432/drift",
	},
	stdout: "pipe",
	stderr: "pipe",
});

if (generate.exitCode !== 0) {
	console.error(new TextDecoder().decode(generate.stderr));
	console.error("`drizzle-kit generate` falló, así que no se pudo comprobar la deriva.");
	process.exit(1);
}

const dirtyAfter = await git("status", "--porcelain", DRIZZLE_DIR);

// Se deja el directorio como estaba, en local y en CI: este chequeo mira, no
// escribe. La migración la escribe una persona, con su nombre y su intención.
if (dirtyAfter) {
	await git("checkout", "--", DRIZZLE_DIR);
	Bun.spawnSync(["git", "clean", "-fd", DRIZZLE_DIR]);

	console.error("Deriva de esquema (spec 22 §2, paso 5):");
	console.error(dirtyAfter);
	console.error(
		"\n`schema.ts` tiene cambios sin migración. Ejecuta `bun run db:generate`, revisa el SQL y confírmalo en el mismo cambio.",
	);
	process.exit(1);
}

console.log("Esquema y migraciones: al día.");
