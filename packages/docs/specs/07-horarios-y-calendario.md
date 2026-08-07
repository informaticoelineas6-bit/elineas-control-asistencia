# 07 · Horarios por departamento y calendario laboral

> **Origen:** `old-docs.md` §3.2, puntos 17, 18, 19, 20.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Depende de:** [01-organizacion-departamentos](./01-organizacion-departamentos.md), [06-configuracion-global](./06-configuracion-global.md).
> **Habilita:** [09-marcaje-asistencia](./09-marcaje-asistencia.md) — aquí vive la regla de si un marcaje entra en ventana.

---

## 1. Objetivo

Definir **cuándo** se puede marcar. Dos piezas complementarias:

- **Horario del departamento** — la ventana diaria: desde/hasta cuándo se acepta una entrada
  y desde/hasta cuándo una salida.
- **Calendario laboral** — qué fechas concretas son laborables para ese departamento, con
  tolerancia de tardanza propia por fecha (feriados, jornadas especiales, inventarios).

## 2. Modelo de datos

### `department_schedules`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `department_id` | uuid FK, único | Un horario vigente por departamento |
| `checkin_start_time` | time | Inicio de la ventana de entrada |
| `checkin_end_time` | time | Fin de la ventana de entrada |
| `checkout_start_time` | time | Inicio de la ventana de salida |
| `checkout_end_time` | time | Fin de la ventana de salida |
| `timezone` | text IANA | Default: `global_timezone` |
| `allow_early_checkin` | boolean | Permite marcar entrada antes de `checkin_start_time` |
| `allow_late_checkout` | boolean | Permite marcar salida después de `checkout_end_time` |
| `created_at` / `updated_at` | timestamptz | |

### `work_calendar`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `department_id` | uuid FK | |
| `date` | date | Único por (`department_id`, `date`) |
| `is_workday` | boolean | |
| `late_tolerance_minutes` | int, nullable | Si es `null`, se usa el global de [06](./06-configuracion-global.md) |

## 3. Reglas de negocio

- **RN-07.1 — Un horario por departamento.** No hay turnos múltiples ni horarios por
  persona. *Limitación heredada real.* **Decisión abierta:** ¿el negocio necesita turnos?
- **RN-07.2 — Cálculo horario en la zona del departamento.** Toda comparación de "¿estoy en
  ventana?" se hace convirtiendo el instante a la zona horaria del horario. El legacy lo
  resolvía con `Intl.DateTimeFormat` y **sin librería de fechas**; el sistema nuevo puede
  usar una, pero la zona debe ser explícita en cada conversión — nunca la del servidor.
- **RN-07.3 — Ventana de entrada.** Un marcaje IN se acepta si la hora local está entre
  `checkin_start_time` y `checkin_end_time`. Si `allow_early_checkin`, también antes del
  inicio. Nunca después del fin, salvo vía [12-incidencias](./12-incidencias.md).
- **RN-07.4 — Ventana de salida.** Simétrico con `checkout_*` y `allow_late_checkout`.
- **RN-07.5 — Jornada nocturna.** Si `checkout_end_time < checkin_start_time`, la jornada
  cruza medianoche y la salida pertenece al día laboral anterior.
  *Comportamiento no documentado en el legacy — verificar si se soporta.* **Decisión abierta.**
- **RN-07.6 — Día no laborable.** Si existe una fila de `work_calendar` para la fecha con
  `is_workday = false`, no se espera asistencia: el día se clasifica `NO_LABORABLE` y el
  marcaje se rechaza (o se permite pero se marca como extraordinario — **decidir**).
- **RN-07.7 — Fecha sin fila en el calendario.** Se considera laborable por defecto, salvo
  que sea día de descanso de la persona ([10-descansos](./10-descansos.md)).
- **RN-07.8 — Precedencia de tolerancia.** `work_calendar.late_tolerance_minutes` (por fecha)
  → si es null, `app_config.late_tolerance_minutes` (global).
- **RN-07.9 — Departamento en pausa.** Bloquea el marcaje independientemente del horario
  ([01](./01-organizacion-departamentos.md) RN-01.4).
- **RN-07.10 — Cambio de horario notificado.** Al modificar el horario de un departamento se
  notifica automáticamente a todos sus miembros
  ([14-notificaciones](./14-notificaciones.md)).
- **RN-07.11 — No retroactividad.** Cambiar el horario no reclasifica días pasados
  ([06](./06-configuracion-global.md) RN-06.4).
- **RN-07.12 — `global_manager` no marca**, por lo que el horario de Administración es
  irrelevante para el marcaje pero **sí** para la reportería de quienes estén en ese
  departamento sin ser gestores globales.

## 4. Validación de un marcaje (parte horaria)

Función pura, reutilizable y testeable, equivalente al `validate_attendance_mark` del legacy.
Entrada: usuario, tipo de marca, instante, horario, calendario, descansos, estado de pausa.
Salida: `{ allowed: boolean, reason?: string, isLate?: boolean, lateMinutes?: number }`.

Orden de evaluación (falla al primer no):

1. ¿El rol puede marcar? (RN-03.4)
2. ¿El departamento está activo? (RN-07.9)
3. ¿La fecha es laborable para el departamento? (RN-07.6/7)
4. ¿Es día de descanso de esta persona? ([10](./10-descansos.md))
5. ¿La hora cae en la ventana del tipo de marca? (RN-07.3/4)
6. ¿Hay tardanza? (RN-07.8) → no bloquea, sólo etiqueta.

> **Esta función es el corazón de reglas del producto.** Debe tener tests unitarios
> exhaustivos: es el punto 71 de la deuda del legacy (cero cobertura) y no debe repetirse.

## 5. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/departments/:id/schedule` | department_head (ámbito) |
| `PUT` | `/departments/:id/schedule` | global_manager |
| `GET` | `/departments/:id/calendar?from=&to=` | department_head (ámbito) |
| `PUT` | `/departments/:id/calendar` | global_manager — upsert por lote de fechas |
| `GET` | `/me/schedule` | autenticado — el horario que le aplica hoy |

## 6. UI

- **Tarjeta de horario por departamento** en Configuración: cuatro horas, zona horaria, dos
  interruptores, y un previsualizador de la ventana resultante ("Puedes entrar entre 07:45 y
  08:15").
- **Calendario laboral**: vista de mes por departamento, marcar/desmarcar días, edición
  masiva por rango, tolerancia por fecha.
- Advertencia visible al guardar: "Se notificará a los N miembros del departamento".

## 7. Criterios de aceptación

- [ ] Un marcaje 1 minuto después de `checkin_end_time` se rechaza con motivo legible.
- [ ] Con `allow_early_checkin`, un marcaje 30 min antes se acepta y no cuenta como tardanza.
- [ ] Un marcaje dentro de ventana pero pasada la tolerancia se acepta **y** queda como tarde.
- [ ] Un día con `is_workday = false` clasifica como `NO_LABORABLE` en el reporte.
- [ ] La tolerancia por fecha gana sobre la global.
- [ ] Cambiar el horario genera una notificación por cada miembro del departamento.
- [ ] Los cálculos son correctos para un departamento con zona horaria distinta a la del servidor.

## 8. Decisiones abiertas

1. ¿Turnos múltiples por departamento o por persona? (RN-07.1)
2. ¿Se soportan jornadas que cruzan medianoche? (RN-07.5)
3. En día no laborable: ¿rechazar el marcaje o registrarlo como extraordinario? (RN-07.6)
4. ¿Feriados nacionales precargados o carga manual?
