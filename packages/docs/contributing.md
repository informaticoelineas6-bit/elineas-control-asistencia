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
