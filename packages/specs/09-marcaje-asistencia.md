# 09 · Marcaje de asistencia (núcleo del producto)

> **Origen:** `old-docs.md` §3.4, puntos 26–32, 40.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe, **salvo la parte horaria de su validación**, que
> es de la [07](./07-horarios-y-calendario.md) §4 y ya está construida y probada:
> `validateMarkTime` en `apps/backend/src/services/schedule-rules.ts` resuelve rol, pausa,
> horario, calendario, descansos (por predicado), ventana y tardanza, y devuelve el día laboral
> al que pertenece la marca. El enum de motivos de rechazo de §6 existe en
> `packages/validations/src/attendance.ts`.
> **Y la parte de ubicación**, que es de la [08](./08-sedes-y-geocerca.md):
> `validateMarkLocation` en `apps/backend/src/services/location-rules.ts` resuelve sede elegida,
> sede activa, geocerca recalculada en servidor y umbral de precisión, y devuelve distancia,
> pertenencia y las sedes cercanas para poder explicar el rechazo. Del enum de motivos de §6
> existen **nueve de los catorce** (`ROLE_CANNOT_MARK`, `DEPARTMENT_PAUSED`, `NO_SCHEDULE`,
> `NOT_WORKDAY`, `REST_DAY`, `OUTSIDE_TIME_WINDOW`, `INVALID_LOCATION`, `OUTSIDE_GEOFENCE`,
> `POOR_GPS_ACCURACY`); los cinco restantes —sesión, cuenta inactiva, vacaciones, duplicado y
> secuencia— se añaden al construir esta spec.
> Lo que falta aquí es, literalmente, **escribir**: la tabla `attendance_marks`, el handler que
> compone las dos funciones puras con vacaciones y antirrebote, y las pantallas.
> **Depende de:** [07-horarios-y-calendario](./07-horarios-y-calendario.md), [08-sedes-y-geocerca](./08-sedes-y-geocerca.md), [10-descansos](./10-descansos.md), [11-vacaciones](./11-vacaciones.md).
> **Habilita:** [15-paneles-y-dashboard](./15-paneles-y-dashboard.md), [16-reporteria-mensual](./16-reporteria-mensual.md), [11-vacaciones](./11-vacaciones.md) (días trabajados).

---

## 1. Objetivo

Registrar la entrada y la salida de una persona, con evidencia de ubicación, sólo cuando se
cumplen todas las reglas de rol, departamento, horario, calendario, descanso, vacaciones y
geocerca. **Es la única escritura crítica del sistema**: todo lo demás lee de aquí.

## 2. Modelo de datos

### `attendance_marks`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `mark_type` | enum `IN` / `OUT` | |
| `timestamp` | timestamptz | Instante del marcaje **según el servidor**, no el cliente |
| `latitude` / `longitude` | double | Reportadas por el dispositivo |
| `accuracy` | double (metros) | Precisión reportada |
| `distance_to_center` | double (metros) | **Recalculada en servidor** |
| `inside_geofence` | boolean | **Recalculada en servidor** |
| `work_location_id` | uuid FK → `work_locations` | Sede contra la que se validó |
| `blocked` | boolean | Si se registró un intento rechazado |
| `block_reason` | text, nullable | Motivo del rechazo |
| `created_at` | timestamptz | |

**Índices necesarios:** (`user_id`, `timestamp`), (`timestamp`), y uno por departamento vía
join con `profiles` — evaluar denormalizar `department_id` para la reportería.

> **Sobre `blocked`:** el legacy guarda también los intentos fallidos. Es valioso para
> soporte ("intenté marcar 4 veces y no me dejó") y para las incidencias. **Confirmar** si
> se guardan todos los rechazos o sólo algunos tipos, porque afecta el volumen de la tabla.

## 3. Reglas de negocio

### Validación (orden exacto, falla al primero)

- **RN-09.1 — Sesión válida.** Usuario autenticado y activo (`is_active`).
- **RN-09.2 — Vacaciones.** Si tiene una solicitud de vacaciones **aprobada y vigente** que
  cubre la fecha, se rechaza ([11-vacaciones](./11-vacaciones.md) RN-11.9).
- **RN-09.3 — Rol.** `global_manager` (y `superadmin` actuando como tal) no marcan.
- **RN-09.4 — Departamento.** Debe existir, no estar en pausa (RN-01.4) y tener horario
  configurado.
- **RN-09.5 — Ventana horaria y calendario.** Según
  [07-horarios-y-calendario](./07-horarios-y-calendario.md) §4.
- **RN-09.6 — Sede.** `work_location_id` enviado debe existir, estar activo y ser el que el
  usuario tiene seleccionado. Luego: geocerca recalculada en servidor (RN-08.2) y umbral de
  precisión (RN-08.3).
- **RN-09.7 — Tardanza.** Si es `IN` y la hora supera `checkin_start_time + tolerancia`, el
  marcaje **se acepta** y se etiqueta como tarde, con los minutos de retraso. Tardanza nunca
  bloquea.
- **RN-09.8 — Sólo entonces se inserta.**

### Secuencia y duplicados

- **RN-09.9 — Alternancia.** No se aceptan dos `IN` seguidos sin `OUT` intermedio en el mismo
  día laboral, ni un `OUT` sin `IN` previo. *Verificar si el legacy lo impone o lo tolera.*
  **Decisión abierta.**
- **RN-09.10 — Antirrebote.** Dos marcajes idénticos en menos de N segundos se tratan como
  uno (doble toque, reintento de red). Proponer N = 30 s e idempotencia por
  (`user_id`, `mark_type`, minuto).
- **RN-09.11 — El instante lo pone el servidor.** El cliente no envía la hora. Evita
  manipulación por reloj del dispositivo.
