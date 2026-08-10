import { db } from "#/db";
import { departments } from "#/db/schema";

/**
 * Semilla inicial de departamentos (spec 01 §3).
 *
 * "Administración" tiene semántica especial: es donde se fuerza a los
 * `global_manager` (RN-03.6, decisión abierta) y no debe poder eliminarse
 * mientras existan.
 *
 *   bun run db:seed
 */
const SEED = [
	"Picker and Packer",
	"Expedición",
	"Transporte",
	"Inventario",
	"Estibadores",
	"Administración",
];

const inserted = await db
	.insert(departments)
	.values(SEED.map((name) => ({ name })))
	.onConflictDoNothing({ target: departments.name })
	.returning({ name: departments.name });

console.log(
	inserted.length
		? `Departamentos creados: ${inserted.map((d) => d.name).join(", ")}`
		: "Sin cambios: los departamentos ya existían.",
);

process.exit(0);
