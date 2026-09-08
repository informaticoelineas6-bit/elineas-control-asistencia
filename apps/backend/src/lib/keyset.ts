import { type Column, sql } from "drizzle-orm";

/**
 * El instante de una fila **con microsegundos**, en el formato del cursor
 * compartido (`@elineas/validations`, `cursor.ts`).
 *
 * ⚠️ **Existe por un fallo que una prueba encontró, y que habría sido muy difícil
 * de diagnosticar en producción.** `timestamptz` de PostgreSQL guarda
 * **microsegundos**; el `Date` de JavaScript sólo llega a **milisegundos**. Así
 * que un cursor construido con `row.createdAt.toISOString()` lleva un instante
 * *anterior* al real —`…123456` se convierte en `…123`—, y la comparación de la
 * página siguiente
 *
 * ```sql
 * (created_at, id) < (cursor_at, cursor_id)
 * ```
 *
 * deja fuera a **todas las filas de ese mismo microsegundo**, porque su
 * `created_at` es mayor que el truncado y la comparación ni llega a mirar el id.
 * Las filas de ese mismo microsegundo son precisamente las hermanas escritas en
 * la misma transacción —una cascada de la spec 18 RN-18.8, dos notificaciones a
 * la vez—, así que el síntoma es **una entrada que desaparece al pasar de
 * página**: no falla nada, no hay error, sólo falta una fila.
 *
 * La solución es no dejar que el instante pase por JavaScript: PostgreSQL lo
 * formatea con su precisión completa y el cursor viaja tal cual.
 */
export const cursorAt = (column: Column) =>
	sql<string>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
