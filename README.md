# elineas-control-asistencia

Monorepo administrado con [Bun workspaces](https://bun.sh/docs/install/workspaces).

```
apps/
  backend/     API con Hono (identidad vía Identity Server, datos con Drizzle + PostgreSQL)
  frontend/    Web con TanStack Start (React, SSR)
packages/
  validations/ Esquemas de Zod compartidos
  specs/       Contratos de la API (path, método, esquemas request/response)
  docs/        Documentación del proyecto
```

Ver [packages/docs/architecture.md](./packages/docs/architecture.md) para el detalle de la arquitectura y [packages/docs/contributing.md](./packages/docs/contributing.md) para levantar el proyecto en local.

## Quick start

### Con Docker (recomendado)

```bash
cp .env.example .env
cp apps/backend/.env.local.example apps/backend/.env.local
cp apps/frontend/.env.local.example apps/frontend/.env.local

docker compose up -d --build
```

- frontend → http://localhost:3004
- backend → http://localhost:3001

Levanta también un Postgres propio (`postgres:16-alpine`). Detalle completo,
y cómo desplegar en el servidor, en [DEPLOY.md](./DEPLOY.md).

### Sin Docker

```bash
bun install

# variables de entorno (ver packages/docs/contributing.md para el detalle)
cp apps/backend/.env.local.example apps/backend/.env.local    # si no existe aún
cp apps/frontend/.env.local.example apps/frontend/.env.local  # si no existe aún

bun run dev            # backend (:3001) + frontend (:3004) en paralelo
```

Requiere un Postgres propio corriendo en `localhost:5434` (el mismo puerto
que publica el compose de desarrollo — puedes usar ese aunque corras las
apps fuera de Docker) o el que pongas en `apps/backend/.env.local`.

## Scripts principales

| Script | Descripción |
| --- | --- |
| `bun run dev` | Corre backend y frontend en paralelo |
| `bun run dev:backend` / `dev:frontend` | Corre solo una app |
| `bun run build` | Build del frontend (el backend corre directo desde el código fuente, sin build) |
| `bun run check` / `lint` / `format` | Biome sobre todo el repo |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle, delegado a `apps/backend` |
| `bun run test` | Pruebas del backend (necesitan el Postgres del compose migrado) |

## Documentación

- [Arquitectura](./packages/docs/architecture.md)
- [Convenciones de API](./packages/docs/api-conventions.md)
- [Cómo contribuir / levantar en local](./packages/docs/contributing.md)
- [Docker y despliegue](./DEPLOY.md)
