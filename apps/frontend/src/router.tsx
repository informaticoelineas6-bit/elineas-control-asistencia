import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getContext } from "./integrations/tanstack-query/root-provider";
import {
	ErrorScreen,
	NotFoundScreen,
} from "./modules/errors/error-screens.tsx";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const context = getContext();

	const router = createTanStackRouter({
		routeTree,
		context,
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		/**
		 * Contención de errores (spec 05 §5). Se declaran aquí, en el router, y no
		 * ruta por ruta: así una pantalla nueva nace protegida en vez de heredar el
		 * olvido de quien la escribió.
		 *
		 * - `defaultErrorComponent` — capa 2: un loader que revienta se queda dentro
		 *   del shell y no tumba el aside.
		 * - `defaultNotFoundComponent` — capa 3: 404 con vuelta al destino del rol.
		 *
		 * La capa 1 (frontera de aplicación) es el `errorComponent` de la ruta raíz,
		 * en `routes/__root.tsx`: es la que captura lo que se rompe fuera de una
		 * ruta concreta.
		 */
		defaultErrorComponent: ({ error, reset }) => (
			<ErrorScreen error={error} reset={reset} />
		),
		defaultNotFoundComponent: () => <NotFoundScreen />,
	});

	setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
