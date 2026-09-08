import { payrollSpec, resolvePath, withQuery } from "@elineas/contracts";
import type {
	CreatePayrollAdjustmentInput,
	ListPayrollAdjustmentsQuery,
	PayrollAdjustment,
	PayrollSalary,
	PayrollSummary,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiFetch, apiJson } from "#/lib/api-client.ts";
import { notificationsQueryKey } from "#/modules/notifications/api.ts";

/**
 * Acceso a nómina (spec 17 §5 y §6).
 *
 * **Estas consultas sólo se lanzan desde `/payroll`**, que es una ruta de
 * `global_manager` (RN-17.1): a nadie más se le pide este dato al navegador. Es
 * el mismo criterio con el que el sueldo de la spec 02 vive en su propia
 * consulta y sólo se pide al abrir su diálogo — un importe que no se necesita no
 * debe viajar.
 */

export const payrollQueryKey = ["payroll"] as const;

/** Los filtros que comparten el listado, el resumen y la exportación. */
export type AdjustmentFilters = {
	period?: string;
	departmentId?: string;
	userId?: string;
	status?: ListPayrollAdjustmentsQuery["status"];
	category?: ListPayrollAdjustmentsQuery["category"];
};

const asQuery = (filters: AdjustmentFilters) => ({
	period: filters.period || undefined,
	departmentId: filters.departmentId || undefined,
	userId: filters.userId || undefined,
	status: filters.status || undefined,
	category: filters.category || undefined,
});

export const adjustmentsQueryOptions = (filters: AdjustmentFilters) =>
	queryOptions({
		queryKey: [...payrollQueryKey, "adjustments", filters] as const,
		queryFn: (): Promise<PayrollAdjustment[]> =>
			apiJson(
				withQuery(payrollSpec.adjustments.path, asQuery(filters)),
				payrollSpec.adjustments.response,
			),
	});

export const payrollSummaryQueryOptions = (filters: {
	period?: string;
	departmentId?: string;
}) =>
	queryOptions({
		queryKey: [...payrollQueryKey, "summary", filters] as const,
		queryFn: (): Promise<PayrollSummary> =>
			apiJson(
				withQuery(payrollSpec.summary.path, {
					period: filters.period || undefined,
					departmentId: filters.departmentId || undefined,
				}),
				payrollSpec.summary.response,
			),
	});

export const salariesQueryOptions = (filters: {
	departmentId?: string;
	search?: string;
	includeInactive?: boolean;
}) =>
	queryOptions({
		queryKey: [...payrollQueryKey, "salaries", filters] as const,
		queryFn: (): Promise<PayrollSalary[]> =>
			apiJson(
				withQuery(payrollSpec.salaries.path, {
					departmentId: filters.departmentId || undefined,
					search: filters.search || undefined,
					includeInactive: filters.includeInactive,
				}),
				payrollSpec.salaries.response,
			),
	});

/**
 * Cualquier escritura invalida nómina entera **y las notificaciones**: un ajuste
 * genera un aviso a quien lo sufre, y si quien lo registra es esa misma persona
 * —un gestor ajustándose algo a sí mismo— su campana quedaría desfasada.
 */
function usePayrollMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: payrollQueryKey });
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}

export function useCreateAdjustment() {
	return usePayrollMutation(
		(input: CreatePayrollAdjustmentInput): Promise<PayrollAdjustment> =>
			apiJson(
				payrollSpec.createAdjustment.path,
				payrollSpec.createAdjustment.response,
				{
					method: payrollSpec.createAdjustment.method,
					body: JSON.stringify(payrollSpec.createAdjustment.body.parse(input)),
				},
			),
	);
}

export function useRevertAdjustment() {
	return usePayrollMutation(
		({
			id,
			reason,
		}: {
			id: string;
			reason: string;
		}): Promise<PayrollAdjustment> =>
			apiJson(
				resolvePath(payrollSpec.revertAdjustment.path, { id }),
				payrollSpec.revertAdjustment.response,
				{
					method: payrollSpec.revertAdjustment.method,
					body: JSON.stringify(
						payrollSpec.revertAdjustment.body.parse({ reason }),
					),
				},
			),
	);
}

/**
 * RN-17.11 — Descarga el periodo como XLSX.
 *
 * El archivo se trae con `apiFetch` y no navegando a la URL porque el backend
 * vive en otro origen: un `<a href>` no llevaría la sesión, y aquí no hay
 * enlace firmado que lo supla — a diferencia del reporte mensual (RN-16.5),
 * esto no es un artefacto guardado sino la respuesta a una consulta.
 */
export function useExportAdjustments() {
	return useMutation({
		mutationFn: async (filters: AdjustmentFilters): Promise<void> => {
			const response = await apiFetch(
				withQuery(payrollSpec.exportAdjustments.path, asQuery(filters)),
			);
			if (!response.ok) throw new Error("La descarga falló.");

			const url = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `ajustes-nomina-${filters.period ?? "periodo"}.xlsx`;
			anchor.click();
			URL.revokeObjectURL(url);
		},
	});
}
