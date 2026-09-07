import { absencesSpec, resolvePath, withQuery } from "@elineas/contracts";
import type {
	AbsenceReview,
	AbsenceReviewResult,
	PendingAbsence,
	PendingAbsencesCount,
	ReviewAbsenceInput,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";
import { attendanceQueryKey } from "#/modules/attendance/api.ts";
import { notificationsQueryKey } from "#/modules/notifications/api.ts";

/**
 * Acceso a la justificación de ausencias (spec 13). Las rutas salen del
 * contrato; aquí no hay ninguna URL escrita a mano (api-conventions.md).
 *
 * **Sí invalida la asistencia**, al contrario que las incidencias: clasificar un
 * día cambia su código `AJ`/`ANJ` en el historial, que es la vía por la que el
 * empleado ve la decisión (spec 13 §6). Es exactamente la línea que el módulo de
 * incidencias documenta que **no** hace falta allí, porque aprobar una
 * incidencia no cambia ningún día (RN-12.9) — salvo cuando se pide justificar a
 * la vez, y entonces la mutación es de este módulo.
 */

export const absencesQueryKey = ["absences"] as const;

export const pendingAbsencesQueryOptions = (
	range: { from?: string; to?: string } = {},
) =>
	queryOptions({
		queryKey: [...absencesQueryKey, "pending", range] as const,
		queryFn: (): Promise<PendingAbsence[]> =>
			apiJson(
				withQuery(absencesSpec.pending.path, range),
				absencesSpec.pending.response,
			),
	});

export const pendingAbsencesCountQueryOptions = () =>
	queryOptions({
		queryKey: [...absencesQueryKey, "pending-count"] as const,
		queryFn: (): Promise<PendingAbsencesCount> =>
			apiJson(
				absencesSpec.pendingCount.path,
				absencesSpec.pendingCount.response,
			),
	});

export const absenceReviewsQueryOptions = (query: {
	from: string;
	to: string;
	userId?: string;
}) =>
	queryOptions({
		queryKey: [...absencesQueryKey, "reviews", query] as const,
		queryFn: (): Promise<AbsenceReview[]> =>
			apiJson(
				withQuery(absencesSpec.list.path, query),
				absencesSpec.list.response,
			),
	});

export function useReviewAbsence() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			userId,
			date,
			...input
		}: ReviewAbsenceInput & {
			userId: string;
			date: string;
		}): Promise<AbsenceReviewResult> =>
			apiJson(
				resolvePath(absencesSpec.review.path, { userId, date }),
				absencesSpec.review.response,
				{
					method: absencesSpec.review.method,
					body: JSON.stringify(absencesSpec.review.body.parse(input)),
				},
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: absencesQueryKey });
			void queryClient.invalidateQueries({ queryKey: attendanceQueryKey });
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}
