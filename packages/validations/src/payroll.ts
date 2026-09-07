import { z } from "zod";
import { currencySchema } from "./currency.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Vocabulario de nómina (spec 17) que ya necesita la spec 13.
 *
 * ⚠️ **La spec 17 no está construida.** Aquí vive sólo lo que el descuento
 * automático de RN-13.4 produce de verdad hoy: la tabla de ajustes, su
 * vocabulario y el periodo al que pertenece un ajuste. Los ajustes manuales
 * (RN-17.8), la edición de sueldos, `/payroll/*` y los totales por periodo
 * (§5, §6) **no están**, y por eso su vocabulario tampoco: es el mismo criterio
 * que llevaba la spec 07 al declarar sólo la parte del marcaje que producía —
 * enumerar de golpe lo que ninguna línea de código puede devolver deja a la UI
 * sin saber qué es real.
 *
 * Lo que sí queda cerrado aquí, porque el descuento no se puede escribir sin
 * decidirlo:
 *
 * - **RN-17.3 — el divisor es configuración** (`payroll_daily_divisor`, default
 *   30), no el 30 fijo dentro de una función SQL del legacy.
 * - **RN-17.12 (decisión 1 de la spec 17) — el descuento se calcula en
 *   PostgreSQL con `numeric` y se redondea a 2 decimales, media al alza.** No
 *   se calcula en JavaScript: el sueldo es `numeric(12,2)` y pasarlo por un
 *   `double` le quita exactitud a un dato de dinero, que es la razón por la que
 *   la compensación de la spec 02 ya viaja como cadena. `round(x, 2)` de
 *   PostgreSQL sobre `numeric` es media al alza y exacto.
 */

/** Spec 17 §2. Sólo `unjustified_absence` se produce hoy. */
export const payrollAdjustmentCategorySchema = z.enum([
	"unjustified_absence",
	/**
	 * RN-17.6 — Existe para ajustes **manuales** que un administrador decida
	 * registrar. Las vacaciones **no descuentan**: son días pagados, y es una
	 * decisión de negocio explícita, no un olvido.
	 */
	"vacation",
	"other",
]);

/** RN-17.4 — Un ajuste nunca se borra: se marca `reverted`. */
export const payrollAdjustmentStatusSchema = z.enum(["active", "reverted"]);

/**
 * Qué pasó con la nómina al revisar una ausencia (spec 13 §6).
 *
 * La spec pedía `created | reverted | unchanged`; hay un cuarto caso que no
 * estaba y que RN-17.7 sí describe: **no hay sueldo configurado**, y entonces no
 * se crea el ajuste. Sin un valor propio, ese caso se confundiría con
 * `unchanged` y la advertencia que RN-17.7 exige —"visible para el
 * administrador, no fallar en silencio"— no tendría dónde apoyarse.
 */
export const payrollEffectSchema = z.enum([
	"created",
	"reverted",
	"unchanged",
	"skipped_no_salary",
]);

/**
 * El efecto económico, tal como se le devuelve a quien revisó.
 *
 * **`amount` puede ser nulo con `effect: "created"`**, y no es un descuido: es
 * RN-17.1 y el hallazgo H-3. Quien justifica es el `department_head`, que **no
 * tiene ni debe tener acceso al sueldo de nadie**; enseñarle el importe del
 * descuento le enseña el sueldo multiplicado por el divisor. Así que ve el
 * hecho —"se aplicó un descuento de un día"— y un rol administrativo ve además
 * la cifra. La §7 de la spec 13 pedía la confirmación económica explícita en
 * pantalla; se cumple sin romper la barrera, que es lo que esa spec llama su
 * "barrera de privilegios" en RN-13.5.
 */
export const payrollAdjustmentEffectSchema = z.object({
	effect: payrollEffectSchema,
	/** Con signo, como en la tabla: negativo es descuento. Nulo si no se puede mostrar. */
	amount: z.string().nullable(),
	currency: currencySchema.nullable(),
	/** Periodo al que se imputa (§7). Nulo si no hubo ajuste. */
	effectivePeriod: isoDateSchema.nullable(),
});

/**
 * Spec 17 §7 — A qué periodo de nómina pertenece un ajuste: **el de la fecha de
 * la ausencia**, no el de la fecha en que alguien la revisó.
 *
 * Es la propuesta de esa spec y responde su propia pregunta: *"un descuento por
 * una ausencia de marzo registrado en abril, ¿a qué mes pertenece?"* — a marzo.
 * Se guarda como el **día 1 del mes**, que ordena y se filtra por rango como
 * cualquier otra fecha; una cadena `yyyy-MM` obligaría a convertir en cada
 * consulta.
 *
 * Lo que sigue abierto es el **cierre** de periodo (RN-13.9 y la decisión 2 de
 * la spec 17), que es otra cosa: esta función dice a qué mes pertenece un
 * ajuste, no si ese mes admite todavía cambios.
 */
export function effectivePeriodOf(date: string): string {
	return `${date.slice(0, 7)}-01`;
}

export type PayrollAdjustmentCategory = z.infer<
	typeof payrollAdjustmentCategorySchema
>;
export type PayrollAdjustmentStatus = z.infer<
	typeof payrollAdjustmentStatusSchema
>;
export type PayrollEffect = z.infer<typeof payrollEffectSchema>;
export type PayrollAdjustmentEffect = z.infer<
	typeof payrollAdjustmentEffectSchema
>;
