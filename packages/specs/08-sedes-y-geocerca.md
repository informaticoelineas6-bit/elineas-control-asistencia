# 08 · Sedes, geocerca y geolocalización

> **Origen:** `old-docs.md` §3.3, puntos 21, 22, 23, 24, 25, 77.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con deuda en el seguimiento en segundo plano de Android.
> **Estado en el monorepo nuevo:** ✅ implementado, salvo el seguimiento en segundo plano
> (§4), que es de la [20](./20-app-movil-y-distribucion.md). Tabla `work_locations` y columna
> `profiles.selected_work_location_id`; geometría compartida (Haversine y veredicto de una
> geocerca) en `packages/validations/src/locations.ts`; **la función pura de decisión** en
> `apps/backend/src/services/location-rules.ts`; lecturas y escrituras en
> `apps/backend/src/services/locations.ts` y `apps/backend/src/routes/locations.ts`;
> `GET`/`PUT /api/me/work-location` y `POST /api/me/location-check` en
> `apps/backend/src/routes/me.ts`. En la interfaz: capa de ubicación del cliente en
> `apps/frontend/src/modules/geolocation/`, mapa sobre Leaflet en
> `apps/frontend/src/components/ui/map.tsx`, pestaña *Sedes y geocerca* de Configuración en
> `apps/frontend/src/modules/locations/`, tarjeta *Mi sede de trabajo* en el perfil propio y
> pantalla de diagnóstico en `/gps`. Pruebas:
> `apps/backend/src/services/location-rules.test.ts` (unitarias, 25 casos) y
> `apps/backend/src/routes/locations.test.ts` (integración, 27). Las cuatro decisiones de la §9
> están cerradas.
> **Depende de:** [06-configuracion-global](./06-configuracion-global.md), [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).
> **Habilita:** [09-marcaje-asistencia](./09-marcaje-asistencia.md) — sin esto no hay validación de ubicación.

---

## 1. Objetivo

Definir **dónde** se puede marcar: una o varias sedes, cada una con su geocerca circular
(centro + radio) y su umbral de precisión GPS aceptable. Y proveer la capa de ubicación del
cliente (web y nativo) que alimenta esa validación.

## 2. Modelo de datos

### `work_locations` (modelo vigente)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | Nombre visible de la sede |
| `center_lat` / `center_lng` | double | Centro de la geocerca |
| `radius_meters` | int | Radio permitido |
| `accuracy_threshold` | int (metros) | Precisión GPS mínima aceptable |
| `block_on_poor_accuracy` | boolean | Si `true`, precisión peor que el umbral **bloquea**; si `false`, sólo advierte |
| `is_active` | boolean | |
| `created_at` / `updated_at` | timestamptz | |

### `profiles.selected_work_location_id` — **añadido en la implementación**

La sede que cada persona tiene elegida (RN-08.5), como columna nullable con clave ajena a
`work_locations` y `on delete set null`. Es la decisión 2 de la §9: la selección deja de ser
sólo estado del dispositivo. Lo que se gana es concreto — sobrevive al cambio de teléfono, y
**el servidor** puede invalidarla al desactivar la sede (RN-08.6) en vez de esperar a que el
cliente se dé cuenta en la puerta— y lo que se conserva también: sigue siendo por persona, así
que dos operarios que comparten terminal no heredan la del otro (RN-08.8).

### `geofence_config` — **legacy, no reimplementar**

Tabla de geocerca única del diseño original. En el legacy sobrevivía como *fallback* con
migración automática a `work_locations` la primera vez que se abría el administrador de sedes.

> **Decisión para el monorepo:** no portar esta tabla. Si hay datos que migrar, se migran una
> sola vez en el script de migración de datos y se descarta. Ver
> [21-migracion-desde-legacy](./21-migracion-desde-legacy.md).

## 3. Reglas de negocio

- **RN-08.1 — Geocerca circular.** La pertenencia se calcula con distancia Haversine entre el
  punto reportado y el centro de la sede; dentro si `distancia ≤ radius_meters`.
  No hay polígonos. *Limitación aceptada.*
- **RN-08.2 — El servidor recalcula.** La distancia que envía el cliente es informativa; el
  backend **siempre** recalcula a partir de lat/lng recibidos. Nunca se confía en un
  `inside_geofence` calculado en cliente.
