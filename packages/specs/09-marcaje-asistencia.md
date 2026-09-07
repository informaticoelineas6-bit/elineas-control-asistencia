# 09 · Marcaje de asistencia (núcleo del producto)

> **Origen:** `old-docs.md` §3.4, puntos 26–32, 40.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado, **y sin costuras abiertas**: las dos que
> quedaban por dependencia están conectadas — los descansos ([10](./10-descansos.md), `isRestDay`
> recibe el predicado real y un intento en día de descanso se rechaza con `REST_DAY`) y las
> vacaciones ([11](./11-vacaciones.md), `onVacation` con datos reales y `ON_VACATION` en el
> rechazo). Las dos quedan registradas como cualquier otro intento (RN-09.8). Tabla `attendance_marks` con los dos índices únicos
> por minuto del antirrebote; **la función pura de la §4** en
> `apps/backend/src/services/attendance-rules.ts`, que compone la horaria de la
> [07](./07-horarios-y-calendario.md) y la de ubicación de la
> [08](./08-sedes-y-geocerca.md) y añade antirrebote y secuencia; la agregación diaria
> —adelanto de la [15](./15-paneles-y-dashboard.md)— en
> `apps/backend/src/services/daily-status.ts`; la única puerta de escritura en
> `apps/backend/src/services/attendance.ts` y `apps/backend/src/routes/attendance.ts`.
> En la interfaz: pantalla de marcaje en `/clock-in`
> (`apps/frontend/src/modules/attendance/clock-in-panel.tsx`) e historial propio en
> `/attendance` (`history.tsx`), sobre el calendario de la 07. Pruebas:
> `attendance-rules.test.ts` (31 unitarias, un caso por motivo de rechazo),
> `daily-status.test.ts` (12) y `routes/attendance.test.ts` (23 de integración).
> Las cinco decisiones de la §8 están cerradas.
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
| `block_reason` | text, nullable | Motivo del rechazo, del enum de §6 |
| `created_at` | timestamptz | |

Cuatro campos **añadidos en la implementación**, todos por el mismo motivo: lo que hoy
se puede recalcular, mañana no — el horario, la tolerancia y la geocerca cambian, y los
cambios no son retroactivos ([06](./06-configuracion-global.md) RN-06.4).

| Campo | Tipo | Por qué |
|---|---|---|
| `work_date` | date, nullable | A qué **jornada** pertenece la marca ([07](./07-horarios-y-calendario.md) RN-07.5): en un turno de noche la salida de la madrugada cuenta para el día anterior. Nulo sólo en un intento rechazado antes de poder resolverla |
| `is_late` / `late_minutes` | boolean / int | La tardanza **con la tolerancia de entonces** (RN-09.7) |
| `source` | text | `manual` · `auto_schedule` · `auto_geofence` · `import` (RN-09.14) |
| `department_id` | uuid, nullable | La denormalización que la §2 pedía evaluar: **sí**, como foto del momento. La reportería filtra por departamento constantemente, y para un reporte histórico el valor correcto es el de entonces, no el de hoy |

La columna que la §2 llamaba `timestamp` es **`marked_at`**: no conviene llamar a una
columna igual que un tipo de SQL.

**Antirrebote en la base** (RN-09.10): dos índices únicos parciales sobre
(`user_id`, `mark_type`, minuto de `marked_at` en UTC), uno para las marcas válidas y
otro para las rechazadas. Son dos y no uno porque no compiten: un intento rechazado a
las 08:00:10 no puede impedir que el marcaje bueno de las 08:00:40 —la persona entró en
la geocerca entretanto— entre en el mismo minuto. La comprobación previa de 30 s no
basta: la carrera del doble toque sólo la gana una restricción.

**Índices necesarios:** (`user_id`, `timestamp`), (`timestamp`), y uno por departamento vía
join con `profiles` — evaluar denormalizar `department_id` para la reportería.

