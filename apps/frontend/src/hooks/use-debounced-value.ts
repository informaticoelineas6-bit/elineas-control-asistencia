import { useEffect, useState } from "react";

/**
 * Devuelve `value` con retardo: no cambia hasta que pasan `delay` milisegundos sin
 * que llegue un valor nuevo.
 *
 * Se usa para los filtros de las tablas. Sin esto, cada tecla de la búsqueda
 * dispara una consulta al backend —ocho peticiones para escribir "Gabriela"—, y las
 * respuestas pueden llegar desordenadas y pintar resultados de una búsqueda que ya
 * no es la que se está escribiendo.
 *
 * El campo sigue siendo inmediato: lo que se retrasa es la consulta, no el teclado.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
	const [debounced, setDebounced] = useState(value);

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);

	return debounced;
}
