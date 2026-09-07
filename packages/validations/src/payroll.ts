import { z } from "zod";
import { currencySchema } from "./currency.ts";
import {
	type ReportCell,
	type ReportGrid,
	reportPeriodSchema,
} from "./reports.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Vocabulario de nómina (spec 17).
 *
 * Nació a medias —sólo lo que el descuento automático de RN-13.4 produce— y se
 * completó con la superficie de administración de la §5 y la §6: los ajustes
 * manuales (RN-17.8), su reversión con motivo, los totales por periodo y el
 * listado de sueldos. El criterio de entonces sigue siendo el mismo: aquí sólo
 * se enumera lo que alguna línea de código puede devolver de verdad.
 *
 * Lo que quedó cerrado con el descuento, porque no se podía escribir sin
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

/**
 * Spec 17 §2. `unjustified_absence` la produce **sólo** la revisión de una
 * ausencia (RN-17.2); las otras dos son para ajustes manuales. El vocabulario
 * no lo impide —un manual puede llevar cualquiera de las tres— porque lo que
 * distingue a uno automático de uno a mano no es su categoría sino su origen:
 * `sourceType`/`sourceId`, que un ajuste manual no tiene.
 */
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

// ── §5 y §6 · La superficie de administración ────────────────────────────────

/**
 * El periodo de nómina es **el mes natural**, y es literalmente el mismo de la
 * spec 16: se reutiliza su esquema en vez de escribir otro `yyyy-MM` con otro
 * mensaje de error. Un ajuste vive en el día 1 de su mes (`effectivePeriodOf`),
 * así que filtrar por periodo es una igualdad de fecha, no un rango.
 *
 * ⚠️ Esto dice **a qué mes pertenece** un ajuste, no si ese mes sigue admitiendo
 * cambios: el cierre de periodo es la decisión 2 de la §9, todavía abierta.
 */
export const payrollPeriodSchema = reportPeriodSchema;

/**
 * Un importe con signo, tal como se guarda: **cadena, nunca número**. Es
 * `numeric(12,2)` en la base y pasarlo por un `double` de JavaScript le quita
 * exactitud a un dato de dinero — el mismo criterio que la compensación de la
 * spec 02 y que el cálculo en PostgreSQL de RN-17.12.
 */
export const signedAmountSchema = z
	.string()
	.trim()
	.regex(
		/^-?\d{1,10}(\.\d{1,2})?$/,
		"Importe no válido (por ejemplo: -350.00 o 1200)",
	)
	// Un cero no ajusta nada y sí ensucia el historial y los totales.
	.refine((value) => Number.parseFloat(value) !== 0, {
		message: "El importe no puede ser cero.",
	});

/** Un ajuste tal como se lee (§5): con la persona y el departamento resueltos. */
export const payrollAdjustmentSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	userFullName: z.string(),
	userEmail: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	/** Con signo: negativo es descuento, positivo bonificación. */
	amount: z.string(),
	currency: currencySchema,
	category: payrollAdjustmentCategorySchema,
	description: z.string().nullable(),
	status: payrollAdjustmentStatusSchema,
	/**
	 * Qué lo originó. Nulo en los manuales, y esa es la única forma fiable de
	 * distinguirlos: la §5 pide que al revertir se vea de dónde vino el ajuste.
	 */
	sourceType: z.string().nullable(),
	sourceId: z.uuid().nullable(),
	effectivePeriod: isoDateSchema,
	createdBy: z.uuid().nullable(),
	createdByName: z.string().nullable(),
	revertedBy: z.uuid().nullable(),
	revertedByName: z.string().nullable(),
	revertedAt: z.iso.datetime().nullable(),
	/** RN-17.4 — Por qué se revirtió. Nulo mientras el ajuste siga activo. */
	revertReason: z.string().nullable(),
	createdAt: z.iso.datetime(),
});

export const listPayrollAdjustmentsQuerySchema = z.object({
	/** Sin periodo se devuelve el mes en curso, no la historia entera. */
	period: payrollPeriodSchema.optional(),
	departmentId: z.uuid().optional(),
	userId: z.uuid().optional(),
	status: payrollAdjustmentStatusSchema.optional(),
	category: payrollAdjustmentCategorySchema.optional(),
});

