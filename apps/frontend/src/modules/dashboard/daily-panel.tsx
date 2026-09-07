import type {
	AttendanceDayStatus,
	DailyRosterEntry,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { DoorOpen, LogIn, LogOut, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { useDebouncedValue } from "#/hooks/use-debounced-value.ts";
import { toISODate } from "#/lib/dates.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { dailyRosterQueryOptions } from "#/modules/dashboard/api.ts";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Asistencia del día del ámbito (spec 15 §5.2 y §5.3).
 *
 * **Es una sola vista para los dos paneles.** La spec lo pide literalmente —"los
 * paneles 5.2 y 5.3 hacen lo mismo con distinto alcance… deben ser una vista
 * parametrizada por ámbito, no dos páginas"— y aquí ni siquiera hay un parámetro
 * de ámbito: el servidor devuelve lo que gestiona quien pregunta. Un jefe ve su
 * departamento; un gestor global, la empresa. Misma pantalla, mismo endpoint.
 *
 * El selector de departamento sólo aparece cuando hay más de uno que elegir
 * (RN-03.2): a un jefe de un solo departamento, un desplegable con una opción no
 * le sirve de nada.
 *
 * ⚠️ **La acción de justificar en línea que pide la §5.2 no está aquí**, y es
 * deliberado: la spec 13 la construyó como bandeja en `/team` porque su §5 pedía
 * justamente eso —una vista de pendientes, que el legacy no tenía— y tener el
 * mismo acto en dos sitios invita a dos formas distintas de hacerlo. Desde aquí
 * se ve quién está ausente; se clasifica en *Mi equipo*.
 */

const STATUS_LABEL: Record<AttendanceDayStatus, string> = {
	PRESENTE: "Presente",
	TARDE: "Tarde",
	AUSENTE: "Ausente",
	DESCANSO: "Descanso",
	NO_LABORABLE: "No laborable",
	VACACIONES: "Vacaciones",
};

const STATUS_BADGE: Record<
	AttendanceDayStatus,
	"default" | "secondary" | "destructive" | "outline" | "warning"
> = {
	PRESENTE: "default",
	TARDE: "warning",
	AUSENTE: "destructive",
	DESCANSO: "outline",
	NO_LABORABLE: "outline",
	VACACIONES: "secondary",
};

const ALL = "__all__";

const time = (value: string | null) =>
	value
		? new Date(value).toLocaleTimeString("es-CU", {
				hour: "2-digit",
				minute: "2-digit",
			})
		: "—";

export function DailyPanel() {
	const session = useQuery(sessionQueryOptions());
	const [date, setDate] = useState(() => toISODate(new Date()));
	const [departmentId, setDepartmentId] = useState<string>(ALL);
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search, 300);

	const roster = useQuery(
		dailyRosterQueryOptions({
			date,
			...(departmentId === ALL ? {} : { departmentId }),
		}),
	);

	// Los departamentos sólo hacen falta para el selector, y sólo si hay varios
	// en el ámbito. La lista completa la sirve un endpoint de gestor; para un
	// jefe se derivan de las propias filas, que ya traen su departamento.
	const departments = useQuery({
		...departmentsQueryOptions({ includePaused: true }),
		enabled: (session.data?.managedDepartmentIds.length ?? 0) > 1,
	});

	const options = useMemo(() => {
		const fromRoster = new Map<string, string>();
		for (const row of roster.data ?? []) {
			if (row.departmentId) {
				fromRoster.set(row.departmentId, row.departmentName ?? "—");
			}
		}
		for (const department of departments.data ?? []) {
			fromRoster.set(department.id, department.name);
		}
		return [...fromRoster.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name, "es"));
	}, [roster.data, departments.data]);

	const rows = useMemo(() => {
		const needle = debouncedSearch.trim().toLowerCase();
		if (!needle) return roster.data ?? [];
		return (roster.data ?? []).filter(
			(row) =>
				row.userFullName.toLowerCase().includes(needle) ||
				row.userEmail.toLowerCase().includes(needle),
		);
	}, [roster.data, debouncedSearch]);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="roster-date" className="text-xs">
						Día
					</Label>
					<Input
						id="roster-date"
						type="date"
						value={date}
						onChange={(event) => setDate(event.target.value)}
					/>
				</div>

				{options.length > 1 && (
					<div className="space-y-1.5">
						<Label htmlFor="roster-department" className="text-xs">
							Departamento
						</Label>
						<Select value={departmentId} onValueChange={setDepartmentId}>
							<SelectTrigger id="roster-department" className="w-56">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL}>Todo mi ámbito</SelectItem>
								{options.map((option) => (
									<SelectItem key={option.id} value={option.id}>
										{option.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<div className="relative min-w-56 flex-1 space-y-1.5">
					<Label htmlFor="roster-search" className="text-xs">
						Buscar
					</Label>
					<Search className="pointer-events-none absolute top-[30px] left-2.5 size-4 text-muted-foreground" />
					<Input
						id="roster-search"
						className="pl-8"
						placeholder="Nombre o correo"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
			</div>

			<InlineError error={roster.error} />

			{roster.isPending ? (
				<Skeleton className="h-64 w-full" />
			) : rows.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					No hay nadie que mostrar para ese día.
				</div>
			) : (
				<div className="rounded-xl border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="pl-4">Persona</TableHead>
								<TableHead>Estado</TableHead>
								<TableHead>Entrada</TableHead>
								<TableHead>Salida</TableHead>
								<TableHead className="pr-4 text-right">Trabajado</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<RosterRow key={`${row.userId}|${row.date}`} row={row} />
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}

function RosterRow({ row }: { row: DailyRosterEntry }) {
	return (
		<TableRow>
			<TableCell className="pl-4 whitespace-normal">
				<p className="font-medium">{row.userFullName}</p>
				{row.departmentName && (
					<p className="text-xs text-muted-foreground">{row.departmentName}</p>
				)}
			</TableCell>
			<TableCell>
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge variant={row.pending ? "outline" : STATUS_BADGE[row.status]}>
						{row.pending ? "En curso" : STATUS_LABEL[row.status]}
					</Badge>
					{row.isLate && (
						<span className="text-xs text-muted-foreground tabular-nums">
							{row.lateMinutes} min
						</span>
					)}
					{/*
					 * Spec 13: la clasificación de la ausencia, si el día es ausente.
					 * "Sin revisar" se distingue de "revisada como injustificada" porque
					 * en la nómina no son lo mismo (RN-13.10).
					 */}
					{row.absence && (
						<Badge
							variant={row.absence.code === "AJ" ? "secondary" : "destructive"}
						>
							{row.absence.code === "AJ"
								? "Justificada"
								: row.absence.reviewed
									? "No justificada"
									: "Sin clasificar"}
						</Badge>
					)}
					{row.open && (
						<span
							className="flex items-center gap-1 text-xs text-muted-foreground"
							title="Entró y todavía no ha salido"
						>
							<DoorOpen className="size-3.5" />
							dentro
						</span>
					)}
					{row.incomplete && !row.open && (
						<Badge variant="warning">Sin salida</Badge>
					)}
				</div>
			</TableCell>
			<TableCell className="tabular-nums">
				<span className="flex items-center gap-1.5">
					<LogIn className="size-3.5 text-muted-foreground" />
					{time(row.firstIn)}
				</span>
			</TableCell>
			<TableCell className="tabular-nums">
				<span className="flex items-center gap-1.5">
					<LogOut className="size-3.5 text-muted-foreground" />
					{time(row.lastOut)}
				</span>
			</TableCell>
			<TableCell className="pr-4 text-right tabular-nums">
				{row.workedMinutes === null
					? "—"
					: `${Math.floor(row.workedMinutes / 60)} h ${row.workedMinutes % 60} min`}
			</TableCell>
		</TableRow>
	);
}
