import { betterAuth } from "better-auth";

const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3004";

export const auth = betterAuth({
	emailAndPassword: {
		enabled: true,
	},
	// El frontend vive en otro origen (otra app, otro puerto/dominio), así
	// que hay que declararlo como confiable y permitir cookies cross-site.
	trustedOrigins: [frontendUrl],
	advanced: {
		defaultCookieAttributes: {
			sameSite: "none",
			secure: true,
		},
	},
});
