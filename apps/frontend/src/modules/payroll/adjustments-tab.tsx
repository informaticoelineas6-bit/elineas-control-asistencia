import {
	PAYROLL_CATEGORY_LABELS,
	PAYROLL_STATUS_LABELS,
	type PayrollAdjustment,
} from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, Plus, Undo2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
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
import { formatShortDate } from "#/lib/dates.ts";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	AdjustmentDialog,
	RevertDialog,
} from "#/modules/payroll/adjustment-dialogs.tsx";
import {
	adjustmentsQueryOptions,
	payrollSummaryQueryOptions,
	useExportAdjustments,
} from "#/modules/payroll/api.ts";

const ALL = "__all__";

/** El mes en curso, que es la unidad en la que se trabaja la nómina (§7). */
function thisMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

/**
 * Historial de ajustes del periodo (spec 17 §5).
 *
 * **Los totales van arriba y por moneda.** Es el criterio de aceptación de la
 * §8 —que cuadren con la suma de los ajustes activos— puesto donde se puede
 * comprobar de un vistazo, y separado por moneda porque en la misma plantilla se
 * cobra en varias (spec 02 §6a): un único número sería la suma de peras y
 * manzanas.
 *
 * Un ajuste **revertido sigue en la lista**, atenuado. RN-17.4 lo conserva a
 * propósito y esconderlo aquí sería contarlo a medias: el historial económico es
 * inmutable justamente para poder leerlo.
 */
export function AdjustmentsTab() {
	const [period, setPeriod] = useState(thisMonth);
	const [departmentId, setDepartmentId] = useState(ALL);
	const [status, setStatus] = useState(ALL);
	const [category, setCategory] = useState(ALL);
	const [creating, setCreating] = useState(false);
	const [reverting, setReverting] = useState<PayrollAdjustment | null>(null);

	const filters = {
		period,
		departmentId: departmentId === ALL ? undefined : departmentId,
		status: status === ALL ? undefined : (status as "active" | "reverted"),
		category:
			category === ALL
				? undefined
				: (category as keyof typeof PAYROLL_CATEGORY_LABELS),
	};

	const adjustments = useQuery(adjustmentsQueryOptions(filters));
	const summary = useQuery(
		payrollSummaryQueryOptions({
			period,
			departmentId: filters.departmentId,
		}),
	);
	const departments = useQuery(
		departmentsQueryOptions({ includePaused: true }),
	);
	const exportXlsx = useExportAdjustments();

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="payroll-period" className="text-xs">
						Periodo
					</Label>
					<Input
						id="payroll-period"
						type="month"
						value={period}
						onChange={(event) => setPeriod(event.target.value)}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="payroll-department" className="text-xs">
						Departamento
					</Label>
					<Select value={departmentId} onValueChange={setDepartmentId}>
						<SelectTrigger id="payroll-department" className="w-52">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>Toda la empresa</SelectItem>
							{(departments.data ?? []).map((department) => (
								<SelectItem key={department.id} value={department.id}>
									{department.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="payroll-status" className="text-xs">
						Estado
					</Label>
					<Select value={status} onValueChange={setStatus}>
						<SelectTrigger id="payroll-status" className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>Todos</SelectItem>
							<SelectItem value="active">Activos</SelectItem>
							<SelectItem value="reverted">Revertidos</SelectItem>
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="payroll-category" className="text-xs">
						Categoría
					</Label>
					<Select value={category} onValueChange={setCategory}>
						<SelectTrigger id="payroll-category" className="w-52">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>Todas</SelectItem>
							{Object.entries(PAYROLL_CATEGORY_LABELS).map(([key, label]) => (
								<SelectItem key={key} value={key}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="ml-auto flex gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={exportXlsx.isPending}
						onClick={() => exportXlsx.mutate(filters)}
					>
						{exportXlsx.isPending ? (
							<Loader2 className="animate-spin" />
						) : (
							<Download />
						)}
						Exportar
					</Button>
					<Button type="button" onClick={() => setCreating(true)}>
						<Plus />
						Nuevo ajuste
					</Button>
				</div>
			</div>

			<InlineError error={adjustments.error ?? exportXlsx.error} />

			{summary.data && summary.data.totals.length > 0 && (
				<dl className="grid gap-3 sm:grid-cols-3">
					{summary.data.totals.map((total) => (
						<div key={total.currency} className="rounded-xl border p-4">
							<dt className="text-xs text-muted-foreground">
								Total activo en {total.currency}
							</dt>
							<dd className="mt-1 text-2xl font-semibold tabular-nums">
								{total.total}
							</dd>
							<dd className="text-xs text-muted-foreground">
								{total.count === 1 ? "1 ajuste" : `${total.count} ajustes`}
							</dd>
						</div>
					))}
				</dl>
			)}

			{adjustments.isPending ? (
				<Skeleton className="h-64 w-full" />
			) : (adjustments.data?.length ?? 0) === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					No hay ajustes en ese periodo.
				</div>
			) : (
				<div className="rounded-xl border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="pl-4">Persona</TableHead>
								<TableHead>Categoría</TableHead>
								<TableHead className="text-right">Importe</TableHead>
								<TableHead>Estado</TableHead>
								<TableHead>Origen</TableHead>
								<TableHead>Registrado</TableHead>
								<TableHead className="w-12 pr-4 text-right">Acciones</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{adjustments.data?.map((row) => (
								<TableRow
									key={row.id}
									className={row.status === "reverted" ? "opacity-60" : ""}
								>
									<TableCell className="max-w-xs pl-4 whitespace-normal">
										<p className="font-medium">{row.userFullName}</p>
										<p className="truncate text-xs text-muted-foreground">
											{row.departmentName ?? "Sin departamento"}
										</p>
									</TableCell>

									<TableCell className="max-w-xs whitespace-normal">
										{PAYROLL_CATEGORY_LABELS[row.category]}
										{row.description && (
											<p className="text-xs text-muted-foreground">
												{row.description}
											</p>
										)}
									</TableCell>

									<TableCell className="text-right font-medium tabular-nums">
										{row.amount} {row.currency}
									</TableCell>

									<TableCell>
										<Badge
											variant={
												row.status === "active" ? "secondary" : "outline"
											}
										>
											{PAYROLL_STATUS_LABELS[row.status]}
										</Badge>
										{row.status === "reverted" && row.revertReason && (
											<p className="mt-1 max-w-xs text-xs whitespace-normal text-muted-foreground">
												{row.revertReason}
											</p>
										)}
									</TableCell>

									<TableCell className="text-muted-foreground">
										{row.sourceType === "absence_review"
											? "Ausencia"
											: "Manual"}
									</TableCell>

									<TableCell className="text-muted-foreground">
										{formatShortDate(row.createdAt.slice(0, 10))}
										{row.createdByName && (
											<p className="truncate text-xs">{row.createdByName}</p>
										)}
									</TableCell>

									<TableCell className="pr-4 text-right">
										{row.status === "active" && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => setReverting(row)}
											>
												<Undo2 />
												Revertir
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			{creating && <AdjustmentDialog onClose={() => setCreating(false)} />}
			{reverting && (
				<RevertDialog
					adjustment={reverting}
					onClose={() => setReverting(null)}
				/>
			)}
		</div>
	);
}
