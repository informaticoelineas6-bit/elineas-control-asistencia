import {
	AUDIT_ACTIONS,
	AUDIT_DOMAIN_LABELS,
	type AuditLogEntry,
	auditActionLabel,
	auditDomainOf,
} from "@elineas/validations";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, ScrollText, X } from "lucide-react";
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
import {
	type AuditFilters,
	auditPagesQueryOptions,
} from "#/modules/audit/api.ts";
import { AuditEntryDialog } from "#/modules/audit/entry-dialog.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { usersQueryOptions } from "#/modules/users/api.ts";

const PATH = "/logs" as const;

export const Route = createFileRoute("/_authed/logs")({
	component: () => (
		<RequireRole path={PATH}>
			<LogsPage />
		</RequireRole>
	),
});

const ALL = "__all__";

const DOMAINS = [...new Set(AUDIT_ACTIONS.map(auditDomainOf))].sort((a, b) =>
	(AUDIT_DOMAIN_LABELS[a] ?? a).localeCompare(
		AUDIT_DOMAIN_LABELS[b] ?? b,
		"es",
	),
);

/**
 * Bitácora de auditoría (spec 18 §7). Sólo `superadmin` (RN-18.5).
 *
 * Responde la pregunta con la que abre esa spec —*"¿por qué a este empleado le
 * descontaron en marzo?"*, seis meses después— y por eso los filtros no son
 * decorativos: sin acotar por dominio, por persona y por fecha, una tabla que
 * sólo crece no se puede leer.
 *
 * **No hay ni un botón que escriba.** La bitácora es inmutable (RN-18.6) y la
 * API no ofrece con qué; que esta pantalla sea sólo de lectura no es una
 * simplificación, es la regla.
 *
 * Dos filtros no tienen control propio y se llegan desde el detalle de una
 * entrada, porque nadie teclea un uuid a mano: **el registro** —"¿qué más le ha
 * pasado a esto?", §7— y **la cadena** —"¿qué más pasó en esta misma acción?",
 * RN-18.8—. Aparecen como una etiqueta que se quita.
 */
