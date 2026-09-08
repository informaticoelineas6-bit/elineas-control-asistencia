import { createFileRoute } from "@tanstack/react-router";
import { BadgeDollarSign, Wallet } from "lucide-react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "#/components/ui/tabs.tsx";
import { RequireRole } from "#/modules/auth/require-role.tsx";
import { AdjustmentsTab } from "#/modules/payroll/adjustments-tab.tsx";
import { SalariesTab } from "#/modules/payroll/salaries-tab.tsx";

const PATH = "/payroll" as const;

export const Route = createFileRoute("/_authed/payroll")({
	component: () => (
		<RequireRole path={PATH}>
			<PayrollPage />
		</RequireRole>
	),
});

/**
 * Nómina (spec 17 §5). Sólo `global_manager` y `superadmin` (RN-17.1).
 *
 * **Es la única pantalla del sistema donde un importe se escribe a mano**, y por
 * eso el aviso de arriba no es decoración: lo que se registre aquí sale en el
 * listado que alimenta al proceso de nómina real y le llega a la persona como
 * notificación, con la cifra dentro.
 *
 * Dos pestañas y no dos rutas porque son las dos caras del mismo dato: el sueldo
 * es lo que se ajusta, y el divisor de RN-17.3 convierte uno en el otro. La de
 * ajustes va primera por lo mismo que las ausencias abren `/team`: es la que
 * mueve dinero.
 *
 * El `department_head` no llega hasta aquí —el aside no le ofrece el enlace y el
 * guard lo echaría—, pero eso es sólo la UX de RN-03.3: la barrera de verdad es
 * que los seis endpoints le responden 403.
 */
function PayrollPage() {
	return (
		<div className="max-w-6xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Nómina</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Ajustes económicos sobre el sueldo: descuentos automáticos por
					ausencia injustificada y ajustes manuales de cualquier signo. Esto no
					calcula planilla ni emite boletas; produce el listado del periodo.
				</p>
			</div>

			<Tabs defaultValue="adjustments">
				<TabsList>
					<TabsTrigger value="adjustments">
						<BadgeDollarSign />
						Ajustes
					</TabsTrigger>
					<TabsTrigger value="salaries">
						<Wallet />
						Sueldos
					</TabsTrigger>
				</TabsList>

				<TabsContent value="adjustments">
					<AdjustmentsTab />
				</TabsContent>

				<TabsContent value="salaries">
					<SalariesTab />
				</TabsContent>
			</Tabs>
		</div>
	);
}
