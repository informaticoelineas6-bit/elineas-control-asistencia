import { resolvePath, usersSpec, withQuery } from "@elineas/contracts";
import type {
	Compensation,
	DepartmentResponsibilities,
	OwnProfile,
	UpdateCompensationInput,
	UpdateOwnProfileInput,
	UpdateUserInput,
	UserProfile,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";
import { sessionQueryKey } from "#/modules/auth/session.ts";

/**
 * Acceso a usuarios y perfiles (spec 02).
 *
 * El sueldo tiene sus propias consultas, separadas del perfil, igual que en el
 * backend: sólo se pide cuando alguien abre expresamente el diálogo de
 * compensación, así que no viaja al navegador de nadie que no lo esté mirando
 * (spec 02 §6).
 */

export const usersQueryKey = ["users"] as const;
export const ownProfileQueryKey = ["me", "profile"] as const;

export const usersQueryOptions = (
	filters: {
		search?: string;
		departmentId?: string;
		includeInactive?: boolean;
	} = {},
) =>
	queryOptions({
		queryKey: [...usersQueryKey, "list", filters] as const,
		queryFn: (): Promise<UserProfile[]> =>
			apiJson(
				withQuery(usersSpec.list.path, {
					search: filters.search || undefined,
					departmentId: filters.departmentId || undefined,
					includeInactive: filters.includeInactive,
				}),
				usersSpec.list.response,
			),
	});

/** Perfiles sin departamento: el alta que quedó a medias (RN-02.3). */
export const incompleteUsersQueryOptions = () =>
	queryOptions({
		queryKey: [...usersQueryKey, "incomplete"] as const,
		queryFn: (): Promise<UserProfile[]> =>
			apiJson(usersSpec.incomplete.path, usersSpec.incomplete.response),
	});

/**
 * Ámbito departamental de un perfil (spec 03 §7). Se pide sólo al abrir su
 * diálogo, igual que el sueldo: no hace falta en el listado.
 */
export const responsibilitiesQueryOptions = (profileId: string) =>
	queryOptions({
		queryKey: [...usersQueryKey, profileId, "responsibilities"] as const,
		queryFn: (): Promise<DepartmentResponsibilities> =>
			apiJson(
				resolvePath(usersSpec.responsibilities.path, { id: profileId }),
				usersSpec.responsibilities.response,
			),
	});

export const compensationQueryOptions = (profileId: string) =>
	queryOptions({
		queryKey: [...usersQueryKey, profileId, "compensation"] as const,
		queryFn: (): Promise<Compensation> =>
			apiJson(
				resolvePath(usersSpec.compensation.path, { id: profileId }),
				usersSpec.compensation.response,
			),
	});

export const ownProfileQueryOptions = () =>
	queryOptions({
		queryKey: ownProfileQueryKey,
		queryFn: (): Promise<OwnProfile> =>
			apiJson(usersSpec.me.path, usersSpec.me.response),
	});

/**
 * Cualquier cambio invalida la lista entera y la de incompletos: asignar un
 * departamento saca a alguien de una y lo mete en la otra.
 */
function useUserMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: usersQueryKey }),
	});
}

export function useUpdateUser() {
	return useUserMutation(
		({
			id,
			...patch
		}: UpdateUserInput & { id: string }): Promise<UserProfile> =>
			apiJson(
				resolvePath(usersSpec.update.path, { id }),
				usersSpec.update.response,
				{
					method: usersSpec.update.method,
					body: JSON.stringify(usersSpec.update.body.parse(patch)),
				},
			),
	);
}

export function useDeactivateUser() {
	return useUserMutation(
		({ id, reason }: { id: string; reason: string }): Promise<UserProfile> =>
			apiJson(
				resolvePath(usersSpec.deactivate.path, { id }),
				usersSpec.deactivate.response,
				{
					method: usersSpec.deactivate.method,
					body: JSON.stringify(usersSpec.deactivate.body.parse({ reason })),
				},
			),
	);
}

export function useReactivateUser() {
	return useUserMutation(
		({ id }: { id: string }): Promise<UserProfile> =>
			apiJson(
				resolvePath(usersSpec.reactivate.path, { id }),
				usersSpec.reactivate.response,
				{ method: usersSpec.reactivate.method },
			),
	);
}

export function useDeleteUser() {
	return useUserMutation(({ id }: { id: string }) =>
		apiJson(
			resolvePath(usersSpec.remove.path, { id }),
			usersSpec.remove.response,
			{ method: usersSpec.remove.method },
		),
	);
}

export function useUpdateCompensation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			id,
			...input
		}: UpdateCompensationInput & { id: string }): Promise<Compensation> =>
			apiJson(
				resolvePath(usersSpec.updateCompensation.path, { id }),
				usersSpec.updateCompensation.response,
				{
					method: usersSpec.updateCompensation.method,
					body: JSON.stringify(usersSpec.updateCompensation.body.parse(input)),
				},
			),
		onSuccess: (_result, variables) =>
			queryClient.invalidateQueries({
				queryKey: [...usersQueryKey, variables.id, "compensation"],
			}),
	});
}

/**
 * Reemplaza el conjunto de departamentos adicionales (RN-03.2).
 *
 * Invalida además la sesión: si el ámbito que cambia es el de quien está
 * usando la aplicación, su propio aside y sus listados dependen de
 * `managedDepartmentIds` y quedarían mostrando el ámbito anterior.
 */
export function useUpdateResponsibilities() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			id,
			departmentIds,
		}: {
			id: string;
			departmentIds: string[];
		}): Promise<DepartmentResponsibilities> =>
			apiJson(
				resolvePath(usersSpec.updateResponsibilities.path, { id }),
				usersSpec.updateResponsibilities.response,
				{
					method: usersSpec.updateResponsibilities.method,
					body: JSON.stringify(
						usersSpec.updateResponsibilities.body.parse({ departmentIds }),
					),
				},
			),
		onSuccess: async (_result, variables) => {
			await queryClient.invalidateQueries({
				queryKey: [...usersQueryKey, variables.id, "responsibilities"],
			});
			await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
		},
	});
}

export function useUpdateOwnProfile() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (input: UpdateOwnProfileInput): Promise<OwnProfile> =>
			apiJson(usersSpec.updateMe.path, usersSpec.updateMe.response, {
				method: usersSpec.updateMe.method,
				body: JSON.stringify(usersSpec.updateMe.body.parse(input)),
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ownProfileQueryKey });
			// El teléfono también viaja en la sesión, que alimenta el aside.
			await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
		},
	});
}

/** URL de la consola del Identity Server, si está configurada (RN-02.10). */
export const identityConsoleUrl: string | undefined =
	import.meta.env.VITE_IDENTITY_CONSOLE_URL || undefined;
