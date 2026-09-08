import {
	type AuditLogEntry,
	auditActionLabel,
	auditDiff,
} from "@elineas/validations";
import { ArrowRight, Link2, ListTree } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog.tsx";

/** `null` y `undefined` se leen igual de mal; un vacío explícito, no. */
function show(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value === "" ? "(vacío)" : value;
	return JSON.stringify(value);
}

/**
 * Detalle de una entrada, con **la diferencia campo a campo** que pide la §7.
 *
 * La spec dice por qué no basta con volcar los dos JSON: *"leer dos bloques de
 * JSON crudo no sirve"*. Una entrada de `config.updated` trae el catálogo entero
 * dentro y comparar a ojo quince claves para encontrar la que cambió es
 * exactamente el trabajo que alguien viene a evitar aquí. La comparación la hace
 * `auditDiff`, que vive en `@elineas/validations` con sus pruebas.
 *
 * Los dos botones del pie son las dos preguntas que se hacen desde una entrada:
 * *"¿qué más le ha pasado a este registro?"* (§7) y *"¿qué más pasó en esta misma
 * acción?"* (RN-18.8, la cadena en cascada).
 */
export function AuditEntryDialog({
	entry,
	onClose,
	onFilterResource,
	onFilterChain,
}: {
	entry: AuditLogEntry;
	onClose: () => void;
	onFilterResource: (tableName: string, recordId: string) => void;
	onFilterChain: (correlationId: string) => void;
}) {
	const changes = auditDiff(entry.oldData, entry.newData);
	const correlationId = entry.metadata?.correlationId;
	const rest = Object.entries(entry.metadata ?? {}).filter(
		([key]) => key !== "correlationId",
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{auditActionLabel(entry.action)}</DialogTitle>
					<DialogDescription>
						{new Date(entry.createdAt).toLocaleString("es-CU")} ·{" "}
						{entry.actorName ??
							(entry.actorId ? "Perfil eliminado" : "El sistema")}
						{entry.sourceIp && ` · ${entry.sourceIp}`}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-1 text-sm">
					<p className="text-muted-foreground">
						{entry.tableName}
						{entry.recordId && ` · ${entry.recordId}`}
					</p>
				</div>

				{changes.length === 0 ? (
					<p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
						Esta entrada no registra cambios de campos: la acción es el hecho.
					</p>
				) : (
					<ul className="divide-y rounded-xl border">
						{changes.map((change) => (
							<li
								key={change.field}
								className="grid gap-1 p-3 text-sm sm:grid-cols-[10rem_1fr]"
							>
								<span className="font-medium break-all">
									{change.field || "valor"}
								</span>
								<span className="flex flex-wrap items-center gap-2">
									<span className="break-all text-muted-foreground line-through decoration-rose-500/60">
										{show(change.before)}
									</span>
									<ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="break-all font-medium">
										{show(change.after)}
									</span>
								</span>
							</li>
						))}
					</ul>
				)}

				{rest.length > 0 && (
					<div className="space-y-1.5">
						<p className="text-xs text-muted-foreground">Contexto</p>
						<div className="flex flex-wrap gap-1.5">
							{rest.map(([key, value]) => (
								<Badge key={key} variant="outline" className="font-normal">
									{key}: {show(value)}
								</Badge>
							))}
						</div>
					</div>
				)}

				<DialogFooter className="sm:justify-start">
					{entry.recordId && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								onFilterResource(entry.tableName, entry.recordId ?? "");
								onClose();
							}}
						>
							<ListTree />
							Historial de este registro
						</Button>
					)}
					{typeof correlationId === "string" && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								onFilterChain(correlationId);
								onClose();
							}}
						>
							<Link2 />
							Ver la cadena completa
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
