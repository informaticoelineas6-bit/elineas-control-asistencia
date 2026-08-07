# Arquitectura

Este repositorio es un monorepo administrado con **Bun workspaces**.

```
apps/
  backend/     API HTTP construida con Hono. Dueña de la base de datos
               (Drizzle + PostgreSQL) y de la autenticación (better-auth).
  frontend/    Aplicación web con TanStack Start (React + SSR). Consume la
               API del backend por HTTP, no accede a la base de datos.
packages/
  validations/ Esquemas de Zod compartidos (entidades, inputs). Son la
               única fuente de verdad de forma/validación de los datos.
  specs/       Contratos de la API: para cada endpoint definen path, método
               y los esquemas de request/response de `validations`. El
               backend los usa para validar sus handlers y el frontend para
               construir llamadas tipadas.
  docs/        Esta documentación.
```

## Por qué está separado así

- **backend** y **frontend** son procesos independientes, cada uno con su
  propio `dev`/`build`/deploy. El backend no sabe nada de React; el frontend
  no sabe nada de Drizzle ni de better-auth.
- **validations** evita duplicar reglas de validación: el mismo esquema Zod
  valida el body de una petición en el backend y un formulario en el
  frontend.
- **specs** evita que el path o el shape de una respuesta se desincronicen
  entre backend y frontend: ambos importan el mismo objeto.

## Comunicación entre apps

En desarrollo:

- `frontend` corre en `http://localhost:3000`.
- `backend` corre en `http://localhost:3001`.

El frontend llama al backend con `fetch` (`credentials: "include"`) usando
`VITE_BACKEND_URL`. El backend habilita CORS con credenciales solo para el
origen configurado en `FRONTEND_URL`, y better-auth usa `trustedOrigins`
para aceptar peticiones de auth desde ese mismo origen.

## Autenticación

better-auth vive únicamente en `apps/backend` (`src/lib/auth.ts`) y expone
`/api/auth/*`. El frontend solo usa `better-auth/react` (`authClient`)
apuntando a `VITE_BACKEND_URL`; no ejecuta lógica de auth en el servidor.

> Nota: como el auth vive en un origen distinto al del frontend, las
> cookies de sesión se configuran como `sameSite: "none"` + `secure: true`.
> Si en algún momento se necesita leer la sesión durante el *server-side
> render* del frontend (por ejemplo en un loader), hay que reenviar la
> cabecera `cookie` de la petición entrante hacia el backend explícitamente
> — hoy ningún loader lo hace, todo el estado de sesión se lee en cliente
> con `authClient.useSession()`.

> **Pendiente:** existe documentación de un Identity Server externo de
> Elineas ([identity-server-usage.md](./identity-server-usage.md)) que
> propone autenticar contra ese servicio (JWT + roles por sistema) en vez
> de manejar email/password localmente. `apps/backend` hoy sigue usando
> better-auth local tal como estaba antes de este reordenamiento a
> monorepo — migrar a ese Identity Server es trabajo aparte, no asumido
> aquí.
