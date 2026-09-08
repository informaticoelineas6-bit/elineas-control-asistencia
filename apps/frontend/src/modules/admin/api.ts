import { adminSpec } from "@elineas/contracts";
import type {
	AdminStats,
	AttendanceImportReport,
	AttendanceImportResult,
	MaintenanceState,
	SetMaintenanceInput,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiError, apiFetch, apiJson } from "#/lib/api-client.ts";
import { configQueryKey } from "#/modules/config/api.ts";

/**
 * Acceso al panel de superadmin (spec 19).
 *
 * ⚠️ **No hay ninguna función que mande SQL**, y no es que falte: la consola no
 * se reimplementa (decisión 1 de la §6). El razonamiento está en
 * `packages/contracts/src/admin.ts`.
 */

export const adminQueryKey = ["admin"] as const;

export const adminStatsQueryOptions = () =>
	queryOptions({
		queryKey: [...adminQueryKey, "stats"] as const,
		queryFn: (): Promise<AdminStats> =>
			apiJson(adminSpec.stats.path, adminSpec.stats.response),
	});

export const maintenanceQueryOptions = () =>
	queryOptions({
		queryKey: [...adminQueryKey, "maintenance"] as const,
		queryFn: (): Promise<MaintenanceState> =>
			apiJson(adminSpec.maintenance.path, adminSpec.maintenance.response),
	});

export function useSetMaintenance() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (input: SetMaintenanceInput): Promise<MaintenanceState> =>
			apiJson(
				adminSpec.setMaintenance.path,
				adminSpec.setMaintenance.response,
				{
					method: adminSpec.setMaintenance.method,
					body: JSON.stringify(adminSpec.setMaintenance.body.parse(input)),
				},
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: adminQueryKey });
			// El aviso lo reparte la configuración pública: sin esto, quien lo acaba
			// de activar es el único que no ve la banda.
			void queryClient.invalidateQueries({ queryKey: configQueryKey });
		},
	});
}

/**
 * Sube el archivo del histórico.
 *
 * Va con `FormData` y **sin `Content-Type` a mano**: el navegador tiene que poner
 * el suyo con el `boundary` dentro, y escribirlo rompe el `multipart` de una
 * forma que se diagnostica fatal — el servidor ve un cuerpo vacío.
 */
async function uploadImport<T>(
	path: string,
	schema: { parse: (value: unknown) => T },
	file: File,
): Promise<T> {
	const form = new FormData();
	form.append("file", file);

	const response = await apiFetch(path, { method: "POST", body: form });
	if (!response.ok) throw await apiError(response);
	return schema.parse(await response.json());
}

/** RN-19.2 — El informe previo. No escribe nada. */
export function useValidateImport() {
	return useMutation({
		mutationFn: (file: File): Promise<AttendanceImportReport> =>
			uploadImport(
				adminSpec.validateImport.path,
				adminSpec.validateImport.response,
				file,
			),
	});
}

export function useCommitImport() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (file: File): Promise<AttendanceImportResult> =>
			uploadImport(
				adminSpec.commitImport.path,
				adminSpec.commitImport.response,
				file,
			),
		// Las estadísticas cuentan marcajes importados, y la asistencia de medio
		// sistema acaba de cambiar.
		onSuccess: () => queryClient.invalidateQueries(),
	});
}