> **Sobre `blocked`:** el legacy guarda también los intentos fallidos. Es valioso para
> soporte ("intenté marcar 4 veces y no me dejó") y para las incidencias.
> **Decidido: se guardan todos** (§8.2). El volumen queda acotado porque el antirrebote
> también aplica a los rechazos: cuatro toques seguidos son **una** fila.

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
  día laboral, ni un `OUT` sin `IN` previo. **Decidido: se impone** (§8.1), con rechazo
  `INVALID_SEQUENCE`. Lo que **sí** vale es entrada→salida→entrada→salida: el almuerzo es
  legítimo y sólo se prohíbe repetir el mismo tipo. La comparación es contra la última marca
  aceptada **de esa jornada** (`work_date`), no del día natural, para que un turno de noche
  no se rompa a medianoche.
- **RN-09.10 — Antirrebote.** Dos marcajes idénticos en menos de N segundos se tratan como
  uno (doble toque, reintento de red). **N = 30 s**, más idempotencia por
  (`user_id`, `mark_type`, minuto) en la base (§2). Tres detalles de la implementación:
  se mide **sólo contra marcas aceptadas** —un rechazo no puede tapar el marcaje bueno que
  viene veinte segundos después—; se comprueba **antes de la ventana horaria y de la
  secuencia**, porque un segundo toque a las 08:16 tiene que decir "ya estaba registrado" y
  no "fuera de ventana"; y una repetición **devuelve la marca que ya existía** con
  `duplicate: true`, no un error. Repetir la petición es seguro, que es lo que permite
  reintentar cuando falla la red.
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
    sustituto y no un servicio nativo ([08](./08-sedes-y-geocerca.md) §4). Decidido al
    construir la 08: **la opción se mantiene en Configuración con advertencia visible** y no
    se construye seguimiento en segundo plano; los dos cierres automáticos (`schedule` y
    `geofence_exit`) necesitan además un proceso programado que **todavía no existe**. El
    campo `source` ya está listo para cuando lo haya.
- **RN-09.14** — Un `OUT` automático debe distinguirse de uno manual en el registro.
  **Decidido: se añade ya** (§8.3) el enum `source`
  (`manual|auto_schedule|auto_geofence|import`). Hoy todo se escribe `manual`; el campo
  existe para que, cuando llegue el cierre automático o la importación histórica
  ([19](./19-panel-superadmin.md)), lo ya escrito se pueda distinguir hacia atrás.

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

**Implementado así**, en tres piezas puras que se componen y una que escribe:

| Pieza | Dónde | Qué decide |
|---|---|---|
| `validateMarkTime` | `services/schedule-rules.ts` ([07](./07-horarios-y-calendario.md)) | Rol, pausa, horario, calendario, descanso, ventana, tardanza y **a qué jornada pertenece** |
| `validateMarkLocation` | `services/location-rules.ts` ([08](./08-sedes-y-geocerca.md)) | Sede elegida y activa, geocerca recalculada, precisión |
| `validateAttendanceMark` | `services/attendance-rules.ts` | Compone las dos y añade cuenta activa, vacaciones, **antirrebote** y **secuencia** |
| `createMark` | `services/attendance.ts` | Carga el contexto, llama a la pura y **escribe una fila siempre**: válida o rechazada |

El orden de evaluación es el de la §3 con **una desviación deliberada**: el antirrebote va
antes de la ventana horaria, por lo explicado en RN-09.10. Y la parte de ubicación se
**calcula siempre**, aunque falle algo anterior: sus números van a la fila del intento
rechazado, porque sin ellos soporte no puede reconstruir dónde estaba la persona. El
**motivo** sí respeta el orden.

El instante lo fija `createMark` una sola vez y el mismo valor se valida y se guarda
(RN-09.11): dejarlo a `defaultNow()` de la base permitiría que la hora validada y la
almacenada difirieran en milisegundos y, en el borde de la ventana, en el veredicto.

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

**Implementado:**

- **`/clock-in`** — la pantalla de marcaje, en columna estrecha y con el botón grande. El
  orden de la pantalla es el de las preguntas que se hace quien la usa: *¿dónde estoy?*,
  *¿qué me toca marcar?*, *¿qué llevo marcado?*. El estado del GPS y la distancia a la sede
  se ven **antes** de intentar marcar, con la misma función que aplicará el servidor; la
  lectura se vuelve a pedir **en el momento de pulsar**, porque entre abrir la pantalla y
  marcar la persona se mueve. El botón se bloquea mientras la petición está en vuelo.
