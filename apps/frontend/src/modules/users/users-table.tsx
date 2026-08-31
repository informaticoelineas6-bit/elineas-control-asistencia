import type { UserProfile } from "@elineas/validations";
import {
	BadgeDollarSign,
	Building2,
	Ellipsis,
	Pencil,
	Trash2,
	UserCheck,
	UserX,
} from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";

/**
 * Tabla de usuarios (spec 02). Acciones en desplegable por fila.
 *
 * No hay columna de sueldo: ese dato no viene en este listado y no puede venir
 * (spec 02 §6a). Se consulta abriendo su diálogo, que es el único que lo pide.
 */

export type UserAction =
	| "edit"
	| "responsibilities"
	| "compensation"
	| "deactivate"
	| "reactivate"
	| "delete";

export function UserStatusBadge({ user }: { user: UserProfile }) {
	if (!user.isActive) {
		return <Badge variant="outline">Desactivado</Badge>;
	}
	if (!user.isComplete) {
		return <Badge variant="warning">Sin departamento</Badge>;
	}
	return <Badge variant="secondary">Activo</Badge>;
}

function relativeDate(iso: string | null): string {
	if (!iso) return "nunca";

	const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
	if (days === 0) return "hoy";
	if (days === 1) return "ayer";
	if (days < 30) return `hace ${days} d`;
	return new Date(iso).toLocaleDateString("es-CU", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function UsersTable({
	users,
	onAction,
	canDelete,
	busyId,
}: {
	users: UserProfile[];
	onAction: (action: UserAction, user: UserProfile) => void;
	/** Sólo `superadmin` borra de verdad (RN-02.8). */
	canDelete: boolean;
	busyId: string | null;
}) {
	return (
		<div className="rounded-xl border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="pl-4">Persona</TableHead>
						<TableHead>Departamento</TableHead>
						<TableHead>Estado</TableHead>
						<TableHead>Última conexión</TableHead>
						<TableHead className="w-12 pr-4 text-right">Acciones</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{users.map((user) => (
						<TableRow key={user.id}>
							<TableCell className="max-w-xs pl-4 whitespace-normal">
								<p className="font-medium">{user.fullName}</p>
								<p className="truncate text-xs text-muted-foreground">
									{user.email}
								</p>
							</TableCell>

							<TableCell className="text-muted-foreground">
								{user.departmentName ?? "—"}
							</TableCell>

							<TableCell>
								<UserStatusBadge user={user} />
								{!user.isActive && user.deactivationReason && (
									<p className="mt-1 max-w-xs text-xs whitespace-normal text-muted-foreground">
										{user.deactivationReason}
									</p>
								)}
							</TableCell>

							<TableCell className="text-muted-foreground">
								{relativeDate(user.lastConnectionAt)}
							</TableCell>

							<TableCell className="pr-4 text-right">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={busyId === user.id}
											aria-label={`Acciones de ${user.fullName}`}
										>
											<Ellipsis />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-56">
										<DropdownMenuLabel className="truncate">
											{user.fullName}
										</DropdownMenuLabel>
										<DropdownMenuSeparator />

										<DropdownMenuItem onSelect={() => onAction("edit", user)}>
											<Pencil />
											Editar perfil
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() => onAction("responsibilities", user)}
										>
											<Building2 />
											Departamentos a cargo
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() => onAction("compensation", user)}
										>
											<BadgeDollarSign />
											Sueldo
										</DropdownMenuItem>

										<DropdownMenuSeparator />

										{user.isActive ? (
											<DropdownMenuItem
												onSelect={() => onAction("deactivate", user)}
											>
												<UserX />
												Desactivar
											</DropdownMenuItem>
										) : (
											<DropdownMenuItem
												onSelect={() => onAction("reactivate", user)}
											>
												<UserCheck />
												Reactivar
											</DropdownMenuItem>
										)}

										{canDelete && (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													variant="destructive"
													onSelect={() => onAction("delete", user)}
												>
													<Trash2 />
													Borrar perfil
												</DropdownMenuItem>
											</>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
