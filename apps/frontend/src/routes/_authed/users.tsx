import type { UserProfile } from "@elineas/validations";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Info, Search, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useDebouncedValue } from "#/hooks/use-debounced-value.ts";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { departmentsQueryOptions } from "#/modules/departments/api.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import {
	identityConsoleUrl,
	incompleteUsersQueryOptions,
	useReactivateUser,
	usersQueryOptions,
} from "#/modules/users/api.ts";
import {
	CompensationDialog,
	DeactivateUserDialog,
	DeleteUserDialog,
	EditUserDialog,
	ResponsibilitiesDialog,
} from "#/modules/users/user-dialogs.tsx";
import { type UserAction, UsersTable } from "#/modules/users/users-table.tsx";

const PATH = "/users" as const;

export const Route = createFileRoute("/_authed/users")({
	component: () => (
		<RequireRole path={PATH}>
			<UsersPage />
		</RequireRole>
	),
});

type OpenDialog =
	| { kind: "edit"; user: UserProfile }
	| { kind: "responsibilities"; user: UserProfile }
	| { kind: "compensation"; user: UserProfile }
	| { kind: "deactivate"; user: UserProfile }
	| { kind: "delete"; user: UserProfile }
	| null;

/**
 * Gestión de usuarios (spec 02).
 *
 * La pantalla asume el **alta en dos pasos** y lo explica en vez de esconderlo
 * (RN-02.10): no hay botón de "crear usuario" porque esta aplicación no puede
 * crear cuentas — eso es del Identity Server. Lo que sí hace es el paso 2, y
 * destaca a quien se quedó a medias entre ambos (RN-02.3).
 */
