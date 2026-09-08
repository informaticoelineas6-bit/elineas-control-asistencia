import { auditSpec, resolvePath, withQuery } from "@elineas/contracts";
import type { AuditPage, ListAuditQuery } from "@elineas/validations";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Acceso a la bitácora (spec 18 §6). **Sólo lectura**, porque la API sólo lee:
 * aquí no hay ni una mutación, y no es una omisión — RN-18.6.
 *
 * La lista es una **consulta infinita** y no una paginada por número: el cursor
 * de la §6 va por *keyset* justamente porque la bitácora crece por el extremo
 * que se está leyendo, y "página 3" no significa lo mismo dos minutos después.
 * `useInfiniteQuery` es la forma que encaja con eso — se pide más, nunca "otra
 * página".
 */

export const auditQueryKey = ["audit"] as const;

export type AuditFilters = Omit<ListAuditQuery, "cursor" | "limit">;

const PAGE_SIZE = 50;

export const auditPagesQueryOptions = (filters: AuditFilters) =>
	infiniteQueryOptions({
		queryKey: [...auditQueryKey, "list", filters] as const,
		queryFn: ({ pageParam }): Promise<AuditPage> =>
			apiJson(
				withQuery(auditSpec.list.path, {
					...filters,
					limit: PAGE_SIZE,
					cursor: pageParam ?? undefined,
				}),
				auditSpec.list.response,
			),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});

/** El historial de un registro concreto (§7: "ver su historial"). */
export const resourceHistoryQueryOptions = (tableName: string, id: string) =>
	queryOptions({
		queryKey: [...auditQueryKey, "resource", tableName, id] as const,
		queryFn: (): Promise<AuditPage> =>
			apiJson(
				resolvePath(auditSpec.resource.path, { tableName, id }),
				auditSpec.resource.response,
			),
	});