/**
 * RN-17.8 — Un ajuste manual, **de cualquier signo y con motivo obligatorio**.
 *
 * La asimetría con el descuento automático es deliberada y va en el mismo
 * sentido que la de las specs 11, 12 y 13: se exige la razón de la decisión
 * **discrecional**. El automático no la lleva porque su motivo es un hecho —la
 * ausencia del día tal—; éste lo pone alguien a mano y dentro de un año nadie
 * recordará por qué.
 *
 * `currency` es opcional: sin ella se copia la del sueldo de esa persona, que
 * es lo que hace el automático. Sólo hay que indicarla para ajustar en una
 * moneda distinta de aquella en la que cobra.
 */
export const createPayrollAdjustmentInputSchema = z.object({
	userId: z.uuid("Elige a quién afecta el ajuste."),
	amount: signedAmountSchema,
	currency: currencySchema.optional(),
	category: payrollAdjustmentCategorySchema,
	description: z
		.string()
		.trim()
		.min(3, "Explica el motivo del ajuste.")
		.max(500, "El motivo no puede pasar de 500 caracteres."),
	/** A qué mes se imputa. Por defecto, el mes en curso. */
	period: payrollPeriodSchema.optional(),
});

/** RN-17.4 — Revertir **no borra**, y también pide su motivo. */
export const revertPayrollAdjustmentInputSchema = z.object({
	reason: z
		.string()
		.trim()
		.min(3, "Explica por qué se revierte el ajuste.")
		.max(500, "El motivo no puede pasar de 500 caracteres."),
});

/**
 * Un total, **siempre con su moneda**.
 *
 * No hay un único número por departamento y no puede haberlo: en la misma
 * plantilla se cobra en monedas distintas (spec 02 §6a) y sumar CUP con USD da
 * una cifra que no significa nada. Por eso el criterio de aceptación —"los
 * totales por departamento cuadran con la suma de ajustes activos"— se
 * comprueba moneda a moneda.
 */
export const payrollTotalSchema = z.object({
	currency: currencySchema,
	/** Suma con signo, como cadena: la hace PostgreSQL sobre `numeric`. */
	total: z.string(),
	count: z.number().int().nonnegative(),
});

export const payrollDepartmentTotalSchema = payrollTotalSchema.extend({
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
});

export const payrollEmployeeTotalSchema = payrollTotalSchema.extend({
	userId: z.uuid(),
	userFullName: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
});

/**
 * `GET /payroll/summary` (§6): los totales del periodo, sólo de los ajustes
 * **activos** — un revertido no se cobra, y contarlo dejaría el total sin
 * cuadrar con lo que se paga.
 */
export const payrollSummarySchema = z.object({
	period: payrollPeriodSchema,
	totals: z.array(payrollTotalSchema),
	byDepartment: z.array(payrollDepartmentTotalSchema),
	byEmployee: z.array(payrollEmployeeTotalSchema),
});

export const payrollSummaryQuerySchema = z.object({
	period: payrollPeriodSchema.optional(),
	departmentId: z.uuid().optional(),
});

/**
 * Un sueldo en el listado de la §5.
 *
 * **La edición no está aquí**: vive en `PUT /users/:id/compensation` desde la
 * spec 02, con el mismo rol y la misma entrada de bitácora
 * (`compensation.updated`). Lo que faltaba era poder **verlos todos a la vez**
 * con su filtro por departamento, que es lo que la §5 pide y lo que un diálogo
 * por persona no da.
 */
export const payrollSalarySchema = z.object({
	profileId: z.uuid(),
	fullName: z.string(),
	email: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	/** Nulo = sin sueldo registrado, que es el caso de RN-17.7. */
	monthlySalary: z.string().nullable(),
	currency: currencySchema,
	updatedAt: z.iso.datetime().nullable(),
});

export const listPayrollSalariesQuerySchema = z.object({
	departmentId: z.uuid().optional(),
	search: z.string().trim().max(120).optional(),
	/** Un perfil desactivado sigue teniendo sueldo; no siempre interesa verlo. */
	includeInactive: z.stringbool().default(false),
});

// ── Etiquetas de interfaz ────────────────────────────────────────────────────

export const PAYROLL_CATEGORY_LABELS: Record<
	PayrollAdjustmentCategory,
	string
