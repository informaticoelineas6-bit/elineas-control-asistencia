import { payrollSpec } from "@elineas/contracts";
import {
	buildPayrollGrid,
	createPayrollAdjustmentInputSchema,
	listPayrollAdjustmentsQuerySchema,
	listPayrollSalariesQuerySchema,
	payrollSummaryQuerySchema,
	revertPayrollAdjustmentInputSchema,
} from "@elineas/validations";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { clientIp } from "#/lib/request.ts";
import { validate } from "#/lib/validate.ts";
import { getAuth, requireAuth, requireRole } from "#/middleware/auth";
import {
	createManualAdjustment,
	getPayrollSummary,
	listAdjustments,
	listSalaries,
	revertAdjustment,
} from "#/services/payroll.ts";
import { gridToXlsx } from "#/services/xlsx.ts";

/**
 * Nómina (spec 17 §6). Montado en `/api/payroll`.
 *
 * **Un solo `requireRole` para todo el router, y es `global_manager`**
 * (RN-17.1). No hay un endpoint más permisivo que otro ni un ámbito
 * departamental que acotar: el `department_head` no accede a nómina aunque sus
 * decisiones la muevan, y el empleado tampoco (decisión 3 de la §9, abierta).
 *
 * Ponerlo en el router y no endpoint por endpoint es deliberado: la barrera de
 * privilegios de RN-13.5 no puede depender de que alguien se acuerde de repetir
 * la línea al añadir la séptima ruta. Es el mismo criterio con el que
 * `hasScope` vive en una sola función tipada (hallazgo H-1 de la spec 16).
 */
export const payroll = new Hono();

payroll.use("*", requireAuth);
payroll.use("*", requireRole("global_manager"));

const idParam = z.object({
	id: z.uuid("El identificador del ajuste no es válido."),
});

const actorOf = (c: Context) => ({
	profileId: getAuth(c).profile.id,
	sourceIp: clientIp(c),
});

payroll.get(
	"/adjustments",
	validate("query", listPayrollAdjustmentsQuerySchema),
	async (c) => {
		const rows = await listAdjustments(c.req.valid("query"));
		return c.json(payrollSpec.adjustments.response.parse(rows));
	},
);

/**
 * `GET /payroll/adjustments/export` (RN-17.11) — el periodo en una hoja.
 *
 * **Va antes que `/adjustments/:id/...` no por precedencia** —Hono casa por
 * método y forma— sino porque se lee junto al listado que exporta: es la misma
 * consulta con los mismos filtros, servida en otro formato.
 *
 * Devuelve el archivo y **no lo guarda en ningún sitio**, al revés que el
 * reporte mensual de RN-16.5. Aquel es un artefacto de cola con enlace firmado;
 * éste son decenas de filas que caben en la respuesta, y no dejarlo escrito en
 * un volumen evita que exista una copia de los importes de la plantilla fuera de
 * la base.
 */
payroll.get(
	"/adjustments/export",
	validate("query", listPayrollAdjustmentsQuerySchema),
	async (c) => {
		const query = c.req.valid("query");
		const rows = await listAdjustments(query);
		const period = rows[0]?.effectivePeriod.slice(0, 7) ?? query.period ?? "";
		const bytes = await gridToXlsx(buildPayrollGrid(period, rows), {
			rows: 1,
			columns: 3,
		});

		return c.body(bytes as unknown as ArrayBuffer, 200, {
			"Content-Type":
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"Content-Disposition": `attachment; filename="ajustes-nomina-${period}.xlsx"`,
		});
	},
);

payroll.post(
	"/adjustments",
	validate("json", createPayrollAdjustmentInputSchema),
	async (c) => {
		const adjustment = await createManualAdjustment(
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(payrollSpec.createAdjustment.response.parse(adjustment), 201);
	},
);

payroll.post(
	"/adjustments/:id/revert",
	validate("param", idParam),
	validate("json", revertPayrollAdjustmentInputSchema),
	async (c) => {
		const adjustment = await revertAdjustment(
			c.req.valid("param").id,
			c.req.valid("json"),
			actorOf(c),
		);
		return c.json(payrollSpec.revertAdjustment.response.parse(adjustment));
	},
);

payroll.get(
	"/summary",
	validate("query", payrollSummaryQuerySchema),
	async (c) => {
		const summary = await getPayrollSummary(c.req.valid("query"));
		return c.json(payrollSpec.summary.response.parse(summary));
	},
);

payroll.get(
	"/salaries",
	validate("query", listPayrollSalariesQuerySchema),
	async (c) => {
		const salaries = await listSalaries(c.req.valid("query"));
		return c.json(payrollSpec.salaries.response.parse(salaries));
	},
);
