import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";

/**
 * Validación de teléfono, **la misma que usa el Identity Server** de Elineas
 * (`modules/common/lib/phone.ts` en su frontend): `libphonenumber-js` con
 * `isValid()`, y por tanto formato internacional con prefijo de país.
 *
 * Se replica en vez de inventar una regla propia para que un teléfono válido en un
 * sistema de Elineas lo sea en todos: el mismo dato se teclea en la ficha de
 * empleado del IS y en el perfil de aquí, y dos validaciones distintas sobre el
 * mismo campo terminan produciendo dos formatos distintos en la misma empresa.
 *
 * El país por defecto de la interfaz es **CU**, igual que en el IS; eso vive en el
 * componente de entrada, no aquí. Este esquema exige el número ya en formato
 * internacional porque no asume ningún país.
 */
export const phoneSchema = z
	.string()
	.refine((value) => parsePhoneNumberFromString(value)?.isValid() ?? false, {
		message: "Número de teléfono no válido para ningún país conocido",
	});

/**
 * Teléfono opcional tal como llega de un formulario: puede venir vacío, y vacío
 * significa "sin teléfono", no "teléfono inválido".
 */
export const optionalPhoneSchema = phoneSchema
	.or(z.literal(""))
	.nullable()
	.transform((value) => (value ? value : null));
