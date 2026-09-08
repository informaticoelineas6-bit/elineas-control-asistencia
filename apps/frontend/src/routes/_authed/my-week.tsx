import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { MyWeek } from "#/modules/attendance/week.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";

const PATH = "/my-week" as const;

export const Route = createFileRoute("/_authed/my-week")({
	component: () => (
		<RequireRole path={PATH}>
			<MyWeekPage />
		</RequireRole>
	),
});

/**
 * Mi semana (spec 05 §3): el historial propio en la forma que sirve en un
 * teléfono.
 *
 * **No está en el aside**, y no es un olvido: en escritorio la vista que sirve es
 * *Mi asistencia* (`/attendance`), con su calendario del mes y su tabla. Tener
 * las dos en el menú sería ofrecer dos veces el mismo dato con dos nombres. Su
 * regla de acceso sí está en la tabla de navegación, porque el guard tiene que
 * poder leerla (RN-05.7).
 *
 * El enlace a *Mi asistencia* de abajo existe para el caso de quien llega aquí
 * desde un escritorio —con `?ui=employee`, o con la ventana estrecha— y quiere el
 * mes entero.
 */
function MyWeekPage() {
	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Mi semana</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Tus jornadas de esta semana, día por día.
				</p>
			</div>

			<MyWeek />

			<Button asChild variant="outline" className="w-full">
				<Link to="/attendance">
					<CalendarClock />
					Ver el mes completo
				</Link>
			</Button>
		</div>
	);
}