- Estar fuera de la geocerca **no deshabilita el botón**: se avisa y se deja intentar. El
  rechazo queda registrado, y esa fila es lo que sostiene una incidencia
  ([12](./12-incidencias.md)).
- **`/attendance`** — el historial propio del mes, con el **mismo componente de calendario**
  de la [07](./07-horarios-y-calendario.md) (un día por celda, con estado, horas y aviso de
  jornada sin cerrar) y una tabla de detalle. Los días llegan **ya agregados del servidor**:
  el frontend no calcula estados ([15](./15-paneles-y-dashboard.md) §4).
- **Mi semana** y la barra inferior son del **EmployeeShell** ([05](./05-shells-y-navegacion.md)
  §3), que sigue pendiente; reutilizarán estos componentes.

## 6. API propuesta

| Método | Path | Descripción |
|---|---|---|
| `POST` | `/attendance/marks` | Body: `{ markType, latitude, longitude, accuracy, workLocationId }`. Devuelve la marca creada o el rechazo tipado |
| `GET` | `/attendance/marks/today` | Marcas de hoy del usuario |
| `GET` | `/attendance/me?from=&to=` | Historial propio agregado por día |
| `GET` | `/attendance/status` | Qué puede hacer ahora: `can_check_in` / `can_check_out` / `blocked` + motivo |

`GET /attendance/status` es importante: permite que la UI muestre el estado correcto **sin**
intentar marcar y fallar.

Tres precisiones de la implementación:

- Los cuatro endpoints son **del usuario sobre sí mismo**: ninguno acepta identificador de
  persona, así que no hay forma de marcar por otro ni de leer su historial desde aquí.
- **Un rechazo responde 200**, no 4xx, con `{ accepted: false, reason, message, mark }`. No es
  un fallo de la petición: es un hecho del negocio que además queda registrado, y la interfaz
  necesita el motivo tipado para reaccionar distinto a cada uno. El 4xx queda para lo que sí
  es un fallo: sin sesión (401) o cuerpo inválido (400). Un marcaje creado responde 201.
- **`/attendance/status` no incluye el veredicto de la geocerca**, porque eso necesita una
  lectura del dispositivo y un `GET` con coordenadas en la URL acaba en los registros del
  servidor. Esa parte la da `POST /me/location-check` ([08](./08-sedes-y-geocerca.md)); la
  pantalla compone las dos.

### Rechazos tipados

Los motivos de rechazo deben ser un enum compartido en `packages/validations`, no cadenas
libres — la UI necesita reaccionar distinto a cada uno:

`NOT_AUTHENTICATED` · `INACTIVE_ACCOUNT` · `ON_VACATION` · `ROLE_CANNOT_MARK` ·
`DEPARTMENT_PAUSED` · `NO_SCHEDULE` · `NOT_WORKDAY` · `REST_DAY` · `OUTSIDE_TIME_WINDOW` ·
`INVALID_LOCATION` · `OUTSIDE_GEOFENCE` · `POOR_GPS_ACCURACY` · `DUPLICATE_MARK` ·
`INVALID_SEQUENCE`

En `packages/validations/src/attendance.ts` están **trece**: `NOT_AUTHENTICATED` no entra
porque ninguna línea de código puede devolverlo — sin sesión no se llega al handler y responde
el middleware con 401. Un motivo tipado que nadie puede emitir sólo sirve para que alguien
escriba una rama muerta que lo maneje.

Cada motivo lleva además su **mensaje por defecto** en el mismo sitio
(`MARK_REJECTION_MESSAGES`), pero el servidor manda casi siempre uno más concreto, ya
redactado con los metros y las horas: *"Estás a 240 m del centro de Sede Central, que permite
100 m. Sí estás dentro de Sede Norte: si hoy trabajas ahí, cámbiala en tu perfil."* La
interfaz lo muestra tal cual; no reescribe mensajes.

