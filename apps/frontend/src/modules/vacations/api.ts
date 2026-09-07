import { resolvePath, vacationsSpec, withQuery } from "@elineas/contracts";
import type {
	CreateVacationRequestInput,
	ListVacationRequestsQuery,
	ReviewVacationRequestInput,
	VacationBalance,
	VacationRequest,
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
 * Acceso a vacaciones (spec 11). Las rutas salen del contrato; aquí no hay
 * ninguna URL escrita a mano (api-conventions.md).
 *
 * Toda mutación invalida además **la asistencia y las notificaciones**, igual
 * que en `modules/rest/api.ts` y por el mismo motivo: aprobar unas vacaciones
 * cambia si se puede marcar ese rango (RN-11.9) y una solicitud nueva o
 * revisada genera notificaciones que la campana tiene que refrescar.
 */

export const vacationsQueryKey = ["vacations"] as const;

export const myVacationBalanceQueryOptions = () =>
	queryOptions({
		queryKey: [...vacationsQueryKey, "balance", "me"] as const,
		queryFn: (): Promise<VacationBalance> =>
			apiJson(vacationsSpec.balance.path, vacationsSpec.balance.response),
	});

export const userVacationBalanceQueryOptions = (userId: string) =>
	queryOptions({
		queryKey: [...vacationsQueryKey, "balance", userId] as const,
		queryFn: (): Promise<VacationBalance> =>
			apiJson(
				resolvePath(vacationsSpec.balanceOfUser.path, { id: userId }),
				vacationsSpec.balanceOfUser.response,
			),
	});

export const vacationRequestsQueryOptions = (
	query: Partial<ListVacationRequestsQuery> = {},
) =>
	queryOptions({
		queryKey: [...vacationsQueryKey, "requests", query] as const,
		queryFn: (): Promise<VacationRequest[]> =>
			apiJson(
				withQuery(vacationsSpec.list.path, query),
				vacationsSpec.list.response,
			),
	});

function useVacationsMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: vacationsQueryKey });
			void queryClient.invalidateQueries({ queryKey: attendanceQueryKey });
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}

export function useCreateVacationRequest() {
	return useVacationsMutation(
		(input: CreateVacationRequestInput): Promise<VacationRequest> =>
			apiJson(vacationsSpec.request.path, vacationsSpec.request.response, {
				method: vacationsSpec.request.method,
				body: JSON.stringify(vacationsSpec.request.body.parse(input)),
			}),
	);
}

export function useCancelVacationRequest() {
	return useVacationsMutation(
		({ id }: { id: string }): Promise<VacationRequest> =>
			apiJson(
				resolvePath(vacationsSpec.cancel.path, { id }),
				vacationsSpec.cancel.response,
				{ method: vacationsSpec.cancel.method },
			),
	);
}

export function useReviewVacationRequest() {
	return useVacationsMutation(
		({
			id,
			...input
		}: ReviewVacationRequestInput & { id: string }): Promise<VacationRequest> =>
			apiJson(
				resolvePath(vacationsSpec.review.path, { id }),
				vacationsSpec.review.response,
				{
					method: vacationsSpec.review.method,
					body: JSON.stringify(vacationsSpec.review.body.parse(input)),
				},
			),
	);
}
