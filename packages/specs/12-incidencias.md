# 12 · Incidencias de asistencia

> **Origen:** `old-docs.md` §3.4, puntos 41, 42, 43, 45.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe.
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

**Índices:** (`user_id`, `status`), (`date`), y por departamento vía join — el legacy los
añadió explícitamente porque la bandeja del jefe los necesita.

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
- **RN-12.4 — Plazo.** **Decisión abierta:** ¿hay un límite de días hacia atrás para reportar?
  Sin plazo, alguien puede reclamar un día de hace seis meses ya reportado y pagado.
  Propuesta: configurable, default 7 días.
- **RN-12.5 — Una por día y tipo.** No se permiten duplicados de (`user_id`, `date`,
  `incident_type`) en estado `pending`.
- **RN-12.6 — Revisión.** Revisa el `department_head` del ámbito o un `global_manager`.
  Nadie revisa la suya propia.
- **RN-12.7 — Rechazo con motivo.** `manager_notes` es obligatorio al rechazar.
- **RN-12.8 — Inmutable tras la revisión.** Una incidencia revisada no se reabre; si hace
  falta, se crea otra. Se conserva `reviewed_by`/`reviewed_at`.
- **RN-12.9 — Aprobar no corrige el marcaje.** No se crea ni edita ningún
  `attendance_mark`. La aprobación es un acto documental.
  **Decisión abierta 1** (§7): ¿debería corregirlo?
- **RN-12.10 — Notificaciones.** Al crear → al jefe. Al revisar → al empleado.
- **RN-12.11 — Degradación elegante.** *Lección del legacy:* la UI detectaba si la tabla no
  existía y se degradaba con un aviso en vez de romper. En el monorepo con migraciones
  controladas esto no debería hacer falta, pero **el principio sí**: una funcionalidad
  secundaria caída no debe tumbar el shell.

## 6. UI

### Empleado
- Lista de sus incidencias con filtro por estado y contador de pendientes (badge en la
  navegación).
- Alta: tipo, fecha, motivo. Validación de motivo según tipo (RN-12.1).

### Gestión
- Bandeja con **pendientes primero**, luego por fecha descendente.
- Búsqueda por empleado, correo, departamento y tipo.
- Muestra junto a cada incidencia el **contexto**: marcajes de ese día, estado calculado del
  día, y si hay una justificación de ausencia asociada.
- Acciones de aprobar/rechazar con notas.
- **Propuesta:** acción combinada "Aprobar y justificar la ausencia" que resuelva el
  desacople de §2.

## 7. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/incidents?status=&scope=&q=` | autenticado (propias) / department_head (ámbito) |
| `POST` | `/incidents` | autenticado |
| `POST` | `/incidents/:id/review` | department_head (ámbito) — `{ approved, notes }` |
| `GET` | `/incidents/pending-count` | department_head — para el badge |

## 8. Criterios de aceptación

- [ ] Una incidencia de tipo crítico sin motivo se rechaza con error de validación.
- [ ] Un empleado no puede crear una incidencia a nombre de otro.
- [ ] Un `department_head` sólo ve las incidencias de su ámbito (incluidos departamentos
      adicionales asignados).
- [ ] Rechazar sin notas falla.
- [ ] La bandeja ordena pendientes primero.
- [ ] Crear una incidencia notifica al jefe; revisarla notifica al empleado.
- [ ] Aprobar una incidencia no altera ningún marcaje (comportamiento actual, RN-12.9).

## 9. Decisiones abiertas

1. **¿Aprobar una incidencia debe justificar automáticamente la ausencia del día** (y por
   tanto evitar/revertir el descuento de nómina)? Es la decisión más importante de esta spec.
2. ¿Plazo máximo para reportar? (RN-12.4)
3. ¿Aprobar "olvidé marcar" debería crear el marcaje faltante con la hora declarada?
4. ¿El empleado puede adjuntar evidencia (foto, certificado)? Hoy no.
