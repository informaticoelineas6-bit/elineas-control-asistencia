/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_BACKEND_URL: string;
	/**
	 * Consola del Identity Server, para enlazar el paso 1 del alta (RN-02.10).
	 * Opcional: sin ella la pantalla de usuarios explica el paso pero no ofrece
	 * enlace, que es mejor que ofrecer uno roto.
	 */
	readonly VITE_IDENTITY_CONSOLE_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
