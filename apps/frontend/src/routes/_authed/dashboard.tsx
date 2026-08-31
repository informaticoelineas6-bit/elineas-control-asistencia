import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { NAV_SECTIONS, ROLE_LABELS } from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";

export const Route = createFileRoute("/_authed/dashboard")({
	component: DashboardPage,
});

/**
 * Panel de inicio.
 *
 * Mientras las specs de producto no estén implementadas, esta pantalla muestra
 * lo que la fundación de identidad resuelve: quién eres según el Identity
 * Server, qué rol efectivo sale de sus roles (RN-03.1) y qué ámbito te
 * corresponde (RN-03.2). Es lo que hace verificable el control de acceso.
 */
function DashboardPage() {
	const session = useQuery(sessionQueryOptions());
	if (!session.data) return null;

	const { user, profile, roles, effectiveRole, managedDepartmentIds } =
		session.data;

	const visible = NAV_SECTIONS.flatMap((section) =>
		section.items.filter((item) =>
			(item.roles as readonly string[]).includes(effectiveRole),
		),
	);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">
					Hola, {profile.fullName || user.email}
				</h1>
				<p className="mt-1 text-muted-foreground">
					Entraste como{" "}
					<span className="font-medium text-foreground">
						{ROLE_LABELS[effectiveRole]}
					</span>
					.
				</p>
			</div>

			{!profile.isComplete && (
				<div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
					<CircleAlert className="mt-0.5 size-5 text-amber-600" />
					<div className="text-sm">
						<p className="font-medium">
							Tu cuenta está pendiente de configurar
						</p>
						<p className="mt-1 text-muted-foreground">
							Todavía no tienes departamento asignado, así que no puedes
							registrar asistencia. Un gestor tiene que completarlo.
						</p>
					</div>
				</div>
			)}

			<section className="grid gap-4 sm:grid-cols-2">
				<div className="rounded-xl border p-4">
					<h2 className="text-sm font-medium text-muted-foreground">
						Identidad (Identity Server)
					</h2>
					<dl className="mt-3 space-y-2 text-sm">
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">Correo</dt>
							<dd className="truncate">{user.email}</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">Roles que devuelve</dt>
							<dd className="text-right">
								{roles.map((role) => ROLE_LABELS[role]).join(" · ")}
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">Rol efectivo</dt>
							<dd className="font-medium">{ROLE_LABELS[effectiveRole]}</dd>
						</div>
					</dl>
				</div>

				<div className="rounded-xl border p-4">
					<h2 className="text-sm font-medium text-muted-foreground">
						Perfil (este sistema)
					</h2>
					<dl className="mt-3 space-y-2 text-sm">
						{/*
						 * Un `superadmin` no pertenece a un departamento: su alcance es
						 * global por rol, así que la fila no se le muestra en vez de
						 * enseñarle un "sin asignar" que parece un error de configuración.
						 */}
						{effectiveRole !== "superadmin" && (
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">Departamento</dt>
								<dd className="truncate">
									{profile.departmentName ?? "sin asignar"}
								</dd>
							</div>
						)}
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">Ámbito gestionado</dt>
							<dd>
								{managedDepartmentIds.length
									? `${managedDepartmentIds.length} departamento(s)`
									: "—"}
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">Estado</dt>
							<dd>{profile.isActive ? "activo" : "desactivado"}</dd>
						</div>
					</dl>
				</div>
			</section>

			<section>
				<h2 className="text-sm font-medium text-muted-foreground">
					Secciones disponibles para tu rol
				</h2>
				<ul className="mt-3 flex flex-wrap gap-2">
					{visible.map((item) => (
						<li key={item.to}>
							<Link
								to={item.to}
								className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent/60"
							>
								<item.icon className="size-4" />
								{item.label}
							</Link>
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
