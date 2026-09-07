# 12 · Incidencias de asistencia

> **Origen:** `old-docs.md` §3.4, puntos 41, 42, 43, 45.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado. La materia prima que anunciaba esta
> cabecera —los intentos de marcaje rechazados que guarda la [09](./09-marcaje-asistencia.md),
> con su motivo tipado y la distancia recalculada— **se usa de verdad**: el formulario ofrece
> los intentos rechazados del día elegido y la incidencia se abre enlazada a uno (RN-12.2), así
> que el revisor la ve con la fila delante en vez de con un relato.
>
> Vocabulario y reglas puras (motivo por tipo, fechas admitidas, asimetría del rechazo) en
> `packages/validations/src/incidents.ts`; contrato en `packages/contracts/src/incidents.ts`;
> tabla `attendance_incidents` con el **índice único parcial** de RN-12.5; servicio y rutas en
> `apps/backend/src/services/incidents.ts` y `apps/backend/src/routes/incidents.ts`. Interfaz:
> `/incidents` (`apps/frontend/src/modules/incidents/my-incidents-panel.tsx`) y la bandeja de
> revisión dentro de `/team` (`incident-review-panel.tsx`), con badge de pendientes en el aside
> (RN-05.8, primera vez que existe). Pruebas en `apps/backend/src/routes/incidents.test.ts` (37,
> de integración) y `apps/backend/src/services/incident-rules.test.ts` (16, puras).
>
> **Tres decisiones de la §9 quedan cerradas (2, 3 y 4) y la 1 sigue abierta a propósito**: no
> se puede cerrar sin la [13](./13-justificacion-ausencias.md), que no existe. Ver §9.
> **Depende de:** [09-marcaje-asistencia](./09-marcaje-asistencia.md), [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).
> **No confundir con:** [13-justificacion-ausencias](./13-justificacion-ausencias.md) — es un flujo **distinto**.

---

## 1. Objetivo

Dar al empleado una vía formal para **reportar un problema con su marcaje** —olvidó marcar,
llegó tarde por una razón, el GPS falló, la geocerca lo rechazó— y al jefe una bandeja para
revisarlas y dejar constancia.

## 2. Incidencia vs. justificación de ausencia

| | Incidencia ([12](./12-incidencias.md)) | Justificación de ausencia ([13](./13-justificacion-ausencias.md)) |
|---|---|---|
| Quién la inicia | El **empleado** | El **jefe** |
| Sobre qué | Un problema con un marcaje o su ausencia | Un día completo sin asistencia |
| Estado | `pending → approved / rejected` | `is_justified: true/false` |
| Efecto en nómina | **Ninguno** | Genera/revierte descuento automático |
| Efecto en el reporte | Ninguno directo | Códigos AJ / ANJ |

> ⚠️ **Los dos flujos están desconectados en el legacy.** Aprobar la incidencia de "olvidé
> marcar" **no** justifica automáticamente la ausencia de ese día, y por tanto **no evita el
> descuento de nómina**. El jefe tiene que hacer las dos cosas. Esto es casi seguro un
> defecto de producto. Ver §7, decisión abierta 1.

## 3. Modelo de datos

