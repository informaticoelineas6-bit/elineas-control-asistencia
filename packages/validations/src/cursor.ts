import { z } from "zod";

/**
 * Cursor de paginación por *keyset*, compartido.
 *
 * Nació en la bitácora (spec 18 §6) y lo necesitó a continuación la lista
 * completa de notificaciones (spec 14 §8). Las dos tablas tienen la misma forma
 * —crecen por el extremo que se está leyendo y se ordenan por
 * `created_at desc, id desc`— y por tanto el mismo problema: **con `offset`, una
 * fila nueva durante la lectura desplaza la página siguiente y repite una**.
 *
 * El cursor lleva el instante **y** el id de la última fila leída. El id no es
 * decorativo: dos entradas escritas en la misma transacción comparten
 * milisegundo más veces de lo que parece, y sin él una de las dos se perdería al
 * pasar de página.
 *
 * Va **en claro**, separado por `|`, porque no esconde nada —los dos datos están
 * en la fila que el cliente acaba de recibir— y un cursor opaco sólo añade un
 * `base64` que hay que descifrar a mano cuando algo falla.
 */
export const keysetCursorSchema = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-fA-F-]{36}$/,
		"El cursor de paginación no es válido.",
	);

export const encodeKeysetCursor = (row: {
	createdAt: string;
	id: string;
}): string => `${row.createdAt}|${row.id}`;

export function decodeKeysetCursor(
	cursor: string,
): { createdAt: string; id: string } | null {
	// Por el **último** separador: si algún día el instante llevara un `|` dentro,
	// partir por el primero devolvería un id truncado y la página siguiente
	// empezaría en otro sitio, sin fallar.
	const separator = cursor.lastIndexOf("|");
	if (separator < 0) return null;
	const createdAt = cursor.slice(0, separator);
	const id = cursor.slice(separator + 1);
	return createdAt && id ? { createdAt, id } : null;
}
