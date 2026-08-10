# syntax=docker/dockerfile:1
#
# Contexto de build: LA RAÍZ DEL MONOREPO (esta imagen necesita `packages/` y
# el lockfile compartido):
#
#   docker build -f apps/frontend/Dockerfile .
#
# docker-compose.yml / docker-compose.prod.yml ya lo declaran así.

ARG BUN_VERSION=1-alpine

# ---- base: runtime de bun, compartido por todas las etapas ----
FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

# ---- deps: instala TODAS las dependencias (dev incluidas, para el hot reload) ----
# El lockfile de la raíz lista TODOS los workspaces, así que --frozen-lockfile
# necesita el package.json de cada uno en disco para validarlo, aunque esta
# imagen solo vaya a correr `frontend`.
FROM base AS deps
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/validations/package.json ./packages/validations/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/docs/package.json ./packages/docs/
RUN --mount=type=cache,id=bun-install-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- dev: deps + código fuente; hot reload vía bind mount (ver docker-compose.yml) ----
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
WORKDIR /app/apps/frontend
EXPOSE 3004
CMD ["bun", "run", "dev", "--", "--host", "0.0.0.0"]

# ---- build: genera el bundle de producción (server Nitro, preset bun) ----
# VITE_BACKEND_URL se incrusta en el bundle del cliente en build-time (Vite lo
# reemplaza como literal): para cambiarlo en prod hay que reconstruir la
# imagen, no basta con tocar el .env (ver docker-compose.prod.yml).
FROM deps AS build
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
COPY . .
WORKDIR /app/apps/frontend
RUN bun run build

# ---- prod-deps: solo dependencias de producción ----
FROM base AS prod-deps
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/validations/package.json ./packages/validations/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/docs/package.json ./packages/docs/
RUN --mount=type=cache,id=bun-install-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# ---- prod: imagen final, sirve el server Nitro precompilado sobre Bun ----
# Nitro empaqueta sus dependencias dentro de `.output/server/_libs`; el
# node_modules de aquí es red de seguridad para lo que no haya inlineado.
FROM base AS prod
ENV NODE_ENV=production
ENV PORT=3004
ENV HOST=0.0.0.0
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=build /app/apps/frontend/.output ./apps/frontend/.output
COPY --from=build /app/apps/frontend/package.json ./apps/frontend/package.json
WORKDIR /app/apps/frontend
EXPOSE 3004
CMD ["bun", ".output/server/index.mjs"]
