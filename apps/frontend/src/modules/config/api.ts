import { configSpec } from "@elineas/contracts";
import type {
	AppConfigValues,
	PublicConfigValues,
	UpdateConfigInput,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";
import { departmentsQueryKey } from "#/modules/departments/api.ts";

/**
 * Configuración global (spec 06).
 *
 * Dos consultas distintas y a propósito: `configQueryOptions` trae la tabla
 * entera y **sólo funciona para `global_manager+`** (RN-06.1) —cualquier otro rol
 * recibe 403—, así que se pide únicamente desde la pantalla de configuración.
 * `publicConfigQueryOptions` trae el subconjunto seguro y es la que pueden usar
 * las pantallas compartidas.
 */

export const configQueryKey = ["config"] as const;
export const publicConfigQueryKey = ["config", "public"] as const;

/**
 * Zona horaria, tolerancia y modo de salida (spec 06 §5). Es lo que necesita la
 * interfaz para mostrar las mismas horas y aplicar las mismas reglas que el
 * servidor, y cambia muy poco: se cachea largo.
 */
export const publicConfigQueryOptions = () =>
	queryOptions({
		queryKey: publicConfigQueryKey,
		queryFn: (): Promise<PublicConfigValues> =>
			apiJson(configSpec.getPublic.path, configSpec.getPublic.response),
		staleTime: 5 * 60_000,
	});

export const configQueryOptions = () =>
	queryOptions({
		queryKey: configQueryKey,
		queryFn: (): Promise<AppConfigValues> =>
			apiJson(configSpec.get.path, configSpec.get.response),
	});

export function useUpdateConfig() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (patch: UpdateConfigInput): Promise<AppConfigValues> =>
			apiJson(configSpec.update.path, configSpec.update.response, {
				method: configSpec.update.method,
				body: JSON.stringify(configSpec.update.body.parse(patch)),
			}),
		onSuccess: async () => {
			// `configQueryKey` es prefijo de `publicConfigQueryKey`, así que esta
			// invalidación alcanza a las dos. El departamento de gestores se pinta
			// además como badge en la lista de departamentos.
			await queryClient.invalidateQueries({ queryKey: configQueryKey });
			await queryClient.invalidateQueries({ queryKey: departmentsQueryKey });
		},
	});
}
