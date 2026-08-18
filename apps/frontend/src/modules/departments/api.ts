import { departmentsSpec, resolvePath, withQuery } from "@elineas/contracts";
import type {
	CreateDepartmentInput,
	Department,
	DepartmentMember,
	DepartmentSummary,
	UpdateDepartmentInput,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Acceso a departamentos (spec 01).
 *
 * Las rutas salen del contrato y se resuelven con `resolvePath`: aquí no hay una
 * sola URL escrita a mano, que es lo que evita que frontend y backend se
 * desincronicen (api-conventions.md).
 */

export const departmentsQueryKey = ["departments"] as const;

export const departmentsQueryOptions = (
	options: { includePaused?: boolean } = {},
) =>
	queryOptions({
		queryKey: [...departmentsQueryKey, options] as const,
		queryFn: (): Promise<DepartmentSummary[]> =>
			apiJson(
				withQuery(departmentsSpec.list.path, {
					includePaused: options.includePaused,
				}),
				departmentsSpec.list.response,
			),
	});

export const departmentMembersQueryOptions = (departmentId: string) =>
	queryOptions({
		queryKey: [...departmentsQueryKey, departmentId, "members"] as const,
		queryFn: (): Promise<DepartmentMember[]> =>
			apiJson(
				resolvePath(departmentsSpec.members.path, { id: departmentId }),
				departmentsSpec.members.response,
			),
	});

/**
 * Toda mutación invalida la lista completa: los conteos de miembros y el badge de
 * pausa cambian con casi cualquier cosa, y una lista pequeña no justifica
 * actualizaciones quirúrgicas que se desincronizan a la primera.
 */
function useDepartmentMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: departmentsQueryKey }),
	});
}

export function useCreateDepartment() {
	return useDepartmentMutation(
		(input: CreateDepartmentInput): Promise<Department> =>
			apiJson(departmentsSpec.create.path, departmentsSpec.create.response, {
				method: departmentsSpec.create.method,
				body: JSON.stringify(departmentsSpec.create.body.parse(input)),
			}),
	);
}

export function useUpdateDepartment() {
	return useDepartmentMutation(
		({
			id,
			...patch
		}: UpdateDepartmentInput & { id: string }): Promise<Department> =>
			apiJson(
				resolvePath(departmentsSpec.update.path, { id }),
				departmentsSpec.update.response,
				{
					method: departmentsSpec.update.method,
					body: JSON.stringify(departmentsSpec.update.body.parse(patch)),
				},
			),
	);
}

export function usePauseDepartment() {
	return useDepartmentMutation(
		({ id, reason }: { id: string; reason: string }): Promise<Department> =>
			apiJson(
				resolvePath(departmentsSpec.pause.path, { id }),
				departmentsSpec.pause.response,
				{
					method: departmentsSpec.pause.method,
					body: JSON.stringify(departmentsSpec.pause.body.parse({ reason })),
				},
			),
	);
}

export function useResumeDepartment() {
	return useDepartmentMutation(
		({ id }: { id: string }): Promise<Department> =>
			apiJson(
				resolvePath(departmentsSpec.resume.path, { id }),
				departmentsSpec.resume.response,
				{ method: departmentsSpec.resume.method },
			),
	);
}

export function useDeleteDepartment() {
	return useDepartmentMutation(({ id }: { id: string }) =>
		apiJson(
			resolvePath(departmentsSpec.remove.path, { id }),
			departmentsSpec.remove.response,
			{ method: departmentsSpec.remove.method },
		),
	);
}
