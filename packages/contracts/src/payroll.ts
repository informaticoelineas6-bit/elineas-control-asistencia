import {
	createPayrollAdjustmentInputSchema,
	listPayrollAdjustmentsQuerySchema,
	listPayrollSalariesQuerySchema,
	payrollAdjustmentSchema,
	payrollSalarySchema,
	payrollSummaryQuerySchema,
	payrollSummarySchema,
	revertPayrollAdjustmentInputSchema,
} from "@elineas/validations";
import { z } from "zod";

/**
 * Contrato de nómina (spec 17 §6).
 *
 * **Todo exige `global_manager`, sin una sola excepción** (RN-17.1). El
 * `department_head` no accede aunque sus decisiones generen ajustes: justifica
 * una ausencia llamando a `/absences` y es el servidor —dentro de esa misma
 * transacción y con `services/payroll.ts`, que ninguna ruta expone— quien
 * escribe en nómina por él. Eso es RN-13.5, y ahora que estos endpoints existen
 * la barrera se comprueba de verdad: un jefe recibe **403**, no el 404 de
 * "aquí no hay nada" que devolvía antes.
 *
 * Dos ausencias deliberadas respecto de la tabla de la §6:
 *
 * - **No hay `PUT /payroll/salaries/:userId`.** Editar un sueldo ya existe
 *   desde la spec 02 —`PUT /users/:id/compensation`—, con el mismo rol mínimo y
 *   la misma entrada de bitácora (`compensation.updated`). Un segundo endpoint
 *   para lo mismo son dos sitios donde arreglar el día que cambie la regla. Lo
 *   que sí faltaba es **verlos todos**, y eso es `salaries`.
 * - **No hay endpoint para el empleado.** La decisión 3 de la §9 sigue abierta:
 *   ve el importe de su descuento en la notificación de RN-17.10, no una
 *   pantalla con su historial.
 */
export const payrollSpec = {
	adjustments: {
		method: "GET",
		path: "/api/payroll/adjustments",
		query: listPayrollAdjustmentsQuerySchema,
		response: z.array(payrollAdjustmentSchema),
	},
	/** RN-17.8 — Ajuste manual, de cualquier signo y con motivo obligatorio. */
	createAdjustment: {
		method: "POST",
		path: "/api/payroll/adjustments",
		body: createPayrollAdjustmentInputSchema,
		response: payrollAdjustmentSchema,
	},
	/** RN-17.4 — Revierte; **nunca borra**. El historial económico es inmutable. */
	revertAdjustment: {
		method: "POST",
		path: "/api/payroll/adjustments/:id/revert",
		body: revertPayrollAdjustmentInputSchema,
		response: payrollAdjustmentSchema,
	},
	/**
	 * RN-17.11 — Los ajustes del periodo en una hoja de cálculo.
	 *
	 * **Devuelve el archivo, no un enlace**, al revés que el reporte mensual
	 * (RN-16.5): aquel es un artefacto que se genera en cola y se guarda, y por
	 * eso necesita un enlace firmado; esto es una consulta de unas decenas de
	 * filas que cabe en la respuesta. Y es lo que permite que el archivo **no**
	 * se guarde en ningún sitio: un XLSX con importes en un volumen es una copia
	 * del sueldo de la plantilla esperando a que alguien la encuentre.
	 */
	exportAdjustments: {
		method: "GET",
		path: "/api/payroll/adjustments/export",
		query: listPayrollAdjustmentsQuerySchema,
	},
	/** §6 — Totales por empleado y por departamento, **moneda a moneda**. */
	summary: {
		method: "GET",
		path: "/api/payroll/summary",
		query: payrollSummaryQuerySchema,
		response: payrollSummarySchema,
	},
	salaries: {
		method: "GET",
		path: "/api/payroll/salaries",
		query: listPayrollSalariesQuerySchema,
		response: z.array(payrollSalarySchema),
	},
} as const;
