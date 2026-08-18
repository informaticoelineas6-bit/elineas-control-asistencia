import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { useLogin } from "#/modules/auth/session.ts";
import { InlineError } from "#/modules/errors/inline-error.tsx";

export const Route = createFileRoute("/login")({ component: LoginPage });

/**
 * Vista de inicio de sesión.
 *
 * Manda las credenciales a NUESTRO backend, nunca al Identity Server
 * (RN-00.35). No hay enlace de "crear cuenta": el alta es exclusivamente del IS
 * y esta aplicación no expone ninguna forma de crear cuentas (RN-00.28, §C.7).
 */
function LoginPage() {
	const navigate = useNavigate();
	const login = useLogin();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		login.mutate(
			{ email, password },
			{
				onSuccess: (session) => {
					// Perfil sin departamento: entra, pero a la pantalla de cuenta
					// pendiente, no al panel (RN-00.46 / RN-02.3).
					void navigate({
						to: session.profile.isComplete ? "/dashboard" : "/pending-account",
					});
				},
			},
		);
	};

	return (
		<main className="relative isolate flex min-h-svh items-center justify-center overflow-hidden p-6">
			<LoginBackground />

			<div className="w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-3 text-center">
					<div className="flex size-11 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/25 backdrop-blur">
						<Clock className="size-5" />
					</div>
					<div>
						<h1 className="text-xl font-semibold text-white">
							Control de Asistencia
						</h1>
						<p className="text-sm text-white/70">
							Entra con tu cuenta de Elineas
						</p>
					</div>
				</div>

				<form
					onSubmit={onSubmit}
					className="space-y-4 rounded-xl border bg-background/95 p-6 shadow-2xl backdrop-blur-sm"
				>
					<div className="space-y-2">
						<Label htmlFor="email">Correo</Label>
						<Input
							id="email"
							type="email"
							autoComplete="username"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="nombre@mercadoelineas.com"
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="password">Contraseña</Label>
						<Input
							id="password"
							type="password"
							autoComplete="current-password"
							required
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</div>

					<InlineError error={login.error} />

					<Button type="submit" className="w-full" disabled={login.isPending}>
						{login.isPending ? "Entrando…" : "Entrar"}
					</Button>
				</form>

				<p className="mt-6 text-center text-xs text-white/60">
					¿Olvidaste tu contraseña o necesitas una cuenta? Las gestiona el
					equipo de sistemas de Elineas: esta aplicación no crea cuentas ni
					guarda contraseñas.
				</p>
			</div>
		</main>
	);
}

/**
 * Fondo del login: degradado en capas, siempre oscuro (no sigue el tema).
 *
 * Las capas se apilan de fondo a frente — base, tinte difuminado, luces
 * radiales, viñeta y grano en `soft-light` — con `zIndex` explícito, porque van
 * dentro de un contenedor `isolate` y el orden de composición es lo que hace
 * legible el formulario que va encima.
 */
function LoginBackground() {
	return (
		<div className="pointer-events-none absolute inset-0" aria-hidden="true">
			<div
				className="absolute inset-0"
				style={{
					zIndex: -5,
					background:
						"linear-gradient(193deg, #ecebed 0%, #b4a7c5 17%, #7154a7 34%, #372f4c 58%, #141318 76%, #030303 100%)",
				}}
			/>
			<div
				className="absolute inset-0"
				style={{
					zIndex: -4,
					backgroundImage:
						"linear-gradient(90deg, rgba(114, 70, 195, 0.30) 0%, transparent 50%), linear-gradient(210deg, rgba(219, 213, 225, 0.20) 0%, transparent 50%)",
					filter: "blur(12px)",
					opacity: 0.28,
				}}
			/>
			<div
				className="absolute inset-0"
				style={{
					zIndex: -3,
					background:
						"radial-gradient(ellipse at 61% 4%, rgba(255,255,255,0.22), transparent 38%), radial-gradient(ellipse at 64% 32%, rgba(114, 70, 195, 0.22), transparent 42%)",
				}}
			/>
			<div
				className="absolute inset-0"
				style={{
					zIndex: -2,
					background:
						"radial-gradient(circle at center, transparent 25%, rgba(0,0,0,0.17) 58%, rgba(0,0,0,0.85) 100%), linear-gradient(to bottom, transparent 45%, rgba(0,0,0,0.76) 100%)",
				}}
			/>
			<div
				className="absolute inset-0 mix-blend-soft-light"
				style={{
					zIndex: -1,
					opacity: 0.17,
					backgroundImage:
						"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")",
				}}
			/>
		</div>
	);
}
