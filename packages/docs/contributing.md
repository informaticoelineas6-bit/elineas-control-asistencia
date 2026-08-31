# Levantar el proyecto en local

> Esta guía es para correr las apps directo con Bun en el host. Si prefieres
> Docker (incluye un Postgres propio, sin instalar nada más), ver
> [DEPLOY.md](../../DEPLOY.md).

## Requisitos

- [Bun](https://bun.sh) instalado.
- Una base de datos PostgreSQL accesible.

## Instalación

```bash
bun install
```

Esto instala las dependencias de todo el monorepo (`apps/*` y `packages/*`)
de una sola vez gracias a los workspaces de Bun.

## Variables de entorno

- `apps/backend/.env.local`

  ```
  DATABASE_URL=postgresql://usuario:password@localhost:5434/mi_bd
  AUTH_API_URL=https://auth.elineas.com   # Identity Server; sin esto no arranca
  SYSTEM_SLUG=control-asistencia
  FRONTEND_URL=http://localhost:3004
  PORT=3001
  ```

- `apps/frontend/.env.local`

  ```
  VITE_BACKEND_URL=http://localhost:3001
  # opcional: consola del Identity Server, para el enlace del alta de cuentas
  # VITE_IDENTITY_CONSOLE_URL=http://localhost:8081
  ```

## Desarrollo

```bash
bun run dev            # backend + frontend en paralelo
bun run dev:backend    # solo backend (http://localhost:3001)
bun run dev:frontend   # solo frontend (http://localhost:3004)
```

## Base de datos

Los comandos de Drizzle se ejecutan siempre desde la raíz, delegando al
workspace `backend`:

```bash
bun run db:generate
bun run db:migrate
bun run db:studio
```

## Pruebas

```bash
bun run test           # equivale a: bun test dentro de apps/backend
```

Las pruebas del backend son **de integración**: hablan con el Postgres real y sólo
sustituyen el Identity Server. Con la RLS de Supabase fuera del proyecto, el handler
de Hono es la única barrera de autorización (RN-00.1), y una prueba con la
autorización simulada no probaría nada. Requisitos:

- el Postgres del compose levantado (`docker compose up -d postgres`),
- las migraciones aplicadas (`bun run db:migrate`),
- `apps/backend/.env.local` con `DATABASE_URL` y `AUTH_API_URL` — el script pasa ese
  fichero explícitamente porque Bun no carga `.env.local` cuando `NODE_ENV=test`.

Cada caso crea sus propios datos con un prefijo único y los borra al terminar; no
hace falta una base aparte, pero **sí escribe en la de desarrollo**.

## Lint / formato

```bash
bun run check   # biome check sobre todo el repo
bun run lint
bun run format
```

## Build

```bash
bun run build   # build de backend y frontend
```

## Idioma

**El código se escribe en inglés; la interfaz, en español.**

| | Idioma | Por qué |
|---|---|---|
| Rutas (`/attendance`), nombres de archivo, identificadores, tipos, claves de consulta, claves de configuración, acciones de bitácora, tipos de notificación | inglés | Es el idioma de las bibliotecas con las que se mezclan. `useUpdateUsuario` obliga a cambiar de idioma a media línea. |
| Etiquetas, mensajes de error, textos de ayuda, correos — **todo lo que lee una persona** | español | No es una preferencia: RN-05.10 lo exige, y en planta nadie lee inglés. |
| Comentarios y JSDoc | español | Citan las specs por número de regla, y las specs están en español. Tenerlos en otro idioma que aquello que explican obliga a traducir mentalmente en cada lectura. |
| Specs (`packages/specs`) | español | Son el documento de producto de una empresa cubana. |

La etiqueta de un menú y su ruta son cosas distintas y no tienen por qué coincidir: *Mi
asistencia* vive en `/attendance`. La tabla de rutas está en
[spec 05 §7](../specs/05-shells-y-navegacion.md).

Un caso concreto que se ve mucho: las **claves de `app_config`** son `snake_case` en inglés
porque son literalmente la clave de la fila en la base, y así el catálogo de la
[spec 06 §3](../specs/06-configuracion-global.md) se lee igual en la spec, en la base y en la
API.
