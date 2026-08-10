# Arquitectura

Este repositorio es un monorepo administrado con **Bun workspaces**.

```
apps/
  backend/     API HTTP construida con Hono. Dueña de la base de datos
               (Drizzle + PostgreSQL) y de la sesión: es quien habla con el
               Identity Server de Elineas y custodia sus tokens.
  frontend/    Aplicación web con TanStack Start (React + SSR). Consume la
               API del backend por HTTP, no accede a la base de datos.
packages/
  validations/ Esquemas de Zod compartidos (entidades, inputs) y el
               vocabulario de roles. Son la única fuente de verdad de
               forma/validación de los datos.
  contracts/   Contratos de la API: para cada endpoint definen path, método
               y los esquemas de request/response de `validations`. El
               backend los usa para validar sus handlers y el frontend para
               construir llamadas tipadas.
  specs/       Especificaciones funcionales en markdown, una por
               funcionalidad. Son el contrato de lo que debe existir.
  docs/        Esta documentación.
```

> Los contratos vivían en `packages/specs`; ese nombre pasó a la carpeta de
> especificaciones funcionales, así que el paquete de código es ahora
> `packages/contracts` (`@elineas/contracts`).

## Por qué está separado así

- **backend** y **frontend** son procesos independientes, cada uno con su
  propio `dev`/`build`/deploy. El backend no sabe nada de React; el frontend
  no sabe nada de Drizzle ni de tokens.
- **validations** evita duplicar reglas de validación: el mismo esquema Zod
  valida el body de una petición en el backend y un formulario en el
  frontend.
- **contracts** evita que el path o el shape de una respuesta se desincronicen
  entre backend y frontend: ambos importan el mismo objeto.

## Docker

Cada app tiene su propio `Dockerfile` (multi-stage: `dev` con hot reload,
`prod` con el build final), pero el contexto de build de ambos es la RAÍZ del
monorepo — necesitan `packages/`. `docker-compose.yml` (dev) y
`docker-compose.prod.yml` (servidor) están en la raíz, no dentro de cada app.
Detalle completo en [DEPLOY.md](../../DEPLOY.md).

## Comunicación entre apps

En desarrollo:

- `frontend` corre en `http://localhost:3004`.
- `backend` corre en `http://localhost:3001`.

El frontend llama al backend con `fetch` (`credentials: "include"`) usando
`VITE_BACKEND_URL`. El backend habilita CORS con credenciales solo para el
origen configurado en `FRONTEND_URL`.

## Autenticación e identidad

La identidad la provee el **Identity Server de Elineas**
([identity-server-usage.md](./identity-server-usage.md)); el contrato completo
está en [specs/00-migracion-datos-e-identidad.md](../specs/00-migracion-datos-e-identidad.md)
Parte C. Este sistema **no almacena contraseñas ni las verifica**, y **no crea
cuentas**: eso se hace en la consola del IS.

Reparto en el código:

| Pieza | Dónde |
|---|---|
| Cliente del IS (sign-in, sign-out, refresco de JWT, JWKS, roles) | `apps/backend/src/lib/identity.ts` — el único módulo que llama al IS |
| Custodia de tokens en cookies httpOnly | `apps/backend/src/lib/cookies.ts` |
| Caché de roles por sesión (TTL corto) | `apps/backend/src/lib/roles-cache.ts` |
| Middleware de sesión, rol efectivo y ámbito | `apps/backend/src/middleware/auth.ts` |
| Vocabulario de roles y su prioridad | `packages/validations/src/roles.ts` |
| Guard de UI (filtrado del aside, guard de página) | `apps/frontend/src/modules/auth/` |

Reglas que no se negocian:

- El navegador **nunca** llama directo al IS: siempre a través del backend, que
  es quien recibe y custodia los tokens.
- El **session token** (larga duración) y el **JWT** (~15 min) van en cookies
  `httpOnly`; el JavaScript del navegador no los ve.
- El JWT se verifica **localmente** contra el JWKS del IS; no hay una llamada al
  IS por petición.
- El JWT **prueba identidad, no permisos**: la autorización usa siempre los
  roles de `/api/user-roles/me`, nunca un campo del token.
- La autorización del cliente es **UX**; cada endpoint valida rol y ámbito por
  su cuenta.

> Nota: como el backend vive en un origen distinto al del frontend, las cookies
> son `sameSite: "none"` + `secure: true`, y por eso el estado de sesión se
> resuelve en cliente (`GET /api/me/permissions`) y no en un loader de SSR. Si
> algún día ambos se sirven bajo el mismo origen, esto puede volver a `lax` y
> moverse al servidor — es la decisión abierta §C.9.1 de la spec 00.
