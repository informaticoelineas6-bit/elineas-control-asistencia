import { pool } from "#/db";

/**
 * Cuenta las consultas que salen del pool mientras corre `run`.
 *
 * **Instrumentación de pruebas, y sólo de pruebas**: nada de `src/` la importa.
 * Vive en su propio directorio para que eso se vea sin abrir el archivo.
 *
 * Es lo que hace comprobable RQ-22.5 —"prohibido el N+1 en los paneles"— sin
 * tener que acertar la cifra correcta: se mide **el mismo endpoint con 5
 * personas y con 205**, y lo que se afirma es que el número no cambia. Una
 * prueba que dijera "hace exactamente 11 consultas" se rompería con cualquier
 * mejora legítima; ésta sólo se rompe cuando aparece un N+1.
 *
 * Se envuelve `query` porque es por donde Drizzle saca las lecturas sueltas, que
 * es todo lo que hacen los paneles y la reportería. Una transacción pasaría por
 * `connect` y no se contaría: si algún día hay que medir una escritura, hay que
 * envolver los dos — contar sólo uno da un número tranquilizador y falso.
 */
export async function countQueries(
	run: () => Promise<unknown>,
): Promise<number> {
	let count = 0;
	const original = pool.query.bind(pool);

	Object.assign(pool, {
		query: (...args: unknown[]) => {
			count += 1;
			return (original as (...a: unknown[]) => unknown)(...args);
		},
	});

	try {
		await run();
	} finally {
		Object.assign(pool, { query: original });
	}
	return count;
}
