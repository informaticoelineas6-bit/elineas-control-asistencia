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
#   apps/backend/.env.production → AUTH_API_URL, SYSTEM_SLUG, FRONTEND_URL.
#                                   Ese FRONTEND_URL debe estar además dado de
#                                   alta en ALLOWED_ORIGIN del Identity Server.

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

## 4. El corte desde el legacy (una sola vez)

El procedimiento completo y sus decisiones están en la
[spec 21](packages/specs/21-migracion-desde-legacy.md) y en la
[spec 00 Parte B](packages/specs/00-migracion-datos-e-identidad.md). Aquí está lo
que se teclea.

Son **tres comandos** (spec 00 RN-00.23) y **dos etapas**, y el orden importa:
`extract` es lo único que toca el legacy, así que la ventana contra el sistema
que se apaga es de minutos; `load` y `verify` trabajan ya sobre la copia y se
pueden repetir todas las veces que haga falta.

```bash
# 0 · Antes de nada: la copia de seguridad de la que se puede volver.
pg_dump "$DATABASE_URL" > antes-del-corte-$(date +%F).sql

# 1 · Traer el origen tal cual, al esquema `legacy` de nuestra base.
LEGACY_DATABASE_URL="postgres://…supabase…"   bun run migrate:legacy extract

# 2 · Simular. Esto NO escribe: es el informe que hay que leer entero.
IDENTITY_MAP=./identidades.json   bun run migrate:legacy load

# 3 · Cargar de verdad, cuando la simulación cuadre.
IDENTITY_MAP=./identidades.json   bun run migrate:legacy load --commit

# 4 · Cuadrar conteos y sumas.
bun run migrate:legacy verify

# 5 · Recalcular los hechos diarios del histórico, o la reportería no ve lo
#     migrado (spec 16 RN-16.9). Desde el panel de superadmin o por API.
```

`IDENTITY_MAP` es el archivo que empareja **cada correo del legacy con su
identidad del Identity Server** — lo que sale del alta masiva—, en CSV
(`correo,identificador`) o JSON (`[{"email":…,"identityUserId":…}]`). Sin él
`load` no arranca, y con un correo de menos **se detiene antes de escribir**: un
perfil sin identidad es alguien que no puede entrar el lunes.

> ⚠️ **El ensayo es obligatorio** (spec 00 RN-00.25): esto se corre primero
> contra una copia. La carga es repetible —los identificadores se conservan y
> todo va con `on conflict do nothing`— así que ensayarla no cuesta nada, y es la
> única forma de que el día del corte no haya sorpresas.
>
> Lo que **ningún comando puede comprobar** es el criterio más importante de la
> §9 de esa spec: que el reporte mensual de un mes cerrado salga idéntico celda a
> celda en los dos sistemas. Eso se hace a mano, con los dos vivos, **antes** de
> apagar el legacy.

## 5. Comandos del día a día

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml down   # detiene los dos servicios propios; no toca el Postgres externo
```
