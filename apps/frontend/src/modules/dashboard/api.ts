import { dashboardSpec, withQuery } from "@elineas/contracts";
import type {
	AttendanceDay,
	DailyRosterEntry,
	DashboardAlerts,
	DashboardSummary,
	DashboardTrend,
} from "@elineas/validations";
import { queryOptions } from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Acceso a los paneles y al dashboard (spec 15). Las rutas salen del contrato.
 *
 * **Todo es de lectura**: esta spec no escribe nada. Las acciones que salen de
 * sus pantallas —justificar una ausencia, revisar una incidencia— son de las
 * specs 12 y 13 y usan sus propios módulos, que ya invalidan lo que corresponde.
 * Por eso aquí no hay ni una mutación ni un `invalidateQueries`.
 */

export const dashboardQueryKey = ["dashboard"] as const;

export const dashboardSummaryQueryOptions = () =>
	queryOptions({
		queryKey: [...dashboardQueryKey, "summary"] as const,
		queryFn: (): Promise<DashboardSummary> =>
			apiJson(dashboardSpec.summary.path, dashboardSpec.summary.response),
	});

export const dashboardTrendQueryOptions = (days = 7) =>
	queryOptions({
		queryKey: [...dashboardQueryKey, "trend", days] as const,
		queryFn: (): Promise<DashboardTrend> =>
			apiJson(
				withQuery(dashboardSpec.trend.path, { days }),
				dashboardSpec.trend.response,
			),
	});

export const dashboardAlertsQueryOptions = () =>
	queryOptions({
		queryKey: [...dashboardQueryKey, "alerts"] as const,
		queryFn: (): Promise<DashboardAlerts> =>
			apiJson(dashboardSpec.alerts.path, dashboardSpec.alerts.response),
	});

export const dailyRosterQueryOptions = (
	query: { date?: string; departmentId?: string } = {},
) =>
	queryOptions({
		queryKey: [...dashboardQueryKey, "roster", query] as const,
		queryFn: (): Promise<DailyRosterEntry[]> =>
			apiJson(
				withQuery(dashboardSpec.daily.path, query),
				dashboardSpec.daily.response,
			),
	});

export const userDaysQueryOptions = (query: {
	userId: string;
	from: string;
	to: string;
}) =>
	queryOptions({
		queryKey: [...dashboardQueryKey, "user-days", query] as const,
		queryFn: (): Promise<AttendanceDay[]> =>
			apiJson(
				withQuery(dashboardSpec.dailyRange.path, query),
				dashboardSpec.dailyRange.response,
			),
	});
