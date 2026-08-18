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

## Dominio: servicios, transacciones y efectos

Cada funcionalidad de negocio se implementa como un **servicio** en
`apps/backend/src/services/`, y el router de Hono se limita a validar la entrada,
exigir el rol y llamarlo. La primera implementada así es la de departamentos
([specs/01](../specs/01-organizacion-departamentos.md)); las siguientes copian la forma.

| Pieza | Dónde |
|---|---|
| Reglas de negocio de un dominio | `apps/backend/src/services/<dominio>.ts` |
| Validación de entrada y rol mínimo | `apps/backend/src/routes/<dominio>.ts` |
| Esquemas compartidos | `packages/validations/src/<dominio>.ts` |
| Path, método y esquemas del endpoint | `packages/contracts/src/<dominio>.ts` |
| Bitácora | `apps/backend/src/services/audit.ts` — una sola función `audit(tx, entry)` |
| Notificaciones | `apps/backend/src/services/notifications.ts` — `notify(tx, destinatarios, aviso)` |
| Configuración global tipada | `apps/backend/src/services/config.ts` |
| Dato salarial, aislado en su propia tabla | `employee_compensation`, sólo desde `services/users.ts` |

Convenciones que sostienen esto:

- **Una mutación es una transacción.** El cambio, su entrada de bitácora y las
  notificaciones que provoca se escriben juntos (RN-18.4): si algo se revierte, se
  revierte todo. De ahí que `audit` y `notify` reciban la transacción como primer
  argumento en vez de usar la conexión suelta.
- **Los efectos se generan en el servidor, nunca en el cliente.** En el legacy la
  regla que decidía cuándo recordar algo vivía en el contexto de notificaciones del
  frontend, así que sólo se ejecutaba si alguien abría la app (hallazgo H-4).
- **El vocabulario de acciones auditables y de tipos de notificación es cerrado**
  (`packages/validations/src/audit.ts` y `notifications.ts`): añadir una obliga a
  pasar por el catálogo, y de un vistazo se ve qué está cubierto. La bitácora del
  legacy quedó a medias precisamente por escribirse con cadenas libres desde los
  puntos de uso.
- **El path de un endpoint se escribe una sola vez**, en su contrato, con la
  sintaxis de Hono (`/api/departments/:id`). El backend lo monta tal cual y el
  frontend lo resuelve con `resolvePath`.
- **Un dato sensible se aísla en su propia tabla, no en una convención.** El sueldo salió de
  `profiles` a `employee_compensation` ([specs/02](../specs/02-usuarios-y-perfiles.md) §6a): en
  el legacy estaba en la misma fila y sólo lo protegía la costumbre de no hacer `select *`
  (hallazgo H-3). Con la separación física, un endpoint de perfiles no puede filtrarlo aunque
  alguien escriba una consulta nueva sin pensarlo, y sin RLS de red de seguridad eso importa.
- **La comprobación de ámbito es una única función tipada** (`hasScope`,
  `requireScope`, `canManage` en `middleware/auth.ts`), nunca repetida por endpoint:
  en el legacy se llamó con los argumentos invertidos en varias migraciones y falló
  en silencio (hallazgo H-1).
