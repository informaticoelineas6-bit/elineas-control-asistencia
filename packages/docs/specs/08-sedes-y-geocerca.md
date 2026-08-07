# 08 · Sedes, geocerca y geolocalización

> **Origen:** `old-docs.md` §3.3, puntos 21, 22, 23, 24, 25, 77.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con deuda en el seguimiento en segundo plano de Android.
> **Estado en el monorepo nuevo:** ❌ no existe.
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
- **RN-08.4 — Múltiples sedes activas.** Puede haber N sedes activas simultáneamente. Cada
  una con radio y umbral propios.
- **RN-08.5 — Sede de la sesión.** El marcaje se valida contra **la sede seleccionada por el
  usuario**, no contra "la más cercana". Si está fuera de esa geocerca, se rechaza aunque
  esté dentro de otra. *Comportamiento heredado explícito.* **Decisión abierta:** ¿debería
  validar contra cualquier sede activa y registrar cuál?
- **RN-08.6 — Sede inactiva.** Si la sede seleccionada se desactiva, la selección guardada
  deja de ser válida y se vuelve a pedir.
- **RN-08.7 — Selección obligatoria al iniciar sesión.** Todo rol que marque debe elegir sede
  antes de operar. `global_manager` y `superadmin` quedan exentos (no marcan).
- **RN-08.8 — Persistencia de la selección.** Se guarda localmente **por usuario** (no global
  del dispositivo: dos personas pueden compartir un terminal). Se limpia al cerrar sesión
  ([04](./04-autenticacion.md) RN-04.8).
- **RN-08.9 — Permisos denegados.** Si el usuario niega el permiso de ubicación, no se puede
  marcar; la UI debe explicar cómo reactivarlo por plataforma, no sólo decir "error".
- **RN-08.10 — Eliminar una sede** con marcajes históricos asociados no está permitido; se
  desactiva (`is_active = false`).

## 4. Capa de ubicación en cliente

Abstracción única sobre dos runtimes:

| | Web | Nativo (Capacitor) |
|---|---|---|
| Lectura puntual | `navigator.geolocation.getCurrentPosition` | plugin de geolocalización |
| Seguimiento | `watchPosition` | plugin, ídem |
| Permisos | prompt del navegador | permisos Android foreground/background |

Expone: `getCurrentPosition()`, `watch(cb)`, `stop()`, `permissionState`, y utilidades de
distancia (Haversine).

> ⚠️ **Deuda heredada (punto 77):** el seguimiento en segundo plano en Android usa
> `watchPosition` como sustituto, **no un servicio nativo real**. Android mata el proceso y
> el seguimiento se corta. Esto sólo importa si se implementa la salida automática por
> abandono de geocerca ([09](./09-marcaje-asistencia.md) RN-09.13, modo `geofence_exit`):
> **ese modo no es fiable hoy.** Decidir antes de ofrecerlo.

## 5. Administración de sedes

- CRUD de sedes (rol administrativo).
- **Selector de ubicación en mapa**: el legacy implementó un mini-mapa a mano con tiles de
  OpenStreetMap, sin librería de mapas, para no cargar una dependencia pesada.
  **Decisión abierta:** ¿se repite ese enfoque o se adopta una librería (MapLibre/Leaflet)?
- Previsualización del radio sobre el mapa y captura de coordenadas por clic o pegando
  lat/lng.

## 6. Diagnóstico GPS

Pantalla de soporte (rol: cualquiera, útil para el jefe en planta) que muestra:
estado del permiso, proveedor, última lectura (lat/lng/precisión/antigüedad), sede
seleccionada, distancia al centro y veredicto ("dentro / fuera por N m").

Sirve para resolver el reclamo más común: *"la app dice que estoy fuera y estoy dentro"*.

## 7. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/work-locations` | autenticado — sólo activas |
| `GET` | `/work-locations/all` | global_manager |
| `POST` | `/work-locations` | global_manager |
| `PATCH` | `/work-locations/:id` | global_manager |
| `POST` | `/work-locations/:id/deactivate` | global_manager |

La sede seleccionada **no** viaja como recurso de servidor: es estado local del cliente que
se envía en cada marcaje (`work_location_id`) y el servidor valida que sea activa.
**Decisión abierta:** ¿guardarla en el perfil para que sea consistente entre dispositivos?

## 8. Criterios de aceptación

- [ ] Con lat/lng a `radius_meters + 1` del centro, el marcaje se rechaza.
- [ ] Un cliente que envía `inside_geofence: true` con coordenadas fuera es rechazado igual.
- [ ] Con `block_on_poor_accuracy = false` y precisión mala, el marcaje entra y guarda la precisión.
- [ ] Al desactivar la sede seleccionada, el usuario vuelve a ver el selector.
- [ ] La sede seleccionada por el usuario A no se aplica al usuario B en el mismo dispositivo.
- [ ] Con permiso denegado, la pantalla explica cómo reactivarlo en Android y en navegador.

## 9. Decisiones abiertas

1. ¿Validar contra la sede elegida (RN-08.5) o contra cualquier sede activa?
2. ¿Persistir la sede en el perfil en vez de sólo localmente?
3. ¿Mapa hecho a mano o librería?
4. ¿Se ofrece el modo de salida por geocerca sabiendo que el seguimiento en segundo plano no
   es fiable? (§4)
