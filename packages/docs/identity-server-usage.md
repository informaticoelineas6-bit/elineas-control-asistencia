# Documentación de integración

Cómo conectar un nuevo backend al flujo de autenticación y autorización de Elineas, con ejemplos por stack.

## Pasos de integración

### 1. Registra el sistema

En Sistemas, crea uno para tu backend (nombre + slug). Ese slug identifica a tu sistema en cada login y en cada consulta de roles.

Ruta en la consola administrativa: /systems

### 2. Crea roles y asígnalos

En Roles crea los roles de tu sistema (p. ej. admin, vendedor) y en Asignaciones dales esos roles a los usuarios que deban entrar. Sin al menos un rol en el sistema, el login de ese usuario se rechaza con 403.

Ruta en la consola administrativa: /user-roles

### 3. Implementa el login

Tu frontend (o tu backend, por él) hace POST a /api/auth/sign-in con { email, password, systemSlug }. La respuesta trae { user, token } — el JWT corto — y el session token (largo plazo) viaja en la cabecera "set-auth-token".

### 4. Verifica el JWT en tu backend

Con el JWKS público del IS, verifica la firma y expiración del JWT localmente (sin llamar al IS en cada petición). El JWT dura ~15 minutos; renuévalo con GET /api/auth/token usando el session token.

### 5. Autoriza con los roles del usuario

El JWT prueba identidad, no permisos. Para saber qué puede hacer el usuario en TU sistema, consulta GET /api/user-roles/me?systemSlug=… con el session token como Bearer.

### 6. Cierra sesión

POST /api/auth/sign-out con el session token revoca la sesión en el IS; limpia también tus propias cookies (session y jwt).

## Endpoints que necesitas

El resto de la API (empleados, sistemas, roles…) es exclusiva de esta consola administrativa; un backend cliente solo necesita estos.

| Método | Ruta | Autenticación | Qué hace |
| --- | --- | --- | --- |
| POST | `/api/auth/sign-in` | — | Login con email + contraseña + systemSlug. Devuelve { user, token, system } y el session token en la cabecera "set-auth-token". |
| GET | `/api/auth/token` | Session token | Emite un JWT nuevo (el actual dura ~15 min) sin volver a pedir credenciales. |
| GET | `/api/auth/jwks` | Público | JSON Web Key Set para verificar el JWT localmente (sin llamar al IS). |
| POST | `/api/auth/sign-out` | Session token | Revoca la sesión actual. |
| GET | `/api/user-roles/me?systemSlug=…` | Session token | Roles del usuario autenticado en un sistema concreto (para autorizar). |

## Verificar el JWT y consultar roles

**verify-jwt.ts (cualquier backend Node/TypeScript)**

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

// AUTH_API_URL: la URL base del Identity Server, p. ej. https://auth.elineas.com
const jwks = createRemoteJWKSet(new URL("/api/auth/jwks", process.env.AUTH_API_URL!));

