# elineas-control-asistencia

Monorepo administrado con [Bun workspaces](https://bun.sh/docs/install/workspaces).

```
apps/
  backend/     API con Hono (auth con better-auth, datos con Drizzle + PostgreSQL)
  frontend/    Web con TanStack Start (React, SSR)
packages/
  validations/ Esquemas de Zod compartidos
  specs/       Contratos de la API (path, método, esquemas request/response)
  docs/        Documentación del proyecto
```

Ver [packages/docs/architecture.md](./packages/docs/architecture.md) para el detalle de la arquitectura y [packages/docs/contributing.md](./packages/docs/contributing.md) para levantar el proyecto en local.

## Quick start

```bash
bun install

# variables de entorno (ver packages/docs/contributing.md para el detalle)
cp apps/backend/.env.local.example apps/backend/.env.local    # si no existe aún
cp apps/frontend/.env.local.example apps/frontend/.env.local  # si no existe aún

bun run dev            # backend (:3001) + frontend (:3000) en paralelo
```

## Scripts principales

| Script | Descripción |
| --- | --- |
| `bun run dev` | Corre backend y frontend en paralelo |
| `bun run dev:backend` / `dev:frontend` | Corre solo una app |
| `bun run build` | Build de ambas apps |
| `bun run check` / `lint` / `format` | Biome sobre todo el repo |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle, delegado a `apps/backend` |

## Documentación

- [Arquitectura](./packages/docs/architecture.md)
- [Convenciones de API](./packages/docs/api-conventions.md)
- [Cómo contribuir / levantar en local](./packages/docs/contributing.md)