- **RN-09.12 — Sin edición.** Un marcaje no se edita ni se borra desde la aplicación. Las
  correcciones pasan por [12-incidencias](./12-incidencias.md). El único borrado posible es
  administrativo y queda en bitácora.

### Modo de salida (`attendance_checkout_mode`)

- **RN-09.13** — Tres modos configurables globalmente ([06](./06-configuracion-global.md) §3.2):
  - `manual` — la persona marca su salida. *Default.*
  - `schedule` — a la hora de `attendance_auto_checkout_time` se cierra automáticamente la
    jornada de quien tenga un `IN` abierto. Requiere un proceso programado.
  - `geofence_exit` — si el dispositivo sale de la geocerca y no vuelve en
    `attendance_geofence_exit_minutes`, se registra la salida.
    ⚠️ **No fiable hoy**: depende del seguimiento en segundo plano de Android, que es un
    sustituto y no un servicio nativo ([08](./08-sedes-y-geocerca.md) §4).
- **RN-09.14** — Un `OUT` automático debe distinguirse de uno manual en el registro.
  *El legacy no tiene un campo para esto* — **proponer** `source` enum `manual|auto_schedule|auto_geofence|import`.

## 4. Arquitectura de la validación

En el legacy hay **dos capas**: una función SQL (`validate_attendance_mark`, reglas de rol/
departamento/horario) y una edge function (sesión, vacaciones, sede, geocerca, precisión)
que es la **puerta única de escritura**.

**Propuesta para el monorepo:**

- Una sola función de dominio pura en el backend, `validateAttendanceMark(input): Result`,
  sin acceso a base — recibe todo el contexto ya cargado.
- Un handler `POST /attendance/marks` que carga contexto, llama a la función pura, y escribe.
- **Cero escrituras a `attendance_marks` fuera de ese handler** (excepto la importación
  histórica, ver [19-panel-superadmin](./19-panel-superadmin.md)).
- La función pura es la unidad de test más importante del sistema.

## 5. UI

### Pantalla de marcaje (empleado, móvil)

- Estado grande y legible: "Dentro de la geocerca · 23 m del centro" / "Fuera · 180 m".
- Botón único que alterna entre *Marcar entrada* y *Marcar salida* según el estado del día.
- Marcas de hoy, en orden, con hora y sede.
- Estado de permiso y precisión GPS visible **antes** de intentar marcar, no como error
  después.
- Feedback inmediato: el botón bloquea mientras la petición está en vuelo (evita el doble
  toque de RN-09.10).
- Mensaje de rechazo **accionable**: qué falló y qué hacer ("Estás a 180 m de Sede Central.
  Acércate o reporta una incidencia").

### Historial propio

- **Mi semana** (móvil): los 7 días, con estado por día y horas de entrada/salida.
- **Historial** (escritorio): rango de fechas, filtros, estado por día, exportable.
- Ambos usan la misma agregación diaria de [15-paneles-y-dashboard](./15-paneles-y-dashboard.md).

## 6. API propuesta

| Método | Path | Descripción |
|---|---|---|
| `POST` | `/attendance/marks` | Body: `{ markType, latitude, longitude, accuracy, workLocationId }`. Devuelve la marca creada o el rechazo tipado |
| `GET` | `/attendance/marks/today` | Marcas de hoy del usuario |
| `GET` | `/attendance/me?from=&to=` | Historial propio agregado por día |
| `GET` | `/attendance/status` | Qué puede hacer ahora: `can_check_in` / `can_check_out` / `blocked` + motivo |

`GET /attendance/status` es importante: permite que la UI muestre el estado correcto **sin**
intentar marcar y fallar.

### Rechazos tipados

Los motivos de rechazo deben ser un enum compartido en `packages/validations`, no cadenas
libres — la UI necesita reaccionar distinto a cada uno:

`NOT_AUTHENTICATED` · `INACTIVE_ACCOUNT` · `ON_VACATION` · `ROLE_CANNOT_MARK` ·
`DEPARTMENT_PAUSED` · `NO_SCHEDULE` · `NOT_WORKDAY` · `REST_DAY` · `OUTSIDE_TIME_WINDOW` ·
`INVALID_LOCATION` · `OUTSIDE_GEOFENCE` · `POOR_GPS_ACCURACY` · `DUPLICATE_MARK` ·
`INVALID_SEQUENCE`

## 7. Criterios de aceptación

- [ ] Cada motivo de rechazo de §6 tiene un test que lo provoca.
- [ ] Un cliente con el reloj adelantado 2 h no consigue marcar fuera de ventana.
- [ ] Un cliente que miente en `distance_to_center` es rechazado igual.
- [ ] Doble toque en el botón genera **una** marca.
- [ ] Un empleado con vacaciones aprobadas vigentes no puede marcar.
- [ ] Un empleado de un departamento pausado ve el motivo de la pausa al intentar marcar.
- [ ] Marcar 3 minutos tarde con tolerancia de 5 no genera tardanza; a los 6 minutos, sí.
- [ ] El historial propio de un empleado nunca devuelve marcas de otro.

## 8. Decisiones abiertas

1. ¿Se imponen alternancia y secuencia (RN-09.9) o se toleran marcajes desordenados?
2. ¿Se guardan **todos** los intentos bloqueados? (volumen de tabla)
3. ¿Se añade `source` para distinguir salidas automáticas? (RN-09.14)
4. ¿Se ofrece el modo `geofence_exit` sabiendo su limitación? (RN-09.13)
5. ¿Marcaje sin conexión con cola local? El legacy **no** lo tiene; en planta con mala señal
   puede ser un requisito real.
