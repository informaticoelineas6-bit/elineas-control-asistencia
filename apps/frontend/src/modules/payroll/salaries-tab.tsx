import type { PayrollSalary } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Search } from "lucide-react";
import { useState } from "react";
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
import { Switch } from "#/components/ui/switch.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { useDebouncedValue } from "#/hooks/use-debounced-value.ts";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { salariesQueryOptions } from "#/modules/payroll/api.ts";
import { CompensationDialog } from "#/modules/users/user-dialogs.tsx";

const ALL = "__all__";

/**
 * Sueldos (spec 17 §5).
 *
 * **Ver todos a la vez es lo único que faltaba**: editar uno ya existía desde la
 * spec 02, en el diálogo de compensación, y esta pestaña lo reutiliza en vez de
 * escribir un segundo formulario contra el mismo endpoint.
 *
 * Lo que la vista de conjunto añade y el diálogo por persona no podía dar es el
 * caso de RN-17.7: **quien no tiene sueldo configurado no genera descuento**, y
 * sin una lista donde se vea el hueco eso sólo se descubre cuando una ausencia
 * injustificada no descuenta y nadie sabe por qué.
 */
export function SalariesTab() {
	const [search, setSearch] = useState("");
	const [departmentId, setDepartmentId] = useState(ALL);
	const [includeInactive, setIncludeInactive] = useState(false);
	const [editing, setEditing] = useState<PayrollSalary | null>(null);

	const debouncedSearch = useDebouncedValue(search);
	const salaries = useQuery(
		salariesQueryOptions({
			search: debouncedSearch,
			departmentId: departmentId === ALL ? undefined : departmentId,
			includeInactive,
		}),
	);
	const departments = useQuery(
		departmentsQueryOptions({ includePaused: true }),
	);

	const missing = (salaries.data ?? []).filter(
		(row) => row.monthlySalary === null,
	).length;

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="salary-search" className="text-xs">
						Buscar
					</Label>
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							id="salary-search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Nombre o correo"
							className="w-64 pl-8"
						/>
					</div>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="salary-department" className="text-xs">
						Departamento
					</Label>
					<Select value={departmentId} onValueChange={setDepartmentId}>
						<SelectTrigger id="salary-department" className="w-52">
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

				<div className="flex items-center gap-2 pb-2">
					<Switch
						id="salary-include-inactive"
						checked={includeInactive}
						onCheckedChange={setIncludeInactive}
					/>
					<Label
						htmlFor="salary-include-inactive"
						className="text-sm font-normal"
					>
						Mostrar desactivados
					</Label>
				</div>
			</div>

			<InlineError error={salaries.error} />

			{salaries.isPending ? (
				<Skeleton className="h-64 w-full" />
			) : (
				<>
					{missing > 0 && (
						<p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
							<strong>
								{missing === 1
									? "1 persona sin sueldo registrado"
									: `${missing} personas sin sueldo registrado`}
							</strong>
							. Una ausencia injustificada suya <strong>no descuenta</strong>{" "}
							(RN-17.7): el flujo no falla, pero tampoco aplica nada.
						</p>
					)}

					<div className="rounded-xl border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="pl-4">Persona</TableHead>
									<TableHead>Departamento</TableHead>
									<TableHead className="text-right">Sueldo mensual</TableHead>
									<TableHead>Actualizado</TableHead>
									<TableHead className="w-12 pr-4 text-right">
										Acciones
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{salaries.data?.map((row) => (
									<TableRow key={row.profileId}>
										<TableCell className="max-w-xs pl-4 whitespace-normal">
											<p className="font-medium">{row.fullName}</p>
											<p className="truncate text-xs text-muted-foreground">
												{row.email}
											</p>
										</TableCell>

										<TableCell className="text-muted-foreground">
											{row.departmentName ?? "—"}
										</TableCell>

										<TableCell className="text-right tabular-nums">
											{row.monthlySalary ? (
												<>
													<span className="font-medium">
														{row.monthlySalary}
													</span>{" "}
													<span className="text-muted-foreground">
														{row.currency}
													</span>
												</>
											) : (
												<span className="text-placeholder">Sin registrar</span>
											)}
										</TableCell>

										<TableCell className="text-muted-foreground">
											{row.updatedAt
												? new Date(row.updatedAt).toLocaleDateString("es-CU")
												: "—"}
										</TableCell>

										<TableCell className="pr-4 text-right">
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label={`Editar el sueldo de ${row.fullName}`}
												onClick={() => setEditing(row)}
											>
												<Pencil />
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</>
			)}

			{editing && (
				<CompensationDialog
					user={{ id: editing.profileId, fullName: editing.fullName }}
					onClose={() => setEditing(null)}
				/>
			)}
		</div>
	);
}
