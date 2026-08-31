import { locationsSpec, resolvePath, withQuery } from "@elineas/contracts";
import type {
	CreateWorkLocationInput,
	DevicePosition,
	LocationVerdict,
	MyWorkLocation,
	UpdateWorkLocationInput,
	WorkLocation,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";
import {
	readCachedWorkLocation,
	writeCachedWorkLocation,
} from "#/modules/locations/selection-cache.ts";

/**
 * Acceso a sedes y geocerca (spec 08).
 *
 * Las rutas salen del contrato (api-conventions.md). Toda mutación invalida
 * `workLocationsQueryKey`, que es prefijo de la consulta de la sede propia: desactivar
 * una sede cambia lo que ve cada persona que la tenía elegida.
 */

export const workLocationsQueryKey = ["work-locations"] as const;

export const workLocationsQueryOptions = (
	options: { includeInactive?: boolean } = {},
) =>
	queryOptions({
		queryKey: [...workLocationsQueryKey, options] as const,
		queryFn: (): Promise<WorkLocation[]> =>
			apiJson(
				withQuery(locationsSpec.list.path, {
					includeInactive: options.includeInactive,
				}),
				locationsSpec.list.response,
			),
	});

/**
 * La sede propia. `identityUserId` sólo se usa para la **caché local**: la respuesta
 * autorizada es la del servidor, y la copia en disco existe para que al abrir en frío
 * no aparezca "sin sede" durante media petición.
 */
export const myWorkLocationQueryOptions = (identityUserId?: string) =>
	queryOptions({
		queryKey: [...workLocationsQueryKey, "me"] as const,
		queryFn: async (): Promise<MyWorkLocation> => {
			const mine = await apiJson(
				locationsSpec.mine.path,
				locationsSpec.mine.response,
			);
			if (identityUserId) writeCachedWorkLocation(identityUserId, mine);
			return mine;
		},
		placeholderData: identityUserId
			? readCachedWorkLocation(identityUserId)
			: undefined,
	});

function useLocationMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: workLocationsQueryKey }),
	});
}

export function useCreateWorkLocation() {
	return useLocationMutation(
		(input: CreateWorkLocationInput): Promise<WorkLocation> =>
			apiJson(locationsSpec.create.path, locationsSpec.create.response, {
				method: locationsSpec.create.method,
				body: JSON.stringify(locationsSpec.create.body.parse(input)),
			}),
	);
}

export function useUpdateWorkLocation() {
	return useLocationMutation(
		({
			id,
			...patch
		}: UpdateWorkLocationInput & { id: string }): Promise<WorkLocation> =>
			apiJson(
				resolvePath(locationsSpec.update.path, { id }),
				locationsSpec.update.response,
				{
					method: locationsSpec.update.method,
					body: JSON.stringify(locationsSpec.update.body.parse(patch)),
				},
			),
	);
}

export function useDeactivateWorkLocation() {
	return useLocationMutation(
		({ id }: { id: string }): Promise<WorkLocation> =>
			apiJson(
				resolvePath(locationsSpec.deactivate.path, { id }),
				locationsSpec.deactivate.response,
				{ method: locationsSpec.deactivate.method },
			),
	);
}

export function useReactivateWorkLocation() {
	return useLocationMutation(
		({ id }: { id: string }): Promise<WorkLocation> =>
			apiJson(
				resolvePath(locationsSpec.reactivate.path, { id }),
				locationsSpec.reactivate.response,
				{ method: locationsSpec.reactivate.method },
			),
	);
}

export function useSelectWorkLocation() {
	return useLocationMutation(
		({
			workLocationId,
		}: {
			workLocationId: string | null;
		}): Promise<MyWorkLocation> =>
			apiJson(locationsSpec.select.path, locationsSpec.select.response, {
				method: locationsSpec.select.method,
				body: JSON.stringify(
					locationsSpec.select.body.parse({ workLocationId }),
				),
			}),
	);
}

/**
 * El veredicto del **servidor** para una lectura del dispositivo (spec 08 §6).
 *
 * Es una mutación y no una consulta a propósito: se dispara cuando alguien pulsa
 * "comprobar", con la lectura que acaba de dar el GPS, y no debe cachearse — dos
 * segundos después el veredicto puede ser otro.
 */
export function useCheckLocation() {
	return useMutation({
		mutationFn: (position: DevicePosition): Promise<LocationVerdict> =>
			apiJson(locationsSpec.check.path, locationsSpec.check.response, {
				method: locationsSpec.check.method,
				body: JSON.stringify(locationsSpec.check.body.parse(position)),
			}),
	});
}
