import { countWorkableDays, isRestDate } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import {
	CircleAlert,
	Loader2,
	Plane,
	TriangleAlert,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Calendar, type DateRange } from "#/components/ui/calendar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { formatShortDate, toISODate } from "#/lib/dates.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { myRestScheduleQueryOptions } from "#/modules/rest/api.ts";
import { myScheduleQueryOptions } from "#/modules/schedules/api.ts";
import {
	myVacationBalanceQueryOptions,
	useCancelVacationRequest,
	useCreateVacationRequest,
	vacationRequestsQueryOptions,
} from "#/modules/vacations/api.ts";

const STATUS_LABEL: Record<string, string> = {
	pending: "Pendiente",
	approved: "Aprobada",
	rejected: "Rechazada",
	cancelled: "Cancelada",
};

const STATUS_VARIANT: Record<
	string,
	"secondary" | "default" | "destructive" | "outline"
> = {
	pending: "secondary",
	approved: "default",
	rejected: "destructive",
	cancelled: "outline",
};

/**
 * "Mis vacaciones" (spec 11 §7), en el perfil propio — mismo criterio que los
 * descansos: es un dato personal y se busca donde están las cosas de uno.
 *
 * La previsualización de cuántos días consume el rango elegido usa la **misma
 * función** que valida el servidor (`countWorkableDays`, RN-11.5), pero con un
 * atajo deliberado: los descansos se aproximan con el patrón semanal vigente
 * **hoy** (`resolved.daysOfWeek`) aplicado a todo el rango, en vez de resolver
 * día a día como hace el servidor (RN-10.1). Es exacto salvo que la persona
 * tenga ya programado un cambio de descansos dentro del rango elegido — un caso
 * raro—, y evita pedir el descanso de cada fecha por separado. El número que
 * cuenta, en cualquier caso, es el que devuelve el servidor al crear la
 * solicitud.
 */
