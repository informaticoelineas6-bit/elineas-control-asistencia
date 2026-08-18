import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";

/**
 * `zValidator` con **nuestro formato de error**.
 *
 * Por defecto, el validador de Hono responde su propio 400 con el `ZodError`
 * serializado entero y no pasa por `app.onError`, así que el frontend no encuentra
 * el campo `error` que espera y acaba mostrando un mensaje genérico. Con esto, un
 * "Número de teléfono no válido para ningún país conocido" llega tal cual a quien
 * está rellenando el formulario, que es el único sitio donde sirve.
 *
 * Se manda el mensaje del **primer** problema: los formularios de esta aplicación
 * tienen pocos campos y enumerarlos todos en una línea se lee peor que arreglar el
 * primero y volver a intentarlo.
 */
export function validate<
	T extends ZodType,
	Target extends keyof ValidationTargets,
>(target: Target, schema: T) {
	return zValidator(target, schema, (result) => {
		if (result.success) return;

		const issue = result.error.issues.at(0);
		throw new HTTPException(400, {
			message: issue?.message ?? "Los datos enviados no son válidos.",
		});
	});
}