### `attendance_incidents`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | Quien reporta |
| `incident_type` | enum | Ver §4 |
| `date` | date | Día al que se refiere |
| `reason` | text | Descripción del empleado |
| `status` | enum | `pending` · `approved` · `rejected` |
| `manager_notes` | text, nullable | Notas del revisor |
| `reviewed_by` | uuid, nullable | |
| `reviewed_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

| `attendance_mark_id` | uuid, nullable | **Añadido** — RN-12.2. `ON DELETE set null`: la incidencia y su revisión siguen valiendo sin la marca |

**Índices implementados:** (`user_id`, `status`), (`date`) y (`status`, `date desc`) — el
tercero es el orden de la bandeja (§6). El "por departamento vía join" que pedía la spec **no
se creó**: el departamento vive en `profiles`, que ya tiene el suyo, y un índice sobre esta
tabla no puede cubrir una columna de la otra.

Y un índice que la spec no pedía: **`unique (user_id, date, incident_type) where status =
'pending'`**, que es RN-12.5 en la base. Parcial a propósito — una vez revisada, RN-12.8
permite crear otra— y en la base y no en una comprobación previa, porque dos envíos
simultáneos del mismo formulario no se detectan leyendo antes de insertar.

## 4. Tipos de incidencia

| Tipo | Cuándo se usa | ¿Motivo obligatorio? |
|---|---|---|
| `forgot_to_mark` — olvidé marcar | No registró entrada o salida | ✅ |
| `late_arrival` — tardanza | Llegó tarde y quiere explicar por qué | ✅ |
| `early_departure` — salida temprana | Se retiró antes de la ventana | ✅ |
| `gps_issue` — problema de GPS | El dispositivo no obtuvo ubicación válida | opcional |
| `geofence_issue` — geocerca | Estaba en sede pero fue rechazado | opcional |

- **RN-12.1** — Los tipos "críticos" (los tres primeros) exigen `reason` no vacío.
  Los técnicos pueden enviarse sin texto porque el sistema ya tiene la evidencia
  (marcaje bloqueado con su motivo).
- **RN-12.2** — **Propuesta:** enlazar la incidencia al marcaje bloqueado que la originó
  (`attendance_mark_id` nullable). El legacy no lo hace, y sin eso el revisor tiene que
  buscar a mano la evidencia.

## 5. Reglas de negocio

- **RN-12.3 — Ámbito de creación.** Un empleado sólo crea incidencias para sí mismo y para
  fechas pasadas o de hoy.
- **RN-12.4 — Plazo.** **Cerrada:** configurable en `incident_report_window_days`
  ([06](./06-configuracion-global.md) §3.5), y **`0` = sin plazo**. El default es 0 y no 7 por
  el criterio de defaults de la spec 06 —el valor por defecto se comporta *como si la clave no
  estuviera configurada*— y por lo mismo que `rest_days_min_separation`: la cifra es una regla
  laboral y la pone el negocio; lo que tenía que existir ya es el sitio donde ponerla. Está en
  la lista blanca de `/config/public` para que el formulario avise **antes** de enviar, con la
  misma función (`incidentDateIssue`) y el mismo mensaje que aplica el servidor.
- **RN-12.5 — Una por día y tipo.** No se permiten duplicados de (`user_id`, `date`,
  `incident_type`) en estado `pending`.
- **RN-12.6 — Revisión.** Revisa el `department_head` del ámbito o un `global_manager`.
  Nadie revisa la suya propia. Las dos mitades están implementadas: el ámbito lo comprueba la
  ruta con `canManage` sobre el departamento **de quien reportó** —leído de la fila, no un
  parámetro del cliente—, y el autobloqueo lo aplica el servicio, que conoce `incident.userId`.
  A diferencia de RN-11.8, aquí **no queda nada abierto**: la regla no habla de proteger a un
  jefe, así que no depende de saber quién lo es.
- **RN-12.7 — Rechazo con motivo.** `manager_notes` es obligatorio al rechazar.
- **RN-12.8 — Inmutable tras la revisión.** Una incidencia revisada no se reabre; si hace
  falta, se crea otra. Se conserva `reviewed_by`/`reviewed_at`. El estado va además en el
  `WHERE` del `UPDATE`, no sólo en la comprobación previa: dos revisores simultáneos sobre la
  misma incidencia no pueden escribir los dos, y el segundo recibe el 409 en vez de
  sobrescribir el veredicto del primero.
- **RN-12.9 — Aprobar no corrige el marcaje.** No se crea ni edita ningún
  `attendance_mark`. La aprobación es un acto documental.
  **Decisión abierta 1** (§7): ¿debería corregirlo?
- **RN-12.10 — Notificaciones.** Al crear → al jefe. Al revisar → al empleado. ⚠️ El aviso al
  jefe **sólo alcanza a quien gestiona el departamento como responsabilidad *adicional***
  (`additionalHeadsOf`), que es la misma limitación de RN-11.11 y la misma causa: este sistema
  no sabe quién es el jefe *propio* de un departamento sin que esa persona se autentique
  (RN-00.43). El jefe propio se entera al abrir su bandeja, donde además tiene el badge. Es la
  tercera spec que se topa con la [decisión 3 de la 11](./11-vacaciones.md#9-decisiones-abiertas);
  la función vive en `services/responsibilities.ts` para arreglarla en un solo sitio.
- **RN-12.11 — Degradación elegante.** *Lección del legacy:* la UI detectaba si la tabla no
  existía y se degradaba con un aviso en vez de romper. En el monorepo con migraciones
  controladas esto no debería hacer falta, pero **el principio sí**: una funcionalidad
  secundaria caída no debe tumbar el shell. Lo cumplen las tres capas de la
  [05](./05-shells-y-navegacion.md) §5 sin código propio de esta spec: cada consulta pinta su
  `InlineError` y la frontera de ruta contiene el resto. El badge del aside es el caso más
  expuesto —se pide en cada carga— y por eso no rompe nada si falla: sin dato, no se pinta.

## 6. UI

### Empleado — `/incidents`
- Lista de sus incidencias y **badge de pendientes en el aside** (RN-05.8).
- Alta: tipo, fecha, motivo, con la validación de RN-12.1 y RN-12.4 en vivo.
- **Añadido:** cuando el día elegido tiene intentos de marcaje rechazados, se ofrecen para
  enlazarlos (RN-12.2) con su hora, su motivo legible y la distancia a la sede. Es la idea de
  la cabecera puesta en pantalla.

> La ruta es `/incidents`, no el `/issues` que decía la [05](./05-shells-y-navegacion.md) §3:
> eran dos palabras inglesas para la misma cosa, y la tabla, el tipo, el servicio y el módulo
> ya se llaman *incident*. La etiqueta sigue siendo *Incidencias*.

### Gestión — dentro de `/team`
- Bandeja con **pendientes primero**, luego por fecha descendente (en SQL, con su índice).
- Búsqueda por empleado, correo y departamento —los tres en el mismo filtro, porque quien
  busca escribe lo que recuerda sin declarar en qué campo está— y filtro por tipo.
- El **contexto** de la §6 en un endpoint aparte (`GET /incidents/:id/context`), pedido al
  abrir la revisión y no con la lista: son dos consultas por incidencia y resolverlas para toda
  la bandeja sería trabajo que nadie mira. Trae el día ya clasificado por la agregación de la
  [15](./15-paneles-y-dashboard.md) —el revisor ve **el mismo** estado que el empleado en su
  historial— y los intentos rechazados de esa jornada, con el enlazado destacado. **No trae la
  justificación de ausencia**: es de la [13](./13-justificacion-ausencias.md) y no existe; un
  campo que hoy sólo puede valer nulo invita a escribir la rama que lo maneja.
- Acciones de aprobar/rechazar con notas. El diálogo dice en voz alta que aprobar **no crea ni
  corrige ningún marcaje** (RN-12.9): el desacople del legacy no era un problema de código,
  era que nadie sabía que las dos cosas eran dos cosas.
- La acción combinada *"Aprobar y justificar la ausencia"* **no está**: es la decisión 1 y
  necesita la [13](./13-justificacion-ausencias.md).

## 7. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/incidents?status=&scope=&departmentId=&incidentType=&search=` | autenticado (`scope=own`, el default) / department_head (`scope=managed`, su ámbito) |
| `POST` | `/incidents` | autenticado |
| `POST` | `/incidents/:id/review` | department_head (ámbito) — `{ approved, notes }` |
| `GET` | `/incidents/pending-count?scope=` | autenticado (`own`) / department_head (`managed`) |
| `GET` | `/incidents/blocked-marks?date=` | autenticado — **añadido**, los intentos rechazados propios de un día |
| `GET` | `/incidents/:id/context` | quien reportó, o department_head del ámbito — **añadido**, §6 |

