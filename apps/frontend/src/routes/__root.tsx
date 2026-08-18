import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import {
	ErrorScreen,
	NotFoundScreen,
} from "../modules/errors/error-screens.tsx";
import { THEME_SCRIPT } from "../modules/theme/theme.ts";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Control de Asistencia · Elineas",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	/**
	 * Capa 1 de la contención de errores (spec 05 §5): la frontera de aplicación.
	 *
	 * Se declara además de la del router porque ésta es la que atrapa lo que se
	 * rompe **fuera** de una ruta concreta —un proveedor, el propio árbol de
	 * layout— y es la diferencia entre una pantalla recuperable y una en blanco.
	 */
	errorComponent: ({ error, reset }) => (
		<ErrorScreen error={error} reset={reset} />
	),
	notFoundComponent: () => <NotFoundScreen />,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		// `suppressHydrationWarning`: el script de más abajo pone la clase `dark` en
		// este mismo elemento antes de que React hidrate, así que el servidor y el
		// cliente difieren aquí **a propósito**. Es la única forma de no parpadear, y
		// sin esto React lo registra como un error de hidratación en cada carga.
		<html lang="es" suppressHydrationWarning>
			<head>
				<HeadContent />
				{/*
				 * Resuelve el tema antes del primer pintado: sin esto la página se ve
				 * un instante en claro antes de saltar a oscuro. El servidor no puede
				 * hacerlo porque la preferencia del sistema sólo la conoce el
				 * navegador.
				 */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: es una
				    constante del propio código, sin datos de usuario, y tiene que
				    ejecutarse de forma síncrona en el documento inicial. */}
				<script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
			</head>
			<body>
				{children}
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