// Verificación local, sin round-trip al IS: comprueba firma + expiración
// contra el JWKS público. jose cachea el JWKS en memoria automáticamente.
export async function verifyElineasToken(token: string) {
	try {
		const { payload } = await jwtVerify(token, jwks);
		// payload.sub = id de usuario en el IS. email/name reflejan el usuario,
		// pero NO uses un eventual payload.role para autorizar: no está
		// garantizado. Para permisos en TU sistema, consulta /api/user-roles/me
		// (con el session token, no con este JWT) — ver "Autorización" abajo.
		return payload as { sub: string; email?: string; name?: string; exp: number };
	} catch {
		return null; // firma inválida o token expirado (dura ~15 min)
	}
}
```

**roles.ts**

```typescript
// Con el session token (no el JWT) obtenido en el login, de vida larga.
export async function getMyRoles(sessionToken: string, systemSlug: string) {
	const url = new URL("/api/user-roles/me", process.env.AUTH_API_URL);
	url.searchParams.set("systemSlug", systemSlug);

	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${sessionToken}` },
	});
	if (!res.ok) return [];

	const { roles } = (await res.json()) as {
		roles: { id: string; name: string; description: string | null }[];
	};
	return roles;
}
```

## Ejemplos de login por stack

Todos siguen el mismo patrón: el navegador llama a un backend propio (nunca directo al IS desde el cliente) que guarda el session token y el JWT en cookies httpOnly.

### React

**server/login.ts (tu backend, p. ej. Express)**

```typescript
app.post("/api/login", async (req, res) => {
	const { email, password } = req.body;

	const r = await fetch(new URL("/api/auth/sign-in", process.env.AUTH_API_URL), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password, systemSlug: "mi-sistema" }),
	});
	if (!r.ok) return res.status(401).json({ error: "Credenciales inválidas" });

	const { user, token } = await r.json();
	// El session token (largo plazo) viaja en esta cabecera, no en el body.
	const sessionToken = r.headers.get("set-auth-token")!;

	// httpOnly: el JS del navegador nunca ve estos valores (mitiga XSS).
	res.cookie("session", sessionToken, { httpOnly: true, secure: true, sameSite: "lax" });
	res.cookie("jwt", token, { httpOnly: true, secure: true, sameSite: "lax" });
	res.json({ user });
});
```

**useAuth.tsx (React)**

```tsx
import { createContext, useContext, useState, type ReactNode } from "react";

type User = { id: string; name: string; email: string };
type Ctx = { user: User | null; signIn: (email: string, password: string) => Promise<void> };

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);

	async function signIn(email: string, password: string) {
		// Llama a TU backend, no directo al IS: así la cookie httpOnly la fija
		// tu propio servidor (ver server/login.ts).
		const res = await fetch("/api/login", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
		if (!res.ok) throw new Error("Credenciales inválidas");
		setUser((await res.json()).user);
	}

	return <AuthContext.Provider value={{ user, signIn }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext)!;
```

### Next.js

**app/api/login/route.ts**

```typescript
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { email, password } = await req.json();

	const r = await fetch(new URL("/api/auth/sign-in", process.env.AUTH_API_URL), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password, systemSlug: "mi-sistema" }),
	});
	if (!r.ok) {
		return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
	}

	const { user, token } = await r.json();
	const sessionToken = r.headers.get("set-auth-token")!;

	const response = NextResponse.json({ user });
	response.cookies.set("session", sessionToken, { httpOnly: true, secure: true, sameSite: "lax" });
	response.cookies.set("jwt", token, { httpOnly: true, secure: true, sameSite: "lax" });
	return response;
}
```

**middleware.ts**

```typescript
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Verificación en el edge: sin round-trip al IS en cada petición protegida.
const jwks = createRemoteJWKSet(new URL("/api/auth/jwks", process.env.AUTH_API_URL!));

export async function middleware(req: NextRequest) {
	const jwt = req.cookies.get("jwt")?.value;
	if (!jwt) return NextResponse.redirect(new URL("/login", req.url));

	try {
		await jwtVerify(jwt, jwks);
		return NextResponse.next();
	} catch {
		// Expiró (~15 min): redirige a una ruta que pida /api/auth/token con el
		// session token para renovarlo, igual que hace este proyecto.
		return NextResponse.redirect(new URL("/login", req.url));
	}
}

export const config = { matcher: ["/dashboard/:path*"] };
```

### TanStack Start

**modules/auth/actions/auth.ts**

```typescript
import { createServerFn } from "@tanstack/react-start";
import { setCookie, getCookie } from "@tanstack/react-start/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_API_URL = process.env.AUTH_API_URL!;
const jwks = createRemoteJWKSet(new URL("/api/auth/jwks", AUTH_API_URL));
const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" } as const;

export const signInFn = createServerFn({ method: "POST" })
	.validator((d: { email: string; password: string }) => d)
	.handler(async ({ data }) => {
		const res = await fetch(new URL("/api/auth/sign-in", AUTH_API_URL), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...data, systemSlug: "mi-sistema" }),
		});
		if (!res.ok) throw new Error("Credenciales inválidas");

		const { user, token } = await res.json();
		setCookie("session", res.headers.get("set-auth-token")!, cookieOpts);
		setCookie("jwt", token, cookieOpts);
		return { user };
	});

// Este mismo patrón (cookies + verificación JWT + refresco) es el que usa
// este proyecto en src/modules/auth/lib/{cookies,jwt,session}.ts.
export const getSessionFn = createServerFn({ method: "GET" }).handler(async () => {
	const jwt = getCookie("jwt");
	if (!jwt) return null;
	try {
		const { payload } = await jwtVerify(jwt, jwks);
		return { userId: payload.sub as string };
	} catch {
		return null; // expiró: renovar con GET /api/auth/token + el session token
	}
});
```

### Vue

**server/login.ts (tu backend, p. ej. Fastify)**

```typescript
import type { FastifyInstance } from "fastify";

export async function registerLogin(app: FastifyInstance) {
	app.post("/api/login", async (request, reply) => {
		const { email, password } = request.body as { email: string; password: string };

		const r = await fetch(new URL("/api/auth/sign-in", process.env.AUTH_API_URL), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password, systemSlug: "mi-sistema" }),
		});
		if (!r.ok) return reply.code(401).send({ error: "Credenciales inválidas" });

		const { user, token } = await r.json();
		// El session token (largo plazo) viaja en esta cabecera, no en el body.
		const sessionToken = r.headers.get("set-auth-token")!;

		// httpOnly: el JS del navegador nunca ve estos valores (mitiga XSS).
		reply
			.setCookie("session", sessionToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/" })
			.setCookie("jwt", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/" })
			.send({ user });
	});
}
```

**composables/useAuth.ts (Vue 3)**

```typescript
import { ref, readonly } from "vue";

type User = { id: string; name: string; email: string };
const user = ref<User | null>(null);

export function useAuth() {
	async function signIn(email: string, password: string) {
		// Llama a tu backend (no directo al IS), que fija las cookies httpOnly.
		const res = await fetch("/api/login", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
		if (!res.ok) throw new Error("Credenciales inválidas");
		user.value = (await res.json()).user;
	}

	return { user: readonly(user), signIn };
}
```

### Nuxt

**server/api/login.post.ts (Nuxt 3/4)**

```typescript
export default defineEventHandler(async (event) => {
	const { email, password } = await readBody(event);
	const authApiUrl = useRuntimeConfig().authApiUrl;

	const res = await $fetch.raw(`${authApiUrl}/api/auth/sign-in`, {
		method: "POST",
		body: { email, password, systemSlug: "mi-sistema" },
	}).catch(() => null);

	if (!res) {
		throw createError({ statusCode: 401, statusMessage: "Credenciales inválidas" });
	}

	const sessionToken = res.headers.get("set-auth-token")!;
	setCookie(event, "session", sessionToken, { httpOnly: true, secure: true, sameSite: "lax" });
	setCookie(event, "jwt", (res._data as any).token, { httpOnly: true, secure: true, sameSite: "lax" });
	return { user: (res._data as any).user };
});
```

**composables/useAuth.ts (Nuxt)**

```typescript
export function useAuth() {
	const user = useState<{ id: string; name: string; email: string } | null>(
		"user",
		() => null,
	);

	async function signIn(email: string, password: string) {
		const { user: u } = await $fetch<{ user: typeof user.value }>("/api/login", {
			method: "POST",
			body: { email, password },
		});
		user.value = u;
	}

	return { user, signIn };
}
```

## Notas de seguridad

- El **session token** es de larga duración (días): trátalo como una contraseña. Nunca lo expongas a JavaScript del navegador; guárdalo solo en una cookie httpOnly de tu backend.
- El **JWT** es de corta duración (~15 min) y se verifica sin llamar al IS: es el que puedes exponer al cliente si tu arquitectura lo necesita (p. ej. para llamadas directas desde el navegador a tu propia API).
- Agrega el origen de tu nuevo frontend a la lista de orígenes permitidos del Identity Server (variable `ALLOWED_ORIGIN`) o las peticiones desde el navegador serán bloqueadas por CORS.
- El alta de usuarios no es autoservicio: solo un admin crea cuentas, desde Usuarios en esta consola.
