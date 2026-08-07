# syntax=docker/dockerfile:1
#
# Contexto de build: LA RAÍZ DEL MONOREPO (esta imagen necesita `packages/` y
# el lockfile compartido):
#
#   docker build -f apps/backend/Dockerfile .
#
# docker-compose.yml / docker-compose.prod.yml ya lo declaran así.

ARG BUN_VERSION=1-alpine

# ---- base: runtime de bun, compartido por todas las etapas ----
FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

# ---- deps: instala TODAS las dependencias (dev incluidas, para el hot reload) ----
# El lockfile de la raíz lista TODOS los workspaces, así que --frozen-lockfile
# necesita el package.json de cada uno en disco para validarlo, aunque esta
# imagen solo vaya a correr `backend`.
FROM base AS deps
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/validations/package.json ./packages/validations/
COPY packages/specs/package.json ./packages/specs/
COPY packages/docs/package.json ./packages/docs/
RUN --mount=type=cache,id=bun-install-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- dev: deps + código fuente; hot reload vía bind mount (ver docker-compose.yml) ----
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
WORKDIR /app/apps/backend
EXPOSE 3001
CMD ["bun", "--hot", "src/index.ts"]

# ---- prod-deps: solo dependencias de producción ----
FROM base AS prod-deps
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/validations/package.json ./packages/validations/
COPY packages/specs/package.json ./packages/specs/
COPY packages/docs/package.json ./packages/docs/
RUN --mount=type=cache,id=bun-install-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# ---- prod: imagen final. Bun corre el backend directamente desde el código
# fuente (sin paso de bundling); solo lleva lo que hace falta en runtime. ----
FROM base AS prod
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=prod-deps /app/packages/validations/node_modules ./packages/validations/node_modules
COPY --from=prod-deps /app/packages/specs/node_modules ./packages/specs/node_modules
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/validations ./packages/validations
COPY packages/specs ./packages/specs
COPY apps/backend ./apps/backend
WORKDIR /app/apps/backend
EXPOSE 3001
CMD ["bun", "run", "start"]