function UsersPage() {
	const session = useQuery(sessionQueryOptions());
	const [search, setSearch] = useState("");
	const [includeInactive, setIncludeInactive] = useState(false);
	const [dialog, setDialog] = useState<OpenDialog>(null);
	const [actionError, setActionError] = useState<Error | null>(null);

	// El campo responde al instante; la consulta espera a que se deje de teclear.
	const debouncedSearch = useDebouncedValue(search);
	const users = useQuery(
		usersQueryOptions({ search: debouncedSearch, includeInactive }),
	);
	const incomplete = useQuery(incompleteUsersQueryOptions());
	const departments = useQuery(
		departmentsQueryOptions({ includePaused: true }),
	);
	const reactivate = useReactivateUser();

	const isSuperadmin = session.data?.effectiveRole === "superadmin";
	const busyId = reactivate.isPending
		? (reactivate.variables?.id ?? null)
		: null;

	const onAction = (action: UserAction, user: UserProfile) => {
		setActionError(null);

		if (action === "reactivate") {
			reactivate.mutate({ id: user.id }, { onError: setActionError });
			return;
		}
		setDialog({ kind: action, user });
	};

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Usuarios</h1>
				<p className="mt-1 max-w-3xl text-sm text-muted-foreground">
					Aquí se gestiona el <strong>perfil de negocio</strong>: departamento,
					contacto, sueldo y estado de la cuenta en Control de Asistencia.
				</p>
			</div>

			{/* RN-02.10: el alta de cuentas no está aquí y hay que decirlo. */}
			<div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
				<Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
				<div className="space-y-2 text-sm">
					<p className="font-medium">
						Las cuentas se crean en el Identity Server, no aquí
					</p>
					<p className="text-muted-foreground">
						Primero se crea la cuenta y se le asigna un rol en{" "}
						<span className="font-medium text-foreground">
							control-asistencia
						</span>{" "}
						— sin rol no puede ni entrar. Cuando la persona entra por primera
						vez, aparece en esta lista sin departamento y sólo queda
						asignárselo.
					</p>
					{identityConsoleUrl && (
						<Button variant="outline" size="sm" asChild>
							<a
								href={identityConsoleUrl}
								target="_blank"
								rel="noreferrer noopener"
							>
								<ExternalLink />
								Abrir la consola del Identity Server
							</a>
						</Button>
					)}
				</div>
			</div>

			{/* RN-02.3: los que se quedaron a medias, a la vista y no enterrados en la lista. */}
			{incomplete.data && incomplete.data.length > 0 && (
				<div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
					<div className="flex items-start gap-3">
						<UserPlus className="mt-0.5 size-5 shrink-0 text-amber-600" />
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium">
								{incomplete.data.length === 1
									? "Hay 1 cuenta pendiente de configurar"
									: `Hay ${incomplete.data.length} cuentas pendientes de configurar`}
							</p>
							<p className="mt-1 text-sm text-muted-foreground">
								Entraron pero no tienen departamento, así que no pueden
								registrar asistencia.
							</p>
							<ul className="mt-3 space-y-2">
								{incomplete.data.map((user) => (
									<li
										key={user.id}
										className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2 pl-3"
									>
										<div className="min-w-0">
											<span className="text-sm font-medium">
												{user.fullName}
											</span>
											<span className="ml-2 text-xs text-muted-foreground">
												{user.email}
											</span>
										</div>
										<Button
											size="sm"
											variant="outline"
											onClick={() => setDialog({ kind: "edit", user })}
										>
											Asignar departamento
										</Button>
									</li>
								))}
							</ul>
						</div>
					</div>
				</div>
			)}

			<InlineError error={actionError} />

			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="w-full max-w-xs space-y-2">
					<Label htmlFor="user-search">Buscar</Label>
					<div className="relative">
						<Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							id="user-search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Nombre o correo"
							className="pl-8"
						/>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<Switch
						id="include-inactive"
						checked={includeInactive}
						onCheckedChange={setIncludeInactive}
					/>
					<Label htmlFor="include-inactive" className="text-sm font-normal">
						Mostrar desactivados
					</Label>
				</div>
			</div>

			{users.isPending && (
				<div className="space-y-2">
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
				</div>
			)}

			<InlineError error={users.error} />

			{users.data?.length === 0 && (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/30 p-12 text-center">
					<Users className="size-8 text-placeholder" />
					<div>
						<h2 className="font-medium">
							{search
								? "Nadie coincide con la búsqueda"
								: "Todavía no hay nadie"}
						</h2>
						<p className="mt-1 max-w-sm text-sm text-muted-foreground">
							{debouncedSearch
								? "Prueba con otro nombre o correo."
								: "Los perfiles aparecen cuando cada persona entra por primera vez con su cuenta del Identity Server."}
						</p>
					</div>
				</div>
			)}

			{users.data && users.data.length > 0 && (
				<>
					<UsersTable
						users={users.data}
						onAction={onAction}
						canDelete={isSuperadmin}
						busyId={busyId}
					/>
					<p className="text-xs text-muted-foreground">
						{users.data.length}{" "}
						{users.data.length === 1 ? "persona" : "personas"}
						{!includeInactive && (
							<>
								{" "}
								· <Badge variant="outline">desactivados ocultos</Badge>
							</>
						)}
					</p>
				</>
			)}

			{/*
			 * El `key` ata cada diálogo a la persona que está editando. Sin él, dos
			 * aperturas seguidas pueden reutilizar la misma instancia de React y el
			 * formulario arranca con el estado de la anterior — el teléfono de otro, o
			 * el que se escribió y no se guardó.
			 */}
			{dialog?.kind === "edit" && (
				<EditUserDialog
					key={dialog.user.id}
					user={dialog.user}
					departments={departments.data ?? []}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "responsibilities" && (
				<ResponsibilitiesDialog
					key={dialog.user.id}
					user={dialog.user}
					departments={departments.data ?? []}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "compensation" && (
				<CompensationDialog
					key={dialog.user.id}
					user={dialog.user}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "deactivate" && (
				<DeactivateUserDialog
					key={dialog.user.id}
					user={dialog.user}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "delete" && (
				<DeleteUserDialog
					key={dialog.user.id}
					user={dialog.user}
					onClose={() => setDialog(null)}
				/>
			)}
		</div>
	);
}
