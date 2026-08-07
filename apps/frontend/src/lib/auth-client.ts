import { createAuthClient } from "better-auth/react";

// better-auth vive en apps/backend; aquí solo se apunta a esa URL y se
// incluyen las cookies de sesión en las peticiones cross-origin.
export const authClient = createAuthClient({
	baseURL: import.meta.env.VITE_BACKEND_URL,
	fetchOptions: {
		credentials: "include",
	},
});
