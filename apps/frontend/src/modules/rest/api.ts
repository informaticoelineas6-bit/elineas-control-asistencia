import { resolvePath, restSpec, withQuery } from "@elineas/contracts";
import type {
	CreateRestGroupInput,
	DepartmentRestDays,
	RestGroup,
	RestScheduleView,
	UpdateRestGroupInput,
	UpdateRestGroupMembersInput,
	UpdateRestScheduleInput,
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
 * Acceso a descansos (spec 10). Las rutas salen del contrato; aquí no hay
 * ninguna URL escrita a mano (api-conventions.md).
 *
 * Toda mutación invalida además **la asistencia y las notificaciones**, y no por
 * exceso de celo: cambiar un descanso cambia si se puede marcar hoy (RN-10.4) y
 * retira el recordatorio de RN-10.10. Sin esas dos invalidaciones la pantalla de
 * marcaje seguiría ofreciendo el botón y la campana seguiría pidiendo configurar
 * lo que se acaba de configurar.
 */

export const restQueryKey = ["rest"] as const;

export const myRestScheduleQueryOptions = (date?: string) =>
	queryOptions({
		queryKey: [...restQueryKey, "me", date ?? null] as const,
		queryFn: (): Promise<RestScheduleView> =>
			apiJson(withQuery(restSpec.mine.path, { date }), restSpec.mine.response),
	});

export const userRestScheduleQueryOptions = (userId: string, date?: string) =>
	queryOptions({
		queryKey: [...restQueryKey, "user", userId, date ?? null] as const,
		queryFn: (): Promise<RestScheduleView> =>
			apiJson(
				withQuery(resolvePath(restSpec.ofUser.path, { id: userId }), { date }),
				restSpec.ofUser.response,
			),
	});

export const restGroupsQueryOptions = (departmentId: string) =>
	queryOptions({
		queryKey: [...restQueryKey, "groups", departmentId] as const,
		queryFn: (): Promise<RestGroup[]> =>
			apiJson(
				resolvePath(restSpec.groups.path, { id: departmentId }),
				restSpec.groups.response,
			),
	});

export const departmentRestDaysQueryOptions = (
	departmentId: string,
	range: { from: string; to: string },
) =>
	queryOptions({
		queryKey: [
			...restQueryKey,
			"department-days",
			departmentId,
			range.from,
			range.to,
		] as const,
		queryFn: (): Promise<DepartmentRestDays> =>
			apiJson(
				withQuery(
					resolvePath(restSpec.departmentRestDays.path, { id: departmentId }),
					range,
				),
				restSpec.departmentRestDays.response,
			),
	});

function useRestMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: restQueryKey });
			void queryClient.invalidateQueries({ queryKey: attendanceQueryKey });
			void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
		},
	});
}

export function useUpdateMyRestSchedule() {
	return useRestMutation(
		(input: UpdateRestScheduleInput): Promise<RestScheduleView> =>
			apiJson(restSpec.updateMine.path, restSpec.updateMine.response, {
				method: restSpec.updateMine.method,
				body: JSON.stringify(restSpec.updateMine.body.parse(input)),
			}),
	);
}

export function useUpdateUserRestSchedule() {
	return useRestMutation(
		({
			userId,
			...input
		}: UpdateRestScheduleInput & {
			userId: string;
		}): Promise<RestScheduleView> =>
			apiJson(
				resolvePath(restSpec.updateOfUser.path, { id: userId }),
				restSpec.updateOfUser.response,
				{
					method: restSpec.updateOfUser.method,
					body: JSON.stringify(restSpec.updateOfUser.body.parse(input)),
				},
			),
	);
}

export function useCreateRestGroup() {
	return useRestMutation(
		({
			departmentId,
			...input
		}: CreateRestGroupInput & { departmentId: string }): Promise<RestGroup> =>
			apiJson(
				resolvePath(restSpec.createGroup.path, { id: departmentId }),
				restSpec.createGroup.response,
				{
					method: restSpec.createGroup.method,
					body: JSON.stringify(restSpec.createGroup.body.parse(input)),
				},
			),
	);
}

export function useUpdateRestGroup() {
	return useRestMutation(
		({
			id,
			...patch
		}: UpdateRestGroupInput & { id: string }): Promise<RestGroup> =>
			apiJson(
				resolvePath(restSpec.updateGroup.path, { id }),
				restSpec.updateGroup.response,
				{
					method: restSpec.updateGroup.method,
					body: JSON.stringify(restSpec.updateGroup.body.parse(patch)),
				},
			),
	);
}

export function useDeleteRestGroup() {
	return useRestMutation(({ id }: { id: string }) =>
		apiJson(
			resolvePath(restSpec.removeGroup.path, { id }),
			restSpec.removeGroup.response,
			{ method: restSpec.removeGroup.method },
		),
	);
}

export function useSetRestGroupMembers() {
	return useRestMutation(
		({
			id,
			...input
		}: UpdateRestGroupMembersInput & { id: string }): Promise<RestGroup[]> =>
			apiJson(
				resolvePath(restSpec.setMembers.path, { id }),
				restSpec.setMembers.response,
				{
					method: restSpec.setMembers.method,
					body: JSON.stringify(restSpec.setMembers.body.parse(input)),
				},
			),
	);
}
