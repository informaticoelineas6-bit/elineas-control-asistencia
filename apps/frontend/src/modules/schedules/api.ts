import { resolvePath, schedulesSpec, withQuery } from "@elineas/contracts";
import type {
	DepartmentSchedule,
	MySchedule,
	UpdateDepartmentScheduleInput,
	UpdateWorkCalendarInput,
	WorkCalendarEntry,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Acceso a horarios y calendario laboral (spec 07).
 *
 * Las rutas salen del contrato y se resuelven con `resolvePath`/`withQuery`: aquí
 * no hay ninguna URL escrita a mano (api-conventions.md).
 *
 * Toda mutación invalida `schedulesQueryKey`, que es prefijo de la consulta del
 * horario propio: cambiar el horario de un departamento cambia lo que ve cada uno
 * de sus miembros, y una invalidación quirúrgica se desincroniza a la primera.
 */

export const schedulesQueryKey = ["schedules"] as const;

export const departmentScheduleQueryOptions = (departmentId: string) =>
	queryOptions({
		queryKey: [...schedulesQueryKey, "department", departmentId] as const,
		queryFn: (): Promise<DepartmentSchedule | null> =>
			apiJson(
				resolvePath(schedulesSpec.get.path, { id: departmentId }),
				schedulesSpec.get.response,
			),
	});

export const workCalendarQueryOptions = (
	departmentId: string,
	range: { from: string; to: string },
) =>
	queryOptions({
		queryKey: [
			...schedulesQueryKey,
			"calendar",
			departmentId,
			range.from,
			range.to,
		] as const,
		queryFn: (): Promise<WorkCalendarEntry[]> =>
			apiJson(
				withQuery(
					resolvePath(schedulesSpec.calendar.path, { id: departmentId }),
					range,
				),
				schedulesSpec.calendar.response,
			),
	});

/**
 * El horario propio. Sin rango pide el mes en curso, y **quién decide cuál es el
 * mes en curso es el servidor**, en la zona del horario (RN-07.2): el reloj del
 * navegador puede estar en otra.
 */
export const myScheduleQueryOptions = (range?: { from: string; to: string }) =>
	queryOptions({
		queryKey: [...schedulesQueryKey, "me", range ?? null] as const,
		queryFn: (): Promise<MySchedule> =>
			apiJson(
				withQuery(schedulesSpec.mine.path, range ?? {}),
				schedulesSpec.mine.response,
			),
	});

function useScheduleMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn,
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: schedulesQueryKey }),
	});
}

export function useUpdateSchedule() {
	return useScheduleMutation(
		({
			departmentId,
			...input
		}: UpdateDepartmentScheduleInput & {
			departmentId: string;
		}): Promise<DepartmentSchedule> =>
			apiJson(
				resolvePath(schedulesSpec.update.path, { id: departmentId }),
				schedulesSpec.update.response,
				{
					method: schedulesSpec.update.method,
					body: JSON.stringify(schedulesSpec.update.body.parse(input)),
				},
			),
	);
}

export function useDeleteSchedule() {
	return useScheduleMutation(({ departmentId }: { departmentId: string }) =>
		apiJson(
			resolvePath(schedulesSpec.remove.path, { id: departmentId }),
			schedulesSpec.remove.response,
			{ method: schedulesSpec.remove.method },
		),
	);
}

export function useUpdateWorkCalendar() {
	return useScheduleMutation(
		({
			departmentId,
			...input
		}: UpdateWorkCalendarInput & {
			departmentId: string;
		}): Promise<WorkCalendarEntry[]> =>
			apiJson(
				resolvePath(schedulesSpec.updateCalendar.path, { id: departmentId }),
				schedulesSpec.updateCalendar.response,
				{
					method: schedulesSpec.updateCalendar.method,
					body: JSON.stringify(schedulesSpec.updateCalendar.body.parse(input)),
				},
			),
	);
}