> = {
	unjustified_absence: "Ausencia injustificada",
	vacation: "Vacaciones",
	other: "Otro",
};

export const PAYROLL_STATUS_LABELS: Record<PayrollAdjustmentStatus, string> = {
	active: "Activo",
	reverted: "Revertido",
};

// ── RN-17.11 · Los ajustes del periodo, en una cuadrícula ────────────────────

/**
 * **RN-17.11, con un desvío que la regla no anticipaba.**
 *
 * La regla pide que los ajustes del periodo aparezcan en el reporte mensual de
 * la spec 16, y **ahí no pueden ir**: ese XLSX es un artefacto guardado que
 * descarga *cualquiera con ámbito sobre él* (decisión 3 de la spec 16), o sea
 * también un `department_head`. Un importe de ausencia injustificada es el
 * sueldo dividido por el divisor: enseñárselo le enseña el sueldo, que es
 * exactamente lo que RN-17.1 y el hallazgo H-3 prohíben. Meterlo en una hoja
 * del mismo libro tiraría la barrera de privilegios por la puerta de atrás.
 *
 * Así que los ajustes se exportan **desde la pantalla de nómina**, en su propio
 * archivo y detrás de `requireRole("global_manager")`. Se cumple lo que la
 * regla persigue —tener el periodo en una hoja de cálculo— sin romper la regla
 * que la precede.
 *
 * La forma es la misma que la del reporte y por la misma razón (§7 de la spec
 * 16): la cuadrícula se construye **una vez**, aquí, y el serializador sólo la
 * envuelve. Dos implementaciones de la misma tabla es la deuda crítica que esa
 * spec vino a saldar.
 */
export function buildPayrollGrid(
	period: string,
	adjustments: readonly PayrollAdjustment[],
): ReportGrid {
	const header: ReportCell[] = [
		{ value: "Empleado", header: true },
		{ value: "Correo", header: true },
		{ value: "Departamento", header: true },
		{ value: "Categoría", header: true },
		{ value: "Importe", header: true },
		{ value: "Moneda", header: true },
		{ value: "Estado", header: true },
		{ value: "Motivo", header: true },
		{ value: "Origen", header: true },
		{ value: "Registrado", header: true },
		{ value: "Revertido", header: true },
	];

	const rows = adjustments.map((row): ReportCell[] => [
		{ value: row.userFullName },
		{ value: row.userEmail },
		{ value: row.departmentName ?? "" },
		{ value: PAYROLL_CATEGORY_LABELS[row.category] },
		// El importe va como **cadena**: convertirlo a número aquí para que la
		// hoja lo trate como tal es volver a pasar dinero por un `double`.
		{ value: row.amount },
		{ value: row.currency },
		{ value: PAYROLL_STATUS_LABELS[row.status] },
		{ value: row.description ?? "" },
		{ value: row.sourceType ?? "Manual" },
		{ value: row.createdAt.slice(0, 10) },
		{ value: row.revertedAt?.slice(0, 10) ?? "" },
	]);

	return { sheetName: `Ajustes ${period}`, rows: [header, ...rows] };
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
export type PayrollAdjustment = z.infer<typeof payrollAdjustmentSchema>;
export type ListPayrollAdjustmentsQuery = z.infer<
	typeof listPayrollAdjustmentsQuerySchema
>;
export type CreatePayrollAdjustmentInput = z.infer<
	typeof createPayrollAdjustmentInputSchema
>;
export type RevertPayrollAdjustmentInput = z.infer<
	typeof revertPayrollAdjustmentInputSchema
>;
export type PayrollTotal = z.infer<typeof payrollTotalSchema>;
export type PayrollDepartmentTotal = z.infer<
	typeof payrollDepartmentTotalSchema
>;
export type PayrollEmployeeTotal = z.infer<typeof payrollEmployeeTotalSchema>;
export type PayrollSummary = z.infer<typeof payrollSummarySchema>;
export type PayrollSummaryQuery = z.infer<typeof payrollSummaryQuerySchema>;
export type PayrollSalary = z.infer<typeof payrollSalarySchema>;
export type ListPayrollSalariesQuery = z.infer<
	typeof listPayrollSalariesQuerySchema
>;
