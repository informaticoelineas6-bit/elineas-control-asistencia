import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	throw new Error(
		"DATABASE_URL no está configurada: el backend no puede arrancar sin base de datos.",
	);
}

/**
 * El pool se crea aquí y **se exporta** en vez de dejar que Drizzle lo cree por
 * dentro a partir de la cadena de conexión.
 *
 * Es lo que permite contar consultas desde una prueba, y eso no es un capricho:
 * la spec 15 §7 tiene un criterio de aceptación que dice literalmente *"un panel
 * con 200 empleados no dispara 200 consultas (test de conteo de consultas)"*.
 * Sin acceso al pool, ese criterio no se puede comprobar más que leyendo el
 * código, que es exactamente como el legacy acabó con su N+1 (punto 55).
 */
export const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
