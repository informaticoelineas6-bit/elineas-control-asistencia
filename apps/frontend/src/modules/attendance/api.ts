import { attendanceSpec, withQuery } from "@elineas/contracts";
import type {
	AttendanceDay,
	AttendanceMark,
	AttendanceMarkResult,
	AttendanceStatus,
	CreateAttendanceMarkInput,
} from "@elineas/validations";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { apiJson } from "#/lib/api-client.ts";

/**
 * Acceso al marcaje (spec 09).
 *
 * `status` es la consulta que sostiene la pantalla de marcar: dice qué toca ahora
 * **sin** intentarlo y fallar (spec 09 §6). Se refresca sola cada minuto porque la
 * ventana horaria se cierra sola: quien deja la pantalla abierta a las 08:14 tiene
 * que ver que a las 08:16 ya no puede entrar, sin recargar.
 */

export const attendanceQueryKey = ["attendance"] as const;

export const attendanceStatusQueryOptions = () =>
	queryOptions({
		queryKey: [...attendanceQueryKey, "status"] as const,
		queryFn: (): Promise<AttendanceStatus> =>
			apiJson(attendanceSpec.status.path, attendanceSpec.status.response),
		staleTime: 30_000,
		refetchInterval: 60_000,
	});

export const todayMarksQueryOptions = () =>
	queryOptions({
		queryKey: [...attendanceQueryKey, "today"] as const,
		queryFn: (): Promise<AttendanceMark[]> =>
			apiJson(attendanceSpec.today.path, attendanceSpec.today.response),
	});

export const attendanceHistoryQueryOptions = (range: {
	from: string;
	to: string;
}) =>
	queryOptions({
		queryKey: [...attendanceQueryKey, "history", range.from, range.to] as const,
		queryFn: (): Promise<AttendanceDay[]> =>
			apiJson(
				withQuery(attendanceSpec.mine.path, range),
				attendanceSpec.mine.response,
			),
	});

/**
 * Registrar un marcaje.
 *
 * **Un rechazo llega como respuesta correcta**, no como error: el backend responde
 * 200 con el motivo tipado (spec 09 §6), así que `onError` es sólo para fallos de
 * red. Es lo que permite que la pantalla muestre "estás a 180 m, acércate" en vez
 * de un mensaje de avería.
 */
export function useCreateMark() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (
			input: CreateAttendanceMarkInput,
		): Promise<AttendanceMarkResult> =>
			apiJson(attendanceSpec.create.path, attendanceSpec.create.response, {
				method: attendanceSpec.create.method,
				body: JSON.stringify(attendanceSpec.create.body.parse(input)),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: attendanceQueryKey }),
	});
}
