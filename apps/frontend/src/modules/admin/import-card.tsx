import type { AttendanceImportReport } from "@elineas/validations";
import {
	CheckCircle2,
	FileUp,
	Loader2,
	TriangleAlert,
	Upload,
} from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { formatShortDate } from "#/lib/dates.ts";
import { useCommitImport, useValidateImport } from "#/modules/admin/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

/**
 * Importación de histórico (spec 19 §2.4).
 *
 * **Son dos pasos y no uno, porque RN-19.2 lo exige**: primero el informe —filas
 * válidas, filas con error y su motivo— y sólo después la escritura. La regla lo
 * dice con las palabras que importan: *nunca importación parcial silenciosa*. Así
 * que aquí no hay un botón de "importar" hasta que se ha visto el informe.
 *
 * El archivo se sube **dos veces**, una por paso, y es a propósito: subirlo otra
 * vez cuesta un segundo y garantiza que lo que se escribe es exactamente lo que
 * se validó. Guardar el archivo en el servidor entre los dos pasos significaría
 * un almacén temporal de datos de asistencia que hay que limpiar, vigilar y
 * explicar.
 */
export function ImportCard() {
	const [file, setFile] = useState<File | null>(null);
	const validate = useValidateImport();
	const commit = useCommitImport();

	const report = commit.data ?? validate.data;
	const canCommit = validate.data !== undefined && validate.data.valid > 0;

	const pick = (next: File | null) => {
		setFile(next);
		// Un archivo nuevo invalida el informe anterior: lo que se escriba tiene que
		// ser lo que se acaba de ver.
		validate.reset();
		commit.reset();
	};

	return (
		<section className="space-y-4 rounded-xl border p-5">
			<div>
				<h2 className="flex items-center gap-2 font-medium">
					<FileUp className="size-4" />
					Importar histórico de asistencia
				</h2>
				<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
					Cuatro columnas, en este orden: <strong>correo</strong>,{" "}
					<strong>fecha</strong>, <strong>hora</strong> y <strong>tipo</strong>{" "}
					(entrada o salida). La primera fila es la cabecera y se ignora. Los
					marcajes entran marcados como importados y{" "}
					<strong>sin coordenadas</strong>: no son evidencia de ubicación.
				</p>
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="import-file" className="text-xs">
						Archivo .xlsx
					</Label>
					<Input
						id="import-file"
						type="file"
						accept=".xlsx"
						className="w-80"
						onChange={(event) => pick(event.target.files?.[0] ?? null)}
					/>
				</div>

				<Button
					type="button"
					variant="outline"
					disabled={!file || validate.isPending}
					onClick={() => file && validate.mutate(file)}
				>
					{validate.isPending ? (
						<Loader2 className="animate-spin" />
					) : (
						<Upload />
					)}
					Revisar archivo
				</Button>

				<Button
					type="button"
					disabled={!file || !canCommit || commit.isPending}
					title={
						canCommit ? undefined : "Revisa el archivo antes de importarlo"
					}
					onClick={() => file && commit.mutate(file)}
				>
					{commit.isPending && <Loader2 className="animate-spin" />}
					Importar {validate.data ? `${validate.data.valid} filas` : ""}
				</Button>
			</div>

			<InlineError error={validate.error ?? commit.error} />

			{commit.data && (
				<p className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
					<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
					<span>
						Importadas <strong>{commit.data.inserted}</strong> filas.{" "}
						{commit.data.alreadyPresent > 0 &&
							`${commit.data.alreadyPresent} ya estaban y no se duplicaron. `}
						Se recalcularon {commit.data.factsRefreshed} días de asistencia.
					</span>
				</p>
			)}

			{report && <ImportReport report={report} />}
		</section>
	);
}

function ImportReport({ report }: { report: AttendanceImportReport }) {
	return (
		<div className="space-y-3">
			<dl className="grid gap-3 sm:grid-cols-4">
				<Figure label="Filas" value={report.rows} />
				<Figure label="Válidas" value={report.valid} />
				<Figure label="Ya presentes" value={report.alreadyPresent} />
				<Figure label="Personas" value={report.people} />
			</dl>

			{report.from && report.to && (
				<p className="text-sm text-muted-foreground">
					Rango: {formatShortDate(report.from)} — {formatShortDate(report.to)}.
				</p>
			)}

			{report.issues.length > 0 && (
				<div className="space-y-2">
					<p className="flex items-center gap-2 text-sm font-medium">
						<TriangleAlert className="size-4 text-amber-600" />
						{report.issues.length === 1
							? "1 fila con problema"
							: `${report.issues.length} filas con problema`}
						<span className="font-normal text-muted-foreground">
							— no se importan, el resto sí
						</span>
					</p>
					<ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
						{report.issues.map((issue) => (
							<li key={`${issue.row}-${issue.message}`}>
								<span className="text-muted-foreground">Fila {issue.row}:</span>{" "}
								{issue.message}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function Figure({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-xl border p-4">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
		</div>
	);
}
