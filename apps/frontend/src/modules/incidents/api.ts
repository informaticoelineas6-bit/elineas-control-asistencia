import { incidentsSpec, resolvePath, withQuery } from "@elineas/contracts";
import type {
	AttendanceIncident,
	AttendanceMark,
	CreateIncidentInput,
	IncidentContext,
	ListIncidentsQuery,
	PendingIncidentsCount,
	ReviewIncidentInput,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";
import { notificationsQueryKey } from "#/modules/notifications/api.ts";

/**
 * Acceso a incidencias (spec 12). Las rutas salen del contrato; aquí no hay
 * ninguna URL escrita a mano (api-conventions.md).
 *
 * Al contrario que en vacaciones, **ninguna mutación invalida la asistencia**:
 * aprobar una incidencia no cambia ni un marcaje ni el estado de un día
 * (RN-12.9), así que refrescar el historial sería pedir de nuevo unos datos que
 * no pueden haber cambiado. Si la decisión 1 de la §9 se cierra alguna vez a
 * favor de justificar la ausencia, esta es la línea que hay que añadir — y el
 * comentario que hay que borrar.
 */

export const incidentsQueryKey = ["incidents"] as const;

export const incidentsQueryOptions = (
	query: Partial<ListIncidentsQuery> = {},
) =>
	queryOptions({
		queryKey: [...incidentsQueryKey, "list", query] as const,
		queryFn: (): Promise<AttendanceIncident[]> =>
			apiJson(
				withQuery(incidentsSpec.list.path, query),
				incidentsSpec.list.response,
			),
	});

export const pendingIncidentsCountQueryOptions = (
	scope: "own" | "managed" = "own",
) =>
	queryOptions({
		queryKey: [...incidentsQueryKey, "pending-count", scope] as const,
		queryFn: (): Promise<PendingIncidentsCount> =>
			apiJson(
				withQuery(incidentsSpec.pendingCount.path, { scope }),
				incidentsSpec.pendingCount.response,
			),
	});

/**
 * Los intentos rechazados propios de un día (RN-12.2). Se pide sólo cuando hay
 * una fecha elegida en el formulario: sin ella no hay nada que enseñar.
 */
export const ownBlockedMarksQueryOptions = (date: string | null) =>
	queryOptions({
		queryKey: [...incidentsQueryKey, "blocked-marks", date] as const,
		enabled: !!date,
		queryFn: (): Promise<AttendanceMark[]> =>
			apiJson(
				withQuery(incidentsSpec.blockedMarks.path, { date: date ?? "" }),
				incidentsSpec.blockedMarks.response,
			),
	});

export const incidentContextQueryOptions = (id: string) =>
	queryOptions({
		queryKey: [...incidentsQueryKey, "context", id] as const,
		queryFn: (): Promise<IncidentContext> =>
			apiJson(
				resolvePath(incidentsSpec.context.path, { id }),
				incidentsSpec.context.response,
			),
	});

function useIncidentsMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: incidentsQueryKey });
			// Reportar y revisar generan notificaciones (RN-12.10): la campana y los
			// badges tienen que reflejarlo sin recargar (RN-05.5).
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}

export function useReportIncident() {
	return useIncidentsMutation(
		(input: CreateIncidentInput): Promise<AttendanceIncident> =>
			apiJson(incidentsSpec.report.path, incidentsSpec.report.response, {
				method: incidentsSpec.report.method,
				body: JSON.stringify(incidentsSpec.report.body.parse(input)),
			}),
	);
}

export function useReviewIncident() {
	return useIncidentsMutation(
		({
			id,
			...input
		}: ReviewIncidentInput & { id: string }): Promise<AttendanceIncident> =>
			apiJson(
				resolvePath(incidentsSpec.review.path, { id }),
				incidentsSpec.review.response,
				{
					method: incidentsSpec.review.method,
					body: JSON.stringify(incidentsSpec.review.body.parse(input)),
				},
			),
	);
}