- **RN-08.3 — Precisión GPS.** Si `accuracy > accuracy_threshold`:
  - con `block_on_poor_accuracy = true` → se rechaza el marcaje;
  - con `false` → se acepta pero se registra la precisión para auditoría.

  > **Orden respecto a la geocerca.** La [09](./09-marcaje-asistencia.md) RN-09.6 enumera
  > primero la geocerca y luego la precisión; la implementación juzga **la precisión antes**.
  > Cuando las dos fallan el resultado es el mismo —las dos bloquean—, así que lo único que
  > cambia es el mensaje: decirle "estás a 180 m" a alguien cuyo GPS reporta ±300 m es
  > exactamente el reclamo que la pantalla de diagnóstico (§6) existe para resolver. Al revés
  > no hay pérdida: con la precisión buena, el motivo sigue siendo la geocerca.
  >
  > El default de una sede nueva es `block_on_poor_accuracy = false`: una sede recién creada no
  > debe dejar a nadie sin marcar por un umbral que todavía no se calibró con los teléfonos que
  > hay en planta. Endurecerlo es un interruptor; descubrirlo es un turno perdido.
- **RN-08.4 — Múltiples sedes activas.** Puede haber N sedes activas simultáneamente. Cada
  una con radio y umbral propios.
- **RN-08.5 — Sede de la sesión.** El marcaje se valida contra **la sede seleccionada por el
  usuario**, no contra "la más cercana". Si está fuera de esa geocerca, se rechaza aunque
  esté dentro de otra. *Comportamiento heredado explícito.* **Decidido: se mantiene** (§9.1) —
  validar contra cualquier sede activa dejaría marcar desde la sede que no toca y convertiría
  la selección en un adorno.
  Con una vuelta de tuerca en el rechazo: **el mensaje dice si hay otra sede activa en cuya
  geocerca sí estás**, con su nombre y su distancia ("Sí estás dentro de Sede Norte: si hoy
  trabajas ahí, cámbiala en tu perfil"). La regla sigue siendo estricta; lo que deja de ser
  estricto es el callejón sin salida.
- **RN-08.6 — Sede inactiva.** Si la sede seleccionada se desactiva, la selección guardada
  deja de ser válida y se vuelve a pedir.
- **RN-08.7 — Selección obligatoria al iniciar sesión.** Todo rol que marque debe elegir sede
  antes de operar. `global_manager` queda exento (no marca).

  > **Corrección respecto al texto original**, que exentaba también a `superadmin`. En la
  > [03](./03-roles-y-autorizacion.md) §2 el `superadmin` hereda todo lo anterior y RN-03.4
  > excluye del marcaje **sólo** al `global_manager`; es el criterio que aplica el resto del
  > código (`ROLES_THAT_DO_NOT_MARK` en `packages/validations/src/roles.ts`, usado por el menú,
  > por la validación horaria y por `required` en `GET /me/work-location`). Mantener aquí una
  > lista distinta era la clase de discrepancia que acaba en un rol que no puede marcar sin que
  > nadie sepa por qué.

  El bloqueo *al iniciar sesión* llega con la pantalla de marcaje ([09](./09-marcaje-asistencia.md));
  hoy el servidor ya rechaza el marcaje sin sede con `INVALID_LOCATION` y la interfaz lo
  reclama en el perfil con un badge.
- **RN-08.8 — Persistencia de la selección.** Se guarda localmente **por usuario** (no global
  del dispositivo: dos personas pueden compartir un terminal). Se limpia al cerrar sesión
  ([04](./04-autenticacion.md) RN-04.8).
- **RN-08.9 — Permisos denegados.** Si el usuario niega el permiso de ubicación, no se puede
  marcar; la UI debe explicar cómo reactivarlo por plataforma, no sólo decir "error".
- **RN-08.10 — Eliminar una sede** con marcajes históricos asociados no está permitido; se
  desactiva (`is_active = false`). **Implementado sin borrado en absoluto**: no hay `DELETE` en
  la API. Mientras no exista `attendance_marks` no se puede saber si una sede tiene historial, y
  una sede sin él se arregla editándola. Cuando llegue la [09](./09-marcaje-asistencia.md) se
  podrá añadir un borrado condicionado a no tener marcajes, si de verdad hace falta.
- **RN-08.11 — Nombres únicos.** *(Añadida en la implementación.)* Dos sedes con el mismo
  nombre son indistinguibles en el selector que alguien usa antes de marcar. La unicidad la
  garantiza la base con un índice sobre `lower(name)`, igual que los departamentos (RN-01.1).

## 4. Capa de ubicación en cliente

Abstracción única sobre dos runtimes:

| | Web | Nativo (Capacitor) |
|---|---|---|
| Lectura puntual | `navigator.geolocation.getCurrentPosition` | plugin de geolocalización |
| Seguimiento | `watchPosition` | plugin, ídem |
| Permisos | prompt del navegador | permisos Android foreground/background |

Expone: `getCurrentPosition()`, `watch(cb)`, `stop()`, `permissionState`, y utilidades de
distancia (Haversine).

**Implementada** en `apps/frontend/src/modules/geolocation/`: `location-layer.ts` (las cuatro
funciones, con mensajes de error en español y accionables — RN-08.9) y `use-position.ts` (el
hook de React). La geometría **no** está aquí: vive en `@elineas/validations` porque la comparte
el servidor, que es quien decide (RN-08.2).

Tres decisiones de esa capa que conviene conocer:

- **La interfaz del módulo no menciona `navigator`.** Cuando exista el plugin nativo
  ([20](./20-app-movil-y-distribucion.md)) se cambia la implementación de esas cuatro funciones
  y nada más del proyecto se toca.
- **No lee al montar.** Encender el GPS es una acción del usuario: una pantalla que pide
  ubicación sola en cuanto se abre enseña el diálogo del permiso en el peor momento —cuando
  nadie sabe todavía para qué—, que es cuando se deniega y ya no se puede volver a pedir.
- **`enableHighAccuracy: true` y `maximumAge: 0`.** Lo primero enciende el GPS de verdad en vez
  de resolver por red (dentro de una nave, la diferencia entre 20 m y 2 km); lo segundo evita que
  el navegador devuelva la lectura de esta mañana para decidir un marcaje de ahora.

> ⚠️ **Deuda heredada (punto 77):** el seguimiento en segundo plano en Android usa
> `watchPosition` como sustituto, **no un servicio nativo real**. Android mata el proceso y
> el seguimiento se corta. Esto sólo importa si se implementa la salida automática por
> abandono de geocerca ([09](./09-marcaje-asistencia.md) RN-09.13, modo `geofence_exit`):
> **ese modo no es fiable hoy.** Decidir antes de ofrecerlo.
>
> **Decidido (§9.4):** el modo se mantiene en la configuración **con advertencia visible** —en
> el propio selector de la pestaña *General* y en la de *Sedes*— y aquí sólo se construye
> seguimiento **en primer plano**, que es lo que necesitan el diagnóstico y el marcaje. El
> cierre automático de jornada es de la [09](./09-marcaje-asistencia.md) y el servicio nativo
> de la [20](./20-app-movil-y-distribucion.md): la decisión de ofrecerlo de verdad se toma con
> esas dos delante, no antes.

## 5. Administración de sedes

- CRUD de sedes (rol administrativo).
- **Selector de ubicación en mapa**: el legacy implementó un mini-mapa a mano con tiles de
  OpenStreetMap, sin librería de mapas, para no cargar una dependencia pesada.
  **Decidido: Leaflet** (§9.3) con los mismos mosaicos de OpenStreetMap, sin `react-leaflet` —un
  envoltorio propio de un fichero, `components/ui/map.tsx`—. Pesa ~42 KB comprimidos y trae
  resuelto el paneo, el zoom, el marcador arrastrable y el círculo en metros: justo la parte que
  decide si alguien puede marcar y la que no conviene reinventar a mano.
- Previsualización del radio sobre el mapa y captura de coordenadas por clic o pegando
  lat/lng. **Implementado**, y con las tres salvaguardas que hacían falta:
  - **el mapa se carga sólo en el cliente** (`import()` dentro de un efecto: Leaflet toca
    `window` al importarse y esta aplicación hace SSR);
  - **degrada si no hay mosaicos** —sin conexión o con el dominio de OSM bloqueado— avisando y
    dejando las coordenadas editables a mano, en vez de quedarse en gris como si fuera una
    avería;
  - **no usa los iconos de Leaflet**, que son imágenes con rutas relativas que se rompen al
    empaquetar: el marcador es HTML propio.
- Sin acción de eliminar (RN-08.10), y con **mapa de conjunto de las sedes activas**: con tres
  sedes en la misma ciudad, ver los círculos juntos es la única forma de notar que dos se
  solapan — y en la zona común, quien tenga elegida la otra sede no podrá marcar (RN-08.5).

## 6. Diagnóstico GPS

Pantalla de soporte (rol: cualquiera, útil para el jefe en planta) que muestra:
estado del permiso, proveedor, última lectura (lat/lng/precisión/antigüedad), sede
seleccionada, distancia al centro y veredicto ("dentro / fuera por N m").

Sirve para resolver el reclamo más común: *"la app dice que estoy fuera y estoy dentro"*.

**Implementada** en `/gps` (*Diagnóstico GPS*, en el grupo Personal del menú, visible para
cualquier rol: quien la usa de verdad es el jefe en planta con el teléfono de otro en la mano).
Muestra permiso, origen de la lectura, coordenadas, precisión, antigüedad, sede seleccionada con
su radio y su umbral, distancia al centro, veredicto, la lista de **todas** las sedes activas por
distancia y un mapa con la geocerca y el círculo de error del GPS.

Dos añadidos que la hacen útil de verdad:

- **El veredicto lo da el servidor**, no la pantalla: `POST /api/me/location-check` manda
  lat/lng y precisión y devuelve lo que el backend concluye (RN-08.2). Sin eso, la pantalla
  respondería con la misma cuenta del cliente que está en duda.
- **Botón de copiar el diagnóstico** al portapapeles, en texto plano. El reclamo llega por
  mensaje, y lo que hace falta al otro lado es exactamente eso.

## 7. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/work-locations` | autenticado — sólo activas |
| `GET` | `/work-locations?includeInactive=true` | global_manager — sustituye a `/all` |
| `POST` | `/work-locations` | global_manager |
| `PATCH` | `/work-locations/:id` | global_manager |
| `POST` | `/work-locations/:id/deactivate` | global_manager |
| `POST` | `/work-locations/:id/reactivate` | global_manager — **añadido** |
| `GET` | `/me/work-location` | autenticado — su sede y si le hace falta tenerla |
| `PUT` | `/me/work-location` | autenticado — body `{ workLocationId }`, nulo para quitarla |
| `POST` | `/me/location-check` | autenticado — veredicto del servidor para una lectura (§6) |

Cuatro notas sobre esta tabla:

- **`?includeInactive=` en vez de `/work-locations/all`**: es la forma que ya usa la
  [01](./01-organizacion-departamentos.md) (`/departments?includePaused=`), y un path por
  variante de filtro se multiplica en cuanto aparece el segundo. El parámetro **sube el rol
  exigido**: con él, `global_manager`.
- **`reactivate` es necesario**, no un extra: desactivar sin poder deshacerlo, en un recurso que
  además no se borra nunca (RN-08.10), deja una sede apagada por error apagada para siempre.
- **La sede seleccionada sí es recurso de servidor** (decisión 2 de la §9): vive en el perfil, y
  el cliente guarda una copia local que es **caché, no la verdad** — indexada por usuario y
  borrada al cerrar sesión ([04](./04-autenticacion.md) RN-04.8). El `work_location_id` sigue
  viajando en cada marcaje y el servidor exige que coincida con el del perfil
  ([09](./09-marcaje-asistencia.md) RN-09.6).
- **`/me/location-check` no escribe nada.** No es un marcaje: es la consulta del diagnóstico, y
  su cuerpo sólo admite lat/lng y precisión — ni distancia ni `insideGeofence` calculados fuera
  (RN-08.2).

## 8. Criterios de aceptación

- [x] Con lat/lng a `radius_meters + 1` del centro, el marcaje se rechaza.
- [x] Un cliente que envía `inside_geofence: true` con coordenadas fuera es rechazado igual — el
      campo ni existe en el esquema, y el veredicto sale de recalcular la distancia.
- [x] Con `block_on_poor_accuracy = false` y precisión mala, el marcaje entra y guarda la
      precisión (`accuracyOk: false` en el veredicto; la columna del marcaje llega con la
      [09](./09-marcaje-asistencia.md)).
- [x] Al desactivar la sede seleccionada, el usuario vuelve a ver el selector — y además recibe
      una notificación, porque enterarse en la puerta no sirve.
- [x] La sede seleccionada por el usuario A no se aplica al usuario B en el mismo dispositivo.
- [x] Con permiso denegado, la pantalla explica cómo reactivarlo en Android y en navegador
      (`modules/geolocation/permission-help.tsx`, con instrucciones por plataforma).

## 9. Decisiones (cerradas)

1. ~~¿Validar contra la sede elegida o contra cualquier activa?~~ **Contra la elegida**
   (RN-08.5), con el rechazo diciendo si hay otra en rango. Estricto y predecible, sin el hueco
   de marcar desde la sede que no toca, y sin dejar a nadie sin salida.
2. ~~¿Persistir la sede en el perfil?~~ **Sí**, con caché local. La invalidación de RN-08.6 pasa
   a ser del servidor, que es quien sabe cuándo se desactiva una sede.
3. ~~¿Mapa a mano o librería?~~ **Leaflet** con mosaicos de OSM, sin `react-leaflet`. El círculo
   en metros y el marcador arrastrable son la parte que decide marcajes: no se reinventan.
4. ~~¿Se ofrece el modo de salida por geocerca?~~ **Se mantiene con advertencia visible**, y no
   se construye seguimiento en segundo plano aquí. Esa pieza es de la
   [20](./20-app-movil-y-distribucion.md) y el cierre automático, de la
   [09](./09-marcaje-asistencia.md).

Queda por decidir, y no bloquea nada de esta spec:

- **Si una sede debe poder borrarse** cuando no tiene ningún marcaje detrás (RN-08.10), una vez
  exista `attendance_marks`. Hoy sólo se desactiva.
- **Si el umbral de precisión debería tener un default de empresa** en la configuración global
  ([06](./06-configuracion-global.md)) en vez de fijarse sede a sede. Con una sola sede es lo
  mismo; con diez, repetir el número diez veces es una invitación a que divergan.
