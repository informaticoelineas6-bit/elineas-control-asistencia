# Despliegue

Cómo levantar este proyecto en local con Docker y cómo desplegarlo en el
servidor.

## Local (desarrollo)

`docker-compose.yml` levanta un Postgres propio (imagen oficial
`postgres:16-alpine`, no gestionada por nadie más) además de `backend` y
`frontend`, ambos con hot reload vía bind mount.

```bash
cp .env.example .env
cp apps/backend/.env.local.example apps/backend/.env.local     # si no existe
cp apps/frontend/.env.local.example apps/frontend/.env.local   # si no existe

docker compose up -d --build
```

- `frontend` → http://localhost:3004
- `backend` → http://localhost:3001
- `postgres` → publicado en `localhost:5434` solo para conectar un cliente de
  GUI (psql, DBeaver...); el backend lo alcanza por el nombre del servicio
  (`postgres`) en la red interna de compose.

```bash
docker compose logs -f backend
docker compose down          # detiene los contenedores, conserva el volumen pgdata
docker compose down -v       # además borra los datos de Postgres
```

No es obligatorio usar Docker en local: `bun install` + `bun run dev` (ver
[packages/docs/contributing.md](packages/docs/contributing.md)) siguen
funcionando corriendo Bun directo en el host, apuntando a cualquier Postgres
que tengas corriendo en `localhost:5434` (o el que pongas en
`apps/backend/.env.local`).

## 1. Preparar el servidor (una sola vez)

Postgres en el servidor es **externo**: un contenedor que ya existe (gestiona
otro proyecto, `elineas`), alcanzado por nombre sobre la red
`elineas_default` — igual que consumen `elineas-monorepo` y `elineas-auth`.
Este compose no lo crea ni lo administra.

```bash
git clone <tu-remoto> /srv/elineas-control-asistencia
cd /srv/elineas-control-asistencia

# La red la crea el compose del proyecto `elineas`; aquí solo se comprueba
# que exista.
docker network inspect elineas_default >/dev/null || echo "FALTA elineas_default"

# Esta app tiene su propia base en ese Postgres — créala una sola vez:
docker exec -it <nombre-del-contenedor-postgres> \
  psql -U <usuario-real> -c 'CREATE DATABASE "elineas_control_asistencia";'
# Las tablas las crea Drizzle (bun run db:push / db:migrate, ver más abajo).

# El .env NO se clona (está en .gitignore) — créalo a mano desde la plantilla.
cp .env.example .env
cp apps/backend/.env.production.example apps/backend/.env.production
# Edita ambos:
#   .env                         → POSTGRES_HOST/PORT/USER/PASSWORD (los
#                                   reales del contenedor existente),
#                                   VITE_BACKEND_URL (URL pública del backend).
#   apps/backend/.env.production → BETTER_AUTH_URL, FRONTEND_URL,
#                                   BETTER_AUTH_SECRET.

docker compose -f docker-compose.prod.yml up -d --build
```

Los puertos se publican solo en `127.0.0.1` (ver `docker-compose.prod.yml`):
pon un reverse proxy con TLS delante (Caddy, nginx...) para exponerlos al
exterior.

## 2. Desplegar cambios

```bash
cd /srv/elineas-control-asistencia
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Reconstruye y reinicia ambos servicios. Para tocar solo uno:

```bash
docker compose -f docker-compose.prod.yml up -d --build backend
docker compose -f docker-compose.prod.yml up -d --build frontend
```

El contexto de build sigue siendo la raíz del monorepo en ambos casos (las
imágenes necesitan `packages/`), pero Docker cachea por capas: si
`packages/` no cambió, esas capas no se reconstruyen aunque el contexto sea
el mismo.

> `frontend` incrusta `VITE_BACKEND_URL` en su bundle en build-time: si ese
> valor cambia, hay que reconstruir la imagen de `frontend` explícitamente
> (no basta con reiniciar el contenedor).

## 3. Migraciones de base de datos

La imagen de producción del backend no lleva `drizzle-kit` (es
`devDependency`, y `prod` instala solo con `--production`): las migraciones
no corren dentro del contenedor de prod. Apunta tu Bun local al Postgres del
servidor y corre el comando desde ahí:

```bash
DATABASE_URL=postgres://<usuario>:<password>@<host-o-túnel>:5432/elineas_control_asistencia \
  bun run --filter backend db:push
```

(Si el servidor no es alcanzable directo, abre un túnel SSH al puerto de
Postgres y apunta `DATABASE_URL` a `localhost:<puerto-del-túnel>`.)

## 4. Comandos del día a día

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml down   # detiene los dos servicios propios; no toca el Postgres externo
```