Tres diferencias con lo que decía esta tabla, todas deliberadas:

- **`search=` en vez de `q=`**, para que sea el mismo nombre que en `GET /users`. Dos nombres
  para el mismo filtro es de esas diferencias que sólo se descubren depurando.
- **`pending-count` acepta `scope=`.** La tabla lo daba sólo al jefe, pero la §6 pide además un
  contador de pendientes al empleado: es el mismo conteo con otro alcance, así que es el mismo
  endpoint y no dos rutas que cuentan filas de la misma tabla.
- **`blocked-marks` es nuevo** y sale de la cabecera de esta spec, no de la §7: para abrir una
  incidencia "con la fila delante" el formulario tiene que poder enseñar esas filas, y ningún
  endpoint las devolvía —el historial de la [09](./09-marcaje-asistencia.md) sólo cuenta los
  marcajes válidos. Vive en el contrato de esta spec, no en el de asistencia, porque es una
  necesidad de aquí: quien lo lee entiende por qué existe.

`POST /incidents` **no lleva puerta de rol**, al contrario que la solicitud de vacaciones. Allí
la [11](./11-vacaciones.md) §4 invoca RN-03.4 de forma explícita —quien no marca no acumula ni
solicita—; aquí esta tabla dice "autenticado" y no hay nada que restringir: una incidencia no
consume saldo ni cambia ningún cálculo (RN-12.9), así que un 403 que la spec no pide sería una
regla inventada.

