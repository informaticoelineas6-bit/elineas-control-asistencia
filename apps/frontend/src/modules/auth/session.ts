import { authSpec } from "@elineas/contracts";
import type { LoginInput, Permissions } from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { apiError, apiFetch } from "#/lib/api-client";

export const sessionQueryKey = ["session"] as const;

/**
 * Sesión actual. `null` significa "no hay sesión", no "fallo": el 401 es una
 * respuesta esperada y no debe pintarse como error.
 *
 * La resolución es en cliente a propósito. Las cookies de sesión pertenecen al
 * origen del backend (:3001), así que durante el SSR del frontend (:3004) no
 * están disponibles; el layout muestra un esqueleto hasta que esta consulta
 * responde. Si algún día ambos se sirven bajo el mismo origen, esto puede pasar
 * a un loader (decisión abierta §C.9.1 de la spec 00).
 */
export const sessionQueryOptions = () =>
	queryOptions({
		queryKey: sessionQueryKey,
		queryFn: async (): Promise<Permissions | null> => {
			const res = await apiFetch(authSpec.permissions.path);
			if (res.status === 401) return null;
			if (!res.ok) throw await apiError(res);
			return authSpec.permissions.response.parse(await res.json());
		},
		staleTime: 60_000,
		retry: false,
	});

export function useLogin() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: LoginInput): Promise<Permissions> => {
			const res = await apiFetch(authSpec.login.path, {
				method: authSpec.login.method,
				body: JSON.stringify(authSpec.login.body.parse(input)),
			});
			if (!res.ok) throw await apiError(res);
			return authSpec.login.response.parse(await res.json());
		},
		onSuccess: (session) => {
			queryClient.setQueryData(sessionQueryKey, session);
		},
	});
}

export function useLogout() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	return useMutation({
		mutationFn: async () => {
			// Se ignora el resultado a propósito: aunque el IS no responda, aquí
			// la sesión se termina. El backend limpia sus cookies igualmente.
			await apiFetch(authSpec.logout.path, { method: authSpec.logout.method });
		},
		onSettled: async () => {
			queryClient.setQueryData(sessionQueryKey, null);
			await queryClient.invalidateQueries();
			await navigate({ to: "/login" });
		},
	});
}
