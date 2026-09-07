import { reportsSpec, resolvePath, withQuery } from "@elineas/contracts";
import type {
	MonthlyReport,
	ReportDownload,
	ReportKpis,
	ReportRun,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiFetch, apiJson } from "#/lib/api-client.ts";
import { notificationsQueryKey } from "#/modules/notifications/api.ts";

/**
 * Acceso a la reportería mensual (spec 16).
 *
 * **RN-16.6 — el sondeo se apaga solo.** `reportRunsQueryOptions` refresca cada
 * 15 s **sólo mientras haya corridas activas**, mirando los datos que ya tiene:
 * en cuanto ninguna está `queued` ni `running`, el intervalo pasa a `false` y la
 * pantalla deja de preguntar. Un sondeo que no sabe parar es una pestaña abierta
 * toda la tarde pegándole al servidor.
 */

export const reportsQueryKey = ["reports"] as const;

const POLL_MS = 15_000;

export const monthlyReportQueryOptions = (query: {
	period: string;
	departmentId?: string;
}) =>
	queryOptions({
		queryKey: [...reportsQueryKey, "monthly", query] as const,
		queryFn: (): Promise<MonthlyReport> =>
			apiJson(
				withQuery(reportsSpec.monthly.path, query),
				reportsSpec.monthly.response,
			),
	});

export const reportRunsQueryOptions = () =>
	queryOptions({
		queryKey: [...reportsQueryKey, "runs"] as const,
		queryFn: (): Promise<ReportRun[]> =>
			apiJson(reportsSpec.runs.path, reportsSpec.runs.response),
		refetchInterval: (query) => {
			const runs = query.state.data;
			if (!runs) return false;
			const active = runs.some(
				(run) => run.status === "queued" || run.status === "running",
			);
			return active ? POLL_MS : false;
		},
	});

export const reportKpisQueryOptions = (windowDays = 30) =>
	queryOptions({
		queryKey: [...reportsQueryKey, "kpis", windowDays] as const,
		queryFn: (): Promise<ReportKpis> =>
			apiJson(
				withQuery(reportsSpec.kpis.path, { windowDays }),
				reportsSpec.kpis.response,
			),
	});

function useRunsMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: reportsQueryKey });
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}

export function useEnqueueReportRun() {
	return useRunsMutation(
		(input: { period: string; departmentId?: string }): Promise<ReportRun> =>
			apiJson(reportsSpec.enqueue.path, reportsSpec.enqueue.response, {
				method: reportsSpec.enqueue.method,
				body: JSON.stringify(reportsSpec.enqueue.body.parse(input)),
			}),
	);
}

export function useRetryReportRun() {
	return useRunsMutation(
		({ id }: { id: string }): Promise<ReportRun> =>
			apiJson(
				resolvePath(reportsSpec.retry.path, { id }),
				reportsSpec.retry.response,
				{ method: reportsSpec.retry.method },
			),
	);
}

/**
 * Pide el enlace firmado y dispara la descarga.
 *
 * El enlace se pide **al pulsar**, no al pintar la lista: caduca en minutos
 * (RN-16.5), así que uno emitido al cargar la pantalla estaría muerto para
 * cuando alguien lo usara. Y el archivo se trae con `apiFetch` en vez de
 * navegar a la URL porque el backend vive en otro origen: un `<a href>` no
 * llevaría nada de la sesión y, sobre todo, la respuesta es un adjunto que el
 * navegador tiene que guardar, no una página a la que ir.
 */
export function useDownloadReport() {
	return useMutation({
		mutationFn: async ({ id }: { id: string }): Promise<ReportDownload> => {
			const link = await apiJson(
				resolvePath(reportsSpec.download.path, { id }),
				reportsSpec.download.response,
			);

			const response = await apiFetch(link.url);
			if (!response.ok) throw new Error("La descarga falló.");

			const url = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = link.filename;
			anchor.click();
			URL.revokeObjectURL(url);

			return link;
		},
	});
}