## 7. Criterios de aceptación

- [x] Cada motivo de rechazo de §6 tiene un test que lo provoca (los doce que el código
      puede emitir; `NOT_AUTHENTICATED` se prueba como 401 en la de integración).
- [x] Un cliente con el reloj adelantado 2 h no consigue marcar fuera de ventana: **el cuerpo
      de la petición no tiene campo de hora** y hay una prueba que manda `markedAt` y se
      comprueba que se ignora.
- [x] Un cliente que miente en `distance_to_center` es rechazado igual: esos campos no están
      en el esquema de entrada y el servidor recalcula (RN-08.2).
- [x] Doble toque en el botón genera **una** marca, incluso con las dos peticiones
      simultáneas.
- [x] Un empleado con vacaciones aprobadas vigentes no puede marcar. *Probado por la bandera
      `onVacation`; conectarla a datos reales es de la [11](./11-vacaciones.md).*
- [x] Un empleado de un departamento pausado ve el motivo de la pausa al intentar marcar.
- [x] Marcar 3 minutos tarde con tolerancia de 5 no genera tardanza; a los 6 minutos, sí.
- [x] El historial propio de un empleado nunca devuelve marcas de otro.

## 8. Decisiones (cerradas)

1. ~~¿Se imponen alternancia y secuencia?~~ **Se imponen** (RN-09.9). Es lo que permite que la
   agregación diaria empareje entrada y salida sin adivinar, y de ahí sale la nómina. El
   almuerzo sigue siendo legítimo.
2. ~~¿Se guardan todos los intentos bloqueados?~~ **Todos**, con `blocked = true` y motivo. Es
   la prueba de "intenté marcar cuatro veces" y el respaldo de una incidencia; el antirrebote
   evita que el volumen se dispare.
3. ~~¿Se añade `source`?~~ **Sí, ya** (RN-09.14), aunque hoy todo sea `manual`.
4. ~~¿Se ofrece el modo `geofence_exit`?~~ **Se mantiene con advertencia visible** y sin
   seguimiento en segundo plano (decidido en la [08](./08-sedes-y-geocerca.md)).
5. ~~¿Marcaje sin conexión con cola local?~~ **No ahora.** Una cola obliga a aceptar la hora
   del teléfono, que es justo lo que RN-09.11 evita, o a inventar reglas de conciliación. Lo
   que sí es seguro es **reintentar**: la idempotencia por (persona, tipo, minuto) hace que
   repetir la petición no duplique. Queda como requisito de la
   [20](./20-app-movil-y-distribucion.md), donde hay almacenamiento propio.

Lo que queda pendiente **por dependencia**, no por decisión:

- ~~**Descansos** ([10](./10-descansos.md))~~ — **conectado.** Como esta spec anticipaba, fue
  pasar un argumento: el servicio carga el predicado con `restDayResolverFor` y `GET
  /attendance/status` lo aplica también, para que el estado no ofrezca un botón que el `POST`
  va a rechazar.
- ~~**Vacaciones** ([11](./11-vacaciones.md))~~ — **conectado.** `onVacation` sale de
  `isOnVacationToday`. Un detalle del orden de esta spec que la 11 tuvo que respetar: RN-09.2 se
  evalúa **en segundo lugar**, antes de que `validateMarkTime` resuelva a qué jornada pertenece
  la marca, así que la vacación se comprueba contra **hoy** y no contra el `workDate` — la
  simplificación que ese orden implica, y que en una jornada nocturna sólo se nota en el minuto
  del cambio de día. `GET /attendance/status` lo aplica como un gate externo, igual que
  `canMark`: `validateMarkTime` es de la spec 07 y no tiene por qué conocer las vacaciones.
- **Cierre automático de jornada** (RN-09.13, modos `schedule` y `geofence_exit`): necesita un
  proceso programado. El campo `source` ya lo espera.
- **Borrado administrativo de una marca** (RN-09.12): no hay endpoint. Cuando lo haya, va con
  su acción de bitácora.