function LogsPage() {
	const [domain, setDomain] = useState(ALL);
	const [action, setAction] = useState(ALL);
	const [actorId, setActorId] = useState(ALL);
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [resource, setResource] = useState<{
		tableName: string;
		recordId: string;
	} | null>(null);
	const [correlationId, setCorrelationId] = useState<string | null>(null);
	const [opened, setOpened] = useState<AuditLogEntry | null>(null);

	const filters: AuditFilters = {
		domain: domain === ALL ? undefined : domain,
		action: action === ALL ? undefined : action,
		actorId: actorId === ALL ? undefined : actorId,
		from: from || undefined,
		to: to || undefined,
		tableName: resource?.tableName,
		recordId: resource?.recordId,
		correlationId: correlationId ?? undefined,
	};

	const pages = useInfiniteQuery(auditPagesQueryOptions(filters));
	// Un superadmin alcanza a todo el mundo; los inactivos también actuaron.
	const people = useQuery(usersQueryOptions({ includeInactive: true }));

	const entries = pages.data?.pages.flatMap((page) => page.entries) ?? [];
	const actions = AUDIT_ACTIONS.filter(
		(candidate) => domain === ALL || auditDomainOf(candidate) === domain,
	);

	return (
		<div className="max-w-6xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Bitácora</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Quién hizo qué, cuándo y sobre qué. Es lo que permite responder «¿por
					qué a esta persona le descontaron en marzo?» seis meses después. No se
					puede modificar ni borrar.
				</p>
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor="audit-domain" className="text-xs">
						Dominio
					</Label>
					<Select
						value={domain}
						onValueChange={(next) => {
							setDomain(next);
							// La acción elegida puede no pertenecer al dominio nuevo: dejarla
							// puesta daría una lista vacía sin decir por qué.
							setAction(ALL);
						}}
					>
						<SelectTrigger id="audit-domain" className="w-52">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>Todos</SelectItem>
							{DOMAINS.map((option) => (
								<SelectItem key={option} value={option}>
									{AUDIT_DOMAIN_LABELS[option] ?? option}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="audit-action" className="text-xs">
						Acción
					</Label>
					<Select value={action} onValueChange={setAction}>
						<SelectTrigger id="audit-action" className="w-60">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>Todas</SelectItem>
							{actions.map((option) => (
								<SelectItem key={option} value={option}>
									{auditActionLabel(option)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="audit-actor" className="text-xs">
						Quién
					</Label>
					<Select value={actorId} onValueChange={setActorId}>
						<SelectTrigger id="audit-actor" className="w-56">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>Cualquiera</SelectItem>
							{(people.data ?? []).map((person) => (
								<SelectItem key={person.id} value={person.id}>
									{person.fullName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="audit-from" className="text-xs">
						Desde
					</Label>
					<Input
						id="audit-from"
						type="date"
						max={to || undefined}
						value={from}
						onChange={(event) => setFrom(event.target.value)}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="audit-to" className="text-xs">
						Hasta
					</Label>
					<Input
						id="audit-to"
						type="date"
						min={from || undefined}
						value={to}
						onChange={(event) => setTo(event.target.value)}
					/>
				</div>
			</div>

			{(resource || correlationId) && (
				<div className="flex flex-wrap items-center gap-2">
					{resource && (
						<Badge variant="secondary" className="gap-1.5 font-normal">
							Registro {resource.tableName} · {resource.recordId.slice(0, 8)}
							<button
								type="button"
								aria-label="Quitar el filtro de registro"
								onClick={() => setResource(null)}
							>
								<X className="size-3" />
							</button>
						</Badge>
					)}
					{correlationId && (
						<Badge variant="secondary" className="gap-1.5 font-normal">
							Cadena {correlationId.slice(0, 8)}
							<button
								type="button"
								aria-label="Quitar el filtro de cadena"
								onClick={() => setCorrelationId(null)}
							>
								<X className="size-3" />
							</button>
						</Badge>
					)}
				</div>
			)}

			<InlineError error={pages.error} />

			{pages.isPending ? (
				<Skeleton className="h-72 w-full" />
			) : entries.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border/70 bg-muted/30 p-8 text-center text-sm text-muted-foreground">
					No hay entradas con esos filtros.
				</div>
			) : (
				<>
					<div className="rounded-xl border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="pl-4">Cuándo</TableHead>
									<TableHead>Quién</TableHead>
									<TableHead>Qué</TableHead>
									<TableHead>Sobre qué</TableHead>
									<TableHead className="w-24 pr-4 text-right">
										Detalle
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{entries.map((entry) => (
									<TableRow key={entry.id}>
										<TableCell className="pl-4 text-muted-foreground tabular-nums">
											{new Date(entry.createdAt).toLocaleString("es-CU")}
										</TableCell>

										<TableCell className="max-w-[14rem] whitespace-normal">
											{entry.actorName ? (
												<p className="font-medium">{entry.actorName}</p>
											) : (
												// Dos nulos distintos: el sistema no es una persona,
												// y un perfil borrado sí lo fue (RN-18.6).
												<p className="text-muted-foreground">
													{entry.actorId ? "Perfil eliminado" : "El sistema"}
												</p>
											)}
											{entry.actorEmail && (
												<p className="truncate text-xs text-muted-foreground">
													{entry.actorEmail}
												</p>
											)}
										</TableCell>

										<TableCell className="max-w-xs whitespace-normal">
											{auditActionLabel(entry.action)}
										</TableCell>

										<TableCell className="text-muted-foreground">
											<p>{entry.tableName}</p>
											{entry.recordId && (
												<p className="truncate text-xs">
													{entry.recordId.slice(0, 8)}
												</p>
											)}
										</TableCell>

										<TableCell className="pr-4 text-right">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => setOpened(entry)}
											>
												<ScrollText />
												Ver
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>

					<div className="flex items-center gap-3">
						{pages.hasNextPage && (
							<Button
								type="button"
								variant="outline"
								disabled={pages.isFetchingNextPage}
								onClick={() => void pages.fetchNextPage()}
							>
								{pages.isFetchingNextPage && (
									<Loader2 className="animate-spin" />
								)}
								Cargar más
							</Button>
						)}
						<p className="text-xs text-muted-foreground">
							{entries.length} {entries.length === 1 ? "entrada" : "entradas"}
							{pages.hasNextPage && " (hay más)"}
						</p>
					</div>
				</>
			)}

			{opened && (
				<AuditEntryDialog
					entry={opened}
					onClose={() => setOpened(null)}
					onFilterResource={(tableName, recordId) => {
						setResource({ tableName, recordId });
						setCorrelationId(null);
					}}
					onFilterChain={(id) => {
						setCorrelationId(id);
						setResource(null);
					}}
				/>
			)}
		</div>
	);
}