export function MyVacationsCard() {
	const balance = useQuery(myVacationBalanceQueryOptions());
	const requests = useQuery(vacationRequestsQueryOptions());
	const restSchedule = useQuery(myRestScheduleQueryOptions());

	const create = useCreateVacationRequest();
	const cancel = useCancelVacationRequest();

	const [range, setRange] = useState<DateRange>({ from: null, to: null });

	const from = range.from ? toISODate(range.from) : null;
	const to = range.to ? toISODate(range.to) : null;

	// El calendario laboral del rango elegido, sólo cuando hay algo que
	// previsualizar: pedirlo antes sería una consulta que nadie va a usar.
	const scheduleRange = useQuery({
		...myScheduleQueryOptions(from && to ? { from, to } : undefined),
		enabled: !!(from && to),
	});

	const preview = useMemo(() => {
		if (!from || !to || !scheduleRange.data) return null;

		const dates: string[] = [];
		for (
			let cursor = new Date(`${from}T00:00:00.000Z`);
			cursor <= new Date(`${to}T00:00:00.000Z`);
			cursor = new Date(cursor.getTime() + 86_400_000)
		) {
			dates.push(cursor.toISOString().slice(0, 10));
		}

		const byDate = new Map(
			scheduleRange.data.entries.map((entry) => [entry.date, entry]),
		);
		const isWorkday = (date: string) => byDate.get(date)?.isWorkday ?? true;
		const restDays = restSchedule.data?.resolved.daysOfWeek ?? [];
		const isRestDay = (date: string) => isRestDate(restDays, date);

		return countWorkableDays(dates, isWorkday, isRestDay);
	}, [from, to, scheduleRange.data, restSchedule.data]);

	const dirty = !!(from && to);
	const exceedsBalance =
		preview !== null &&
		balance.data !== null &&
		preview > (balance.data?.available ?? 0);

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!from || !to || preview === null || preview <= 0 || exceedsBalance)
			return;

		create.mutate(
			{ startDate: from, endDate: to },
			{ onSuccess: () => setRange({ from: null, to: null }) },
		);
	};

	const loading = balance.isPending || requests.isPending;

	return (
		<section className="space-y-4 rounded-xl border p-4">
			<div>
				<h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
					<Plane className="size-4" />
					Mis vacaciones
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Saldo acumulado por días trabajados. No consumen los días de descanso
					ni los no laborables dentro del rango.
				</p>
			</div>

			<InlineError error={balance.error ?? requests.error} />

			{loading ? (
				<Skeleton className="h-56 w-full" />
			) : (
				balance.data && (
					<>
						<dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-4">
							<div>
								<dt className="text-xs text-muted-foreground">Ganados</dt>
								<dd className="text-lg font-semibold">{balance.data.earned}</dd>
							</div>
							<div>
								<dt className="text-xs text-muted-foreground">Usados</dt>
								<dd className="text-lg font-semibold">{balance.data.used}</dd>
							</div>
							<div>
								<dt className="text-xs text-muted-foreground">Pendientes</dt>
								<dd className="text-lg font-semibold">
									{balance.data.pending}
								</dd>
							</div>
							<div>
								<dt className="text-xs text-muted-foreground">Disponibles</dt>
								<dd className="text-lg font-semibold text-primary">
									{balance.data.available}
								</dd>
							</div>
						</dl>

						{balance.data.available <= 0 && (
							<p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
								<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
								Sin saldo disponible todavía. Se gana con los días trabajados
								(spec 06 §3.4).
							</p>
						)}

						<form onSubmit={onSubmit} className="space-y-3">
							<Calendar
								mode="range"
								size="sm"
								numberOfMonths={2}
								fromDate={new Date()}
								selected={range}
								onSelect={setRange}
								label="Rango de vacaciones a solicitar"
							/>

							{dirty && (
								<div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
									<p>
										{formatShortDate(from ?? "")} al {formatShortDate(to ?? "")}
									</p>
									{preview === null ? (
										<p className="text-muted-foreground">Calculando…</p>
									) : (
										<p>
											Consume{" "}
											<strong>
												{preview} {preview === 1 ? "día" : "días"}
											</strong>{" "}
											de tu saldo.
										</p>
									)}
									{preview === 0 && (
										<p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
											<TriangleAlert className="mt-0.5 size-4 shrink-0" />
											Ese rango no tiene ningún día laborable tuyo: no se puede
											pedir.
										</p>
									)}
									{exceedsBalance && (
										<p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
											<TriangleAlert className="mt-0.5 size-4 shrink-0" />
											No te alcanza el saldo para ese rango.
										</p>
									)}
								</div>
							)}

							<InlineError error={create.error} />

							<Button
								type="submit"
								disabled={
									!dirty ||
									preview === null ||
									preview <= 0 ||
									exceedsBalance ||
									create.isPending
								}
							>
								{create.isPending && <Loader2 className="animate-spin" />}
								Solicitar vacaciones
							</Button>
						</form>
					</>
				)
			)}

			{requests.data && requests.data.length > 0 && (
				<div className="space-y-2 border-t pt-4">
					<h3 className="text-sm font-medium text-muted-foreground">
						Mis solicitudes
					</h3>
					<ul className="space-y-2">
						{requests.data.map((item) => (
							<li
								key={item.id}
								className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
							>
								<div>
									<p>
										{formatShortDate(item.startDate)} al{" "}
										{formatShortDate(item.endDate)} ({item.requestedDays}{" "}
										{item.requestedDays === 1 ? "día" : "días"})
									</p>
									{item.reviewComment && (
										<p className="mt-0.5 text-xs text-muted-foreground">
											{item.reviewComment}
										</p>
									)}
								</div>
								<div className="flex items-center gap-2">
									<Badge variant={STATUS_VARIANT[item.status]}>
										{STATUS_LABEL[item.status]}
									</Badge>
									{(item.status === "pending" ||
										item.status === "approved") && (
										<Button
											type="button"
											size="sm"
											variant="ghost"
											disabled={cancel.isPending}
											onClick={() => cancel.mutate({ id: item.id })}
										>
											<XCircle />
											Cancelar
										</Button>
									)}
								</div>
							</li>
						))}
					</ul>
					<InlineError error={cancel.error} />
				</div>
			)}
		</section>
	);
}