## 8. Criterios de aceptación

- [x] Una incidencia de tipo crítico sin motivo se rechaza con error de validación.
- [x] Un empleado no puede crear una incidencia a nombre de otro. *(No hay campo de persona:
      mandarlo no cambia el dueño, y la prueba lo comprueba.)*
- [x] Un `department_head` sólo ve las incidencias de su ámbito (incluidos departamentos
      adicionales asignados).
- [x] Rechazar sin notas falla.
- [x] La bandeja ordena pendientes primero.
- [x] Crear una incidencia notifica al jefe; revisarla notifica al empleado. *(Al jefe, con la
      limitación de RN-12.10.)*
- [x] Aprobar una incidencia no altera ningún marcaje (comportamiento actual, RN-12.9). *(Se
      comprueba contando y comparando las filas de `attendance_marks` antes y después.)*

## 9. Decisiones abiertas

1. **⚠️ Sigue abierta — ¿aprobar una incidencia debe justificar automáticamente la ausencia
   del día** (y por tanto evitar/revertir el descuento de nómina)? Es la decisión más
   importante de esta spec y **no se puede cerrar todavía**: la justificación es de la
   [13](./13-justificacion-ausencias.md) y no existe, así que no hay nada que enlazar. Lo
   construido es el comportamiento actual del legacy (RN-12.9), con la costura preparada: la
   incidencia guarda su `user_id`, su `date` y su estado, y `reviewIncident` es el único sitio
   por el que pasa una aprobación. Cuando se cierre a favor, es ahí donde entra — y en
   `modules/incidents/api.ts`, que hoy documenta por qué **no** invalida la asistencia.
2. ~~¿Plazo máximo para reportar?~~ **Cerrada: configurable, `0` = sin plazo, default 0.** Ver
   RN-12.4.
3. ~~¿Aprobar "olvidé marcar" debería crear el marcaje faltante con la hora declarada?~~
   **Cerrada: no.** La incidencia **no captura una hora declarada** —la §3 no tiene ese campo—,
   así que no hay de dónde sacar el instante de la marca. Cambiarlo no es tocar la aprobación:
   es añadir la hora al modelo, un valor nuevo de `source` ([09](./09-marcaje-asistencia.md)
   RN-09.14) y decidir qué hace la secuencia (RN-09.9) con una marca insertada a posteriori.
   Y choca con RN-09.12, que dice que el marcaje no se edita desde la aplicación.
4. ~~¿El empleado puede adjuntar evidencia (foto, certificado)?~~ **Cerrada: no.** Este sistema
   no almacena archivos en ninguna parte, y el caso técnico —"intenté marcar y no me dejó"— ya
   trae su prueba dentro (RN-12.2).
