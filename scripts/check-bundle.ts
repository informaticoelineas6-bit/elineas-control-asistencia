/**
 * RQ-22.4 — Presupuesto de tamaño del cliente, verificado en CI (spec 22 §5).
 *
 * El punto 72 del legacy es un bundle de **1,8 MB minificado sin dividir por
 * rutas**: quien abría la pantalla de marcaje se descargaba la reportería, el
 * mapa y el panel de superadmin. En TanStack Start la división por ruta es el
 * comportamiento esperado, y la spec dice exactamente qué hacer con eso:
 * *"verificarlo, no darlo por hecho"*.
 *
 * De ahí las tres comprobaciones. La segunda y la tercera son las que de verdad
 * detectan una regresión de división —un `import` mal puesto que arrastre medio
 * proyecto al chunk de entrada no cambia mucho el total, pero hunde el reparto—.
 *
 * Se mide **sin comprimir** a propósito: es el número que no depende de la
 * versión de gzip del servidor ni de su configuración, así que compara igual hoy
 * y dentro de un año.
 */

const ASSETS = "apps/frontend/.output/public/assets";

/** Con holgura sobre lo medido, para que avise de una regresión y no del ruido. */
const BUDGET = {
	totalKb: 2000,
	largestChunkKb: 400,
	minChunks: 20,
};

const { Glob } = await import("bun");

const files: { name: string; kb: number }[] = [];
for (const name of new Glob("*.js").scanSync({ cwd: ASSETS })) {
	files.push({ name, kb: Bun.file(`${ASSETS}/${name}`).size / 1024 });
}

if (files.length === 0) {
	console.error(
		`No hay nada en ${ASSETS}. ¿Se ejecutó \`bun run build\` antes de esto?`,
	);
	process.exit(1);
}

files.sort((a, b) => b.kb - a.kb);
const total = files.reduce((sum, file) => sum + file.kb, 0);
const largest = files[0];

const round = (kb: number) => Math.round(kb);

console.log(`JavaScript de cliente: ${round(total)} KB en ${files.length} trozos`);
for (const file of files.slice(0, 5)) {
	console.log(`  ${String(round(file.kb)).padStart(5)} KB  ${file.name}`);
}

const failures: string[] = [];
if (total > BUDGET.totalKb) {
	failures.push(
		`El total es ${round(total)} KB y el presupuesto son ${BUDGET.totalKb} KB.`,
	);
}
if (largest && largest.kb > BUDGET.largestChunkKb) {
	failures.push(
		`El trozo más grande (${largest.name}) pesa ${round(largest.kb)} KB y el máximo son ${BUDGET.largestChunkKb} KB.`,
	);
}
if (files.length < BUDGET.minChunks) {
	failures.push(
		`Sólo hay ${files.length} trozos: la división por ruta dejó de funcionar (mínimo ${BUDGET.minChunks}).`,
	);
}

if (failures.length > 0) {
	console.error("\nPresupuesto de tamaño excedido (spec 22 RQ-22.4):");
	for (const failure of failures) console.error(`  · ${failure}`);
	console.error(
		"\nSi el crecimiento es legítimo, sube el presupuesto en este archivo **en el mismo cambio** y di por qué.",
	);
	process.exit(1);
}

console.log("Presupuesto de tamaño: dentro de límites.");
