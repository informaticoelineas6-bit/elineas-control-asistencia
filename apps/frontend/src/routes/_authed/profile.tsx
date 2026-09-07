import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert, Info, Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import { PhoneInput } from "#/components/ui/phone-input.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { ROLE_LABELS } from "#/modules/auth/navigation.ts";
import { sessionQueryOptions } from "#/modules/auth/session.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";
import { MyLocationCard } from "#/modules/locations/my-location-card.tsx";
import { MyRestCard } from "#/modules/rest/my-rest-card.tsx";
import { MyScheduleCard } from "#/modules/schedules/my-schedule-card.tsx";
import {
	ownProfileQueryOptions,
	useUpdateOwnProfile,
} from "#/modules/users/api.ts";
import { MyVacationsCard } from "#/modules/vacations/my-vacations-card.tsx";

export const Route = createFileRoute("/_authed/profile")({
	component: OwnProfilePage,
});

/**
 * Perfil propio (spec 02 §7, `GET`/`PATCH /api/me`).
 *
 * Sin guard de rol: lo tiene cualquiera con sesión, y sólo sobre sí mismo — el
 * backend no acepta un id, así que no hay forma de pedir el de otro (RN-14.1 tiene
 * el mismo criterio para las notificaciones).
 *
 * Lo único editable es el teléfono. Nombre y correo son de la identidad y los
 * gobierna el Identity Server (RN-00.45); el sueldo no se muestra porque la matriz
 * de la spec 02 §2 no se lo concede a `employee` ni a `department_head`, y no se
 * hace una excepción por ser el suyo.
 */
function OwnProfilePage() {
	const profile = useQuery(ownProfileQueryOptions());
	const session = useQuery(sessionQueryOptions());
	const update = useUpdateOwnProfile();
	const [phone, setPhone] = useState<string | null>(null);

	const value = phone ?? profile.data?.phone ?? "";
	const dirty = phone !== null && phone !== (profile.data?.phone ?? "");

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		update.mutate(
			{ phone: value.trim() || null },
			{ onSuccess: () => setPhone(null) },
		);
	};

	if (profile.isPending) {
		return (
			<div className="max-w-2xl space-y-4">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	if (profile.error) {
		return <InlineError error={profile.error} className="max-w-2xl" />;
	}

	if (!profile.data) return null;

	return (
		<div className="max-w-5xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Mi perfil</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Tus datos en Control de Asistencia.
				</p>
			</div>

			{/*
			 * Dos columnas en pantallas anchas: a la izquierda lo que no se puede
			 * cambiar aquí —identidad y trabajo—, a la derecha lo que sí. En móvil se
			 * apilan en ese mismo orden.
			 */}
			<div className="grid gap-6 lg:grid-cols-2 lg:items-start">
				<div className="space-y-6">
					<section className="rounded-xl border p-4">
						<h2 className="text-sm font-medium text-muted-foreground">
							Identidad
						</h2>
						<dl className="mt-3 space-y-2 text-sm">
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">Nombre</dt>
								<dd className="text-right">{profile.data.fullName}</dd>
							</div>
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">Correo</dt>
								<dd className="truncate text-right">{profile.data.email}</dd>
							</div>
							{session.data && (
								<div className="flex justify-between gap-4">
									<dt className="text-muted-foreground">Rol</dt>
									<dd className="text-right">
										{ROLE_LABELS[session.data.effectiveRole]}
									</dd>
								</div>
							)}
						</dl>
						<p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
							<Info className="mt-0.5 size-3.5 shrink-0" />
							El nombre, el correo y el rol se gestionan en el Identity Server
							de Elineas. Para cambiarlos, habla con quien lo administra.
						</p>
					</section>

					<section className="rounded-xl border p-4">
						<h2 className="text-sm font-medium text-muted-foreground">
							Trabajo
						</h2>
						<dl className="mt-3 space-y-2 text-sm">
							<div className="flex items-center justify-between gap-4">
								<dt className="text-muted-foreground">Departamento</dt>
								<dd className="text-right">
									{profile.data.departmentName ?? (
										<Badge variant="warning">Sin asignar</Badge>
									)}
								</dd>
							</div>
							{profile.data.contractCancelledAt && (
								<div className="flex justify-between gap-4">
									<dt className="text-muted-foreground">Fin de contrato</dt>
									<dd className="text-right">
										{new Date(
											profile.data.contractCancelledAt,
										).toLocaleDateString("es-CU")}
									</dd>
								</div>
							)}
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">En el sistema desde</dt>
								<dd className="text-right">
									{new Date(profile.data.createdAt).toLocaleDateString("es-CU")}
								</dd>
							</div>
						</dl>
						{!profile.data.isComplete && (
							<p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
								<CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
								Sin departamento no puedes registrar asistencia. Un gestor tiene
								que asignártelo.
							</p>
						)}
					</section>

					{/*
					 * Spec 07 §5: el horario que le aplica y los días no laborables de su
					 * departamento. Es el único sitio donde un empleado los ve — el
					 * calendario del departamento pide ámbito de jefe, y éste sale de
					 * `/me/schedule`, que sólo devuelve lo suyo.
					 */}
					<MyScheduleCard />

					{/*
					 * Spec 10 §7 y spec 05 §3, que pone los descansos en el perfil. Va
					 * justo debajo del horario porque responden la misma pregunta en dos
					 * escalas: el horario dice a qué hora, los descansos qué días.
					 */}
					<MyRestCard />

					{/*
					 * Spec 11 §7: saldo de vacaciones y solicitud, en el mismo sitio que
					 * el resto de "lo mío" — así lo anticipaba ya la spec 05 §3.
					 */}
					<MyVacationsCard />

					{/*
					 * Spec 08 RN-08.7/RN-08.8: la sede contra la que se validan sus
					 * marcajes, con la comprobación en vivo al lado. Aquí y no en una
					 * pantalla aparte porque es un dato del perfil, y porque quien lo
					 * necesita cambiar lo busca donde están sus cosas.
					 */}
					<MyLocationCard />
				</div>

				<form onSubmit={onSubmit} className="space-y-4 rounded-xl border p-4">
					<h2 className="text-sm font-medium text-muted-foreground">
						Contacto
					</h2>

					<div className="space-y-2">
						<Label htmlFor="own-phone">Teléfono</Label>
						<PhoneInput
							id="own-phone"
							value={value}
							onChange={setPhone}
							placeholder="+53 5 1234567"
						/>
					</div>

					<InlineError error={update.error} />

					<div className="flex items-center gap-3">
						<Button type="submit" disabled={!dirty || update.isPending}>
							{update.isPending && <Loader2 className="animate-spin" />}
							Guardar
						</Button>
						{update.isSuccess && !dirty && (
							<span className="text-sm text-muted-foreground">Guardado.</span>
						)}
					</div>
				</form>
			</div>
		</div>
	);
}
