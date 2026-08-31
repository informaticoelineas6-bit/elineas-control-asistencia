# 10 · Descansos

> **Origen:** `old-docs.md` §3.2, puntos 33, 34, 35, 36, 49.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe. La validación horaria de la
> [07](./07-horarios-y-calendario.md) §4 ya deja el enganche preparado: recibe los descansos como
> **predicado** `isRestDay(workDate)` en vez de un array de días de la semana, precisamente para
> no tener que elegir la convención de `days_of_week` (decisión abierta 1) antes de tiempo. El
> marcaje ([09](./09-marcaje-asistencia.md)) ya lo pasa —hoy sin conectar, así que nadie
> descansa (RN-10.3)— y la agregación diaria ya tiene su `isRestDay` para clasificar `DESCANSO`.
> Construir esta spec es, en su parte de marcaje, **conectar dos argumentos**.
> **Depende de:** [01-organizacion-departamentos](./01-organizacion-departamentos.md), [06-configuracion-global](./06-configuracion-global.md).
> **Habilita:** [09-marcaje-asistencia](./09-marcaje-asistencia.md) (no se marca en descanso), [15](./15-paneles-y-dashboard.md) y [16](./16-reporteria-mensual.md) (estado `DESCANSO`).

---

## 1. Objetivo

Definir qué días de la semana **no** trabaja cada persona, para no contarlos como ausencia.
Hay **dos modelos coexistiendo**, y cuál aplica lo decide el departamento:

- **Individual** — cada persona elige sus días de descanso.
- **Por grupos** — el departamento define grupos (Grupo A, Grupo B…) con días fijos y asigna
  personas a un grupo. Para operaciones que rotan turnos.

## 2. Modelo de datos

### `user_rest_schedule` (individual)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `days_of_week` | int[] | 0 = domingo … 6 = sábado (**confirmar la convención del legacy**) |
| `effective_from` | date | Desde cuándo rige esta configuración |

### `rest_groups`

| Campo | Tipo |
|---|---|
| `id` | uuid PK |
| `department_id` | uuid FK |
| `name` | text (p. ej. "Grupo A") |
| `days_of_week` | int[] |

### `rest_group_members`

| Campo | Tipo | Notas |
|---|---|---|
| `group_id` | uuid FK | |
| `user_id` | uuid FK | |
| `effective_from` | date | Desde cuándo pertenece al grupo |

### Interruptor

`departments.rest_groups_enabled` decide qué modelo aplica a los miembros de ese
departamento ([01](./01-organizacion-departamentos.md)).

## 3. Reglas de negocio

- **RN-10.1 — Vigencia por fecha.** Tanto `user_rest_schedule` como `rest_group_members`
  tienen `effective_from`. Para resolver los descansos de una fecha D se toma **la fila más
  reciente con `effective_from ≤ D`**. Esto permite cambiar descansos sin reescribir el
  pasado y es imprescindible para que los reportes históricos sigan siendo correctos.
- **RN-10.2 — Precedencia.** Si el departamento tiene `rest_groups_enabled = true`, mandan
  los grupos y la configuración individual se ignora (no se borra). Si es `false`, manda la
  individual.
- **RN-10.3 — Sin configuración.** Si no hay ninguna fila vigente para la persona, **no tiene
  descansos** y todos los días laborables del calendario se le exigen. Esto dispara el
  recordatorio automático (§5).
- **RN-10.4 — No se marca en día de descanso.** El marcaje se rechaza con `REST_DAY`
  ([09](./09-marcaje-asistencia.md)). El día clasifica como `DESCANSO` en la reportería.
- **RN-10.5 — Separación mínima.** `rest_days_min_separation` (global) exige un número mínimo
  de días entre dos descansos de la misma persona. Sólo aplica a los departamentos listados
  en `rest_days_min_separation_departments`; si la lista está vacía, **confirmar** si eso
  significa "a ninguno" o "a todos".
- **RN-10.6 — No marcar como descanso un día ya trabajado.** Si existe un marcaje en esa
  fecha, la configuración es inválida. La validación es de UI y de servidor.
- **RN-10.7 — Cambio hacia el pasado prohibido.** `effective_from` no puede ser anterior a
  hoy salvo para rol administrativo (y queda en bitácora).
- **RN-10.8 — Un grupo con miembros no se elimina;** primero se reasignan.
- **RN-10.9 — Número de descansos.** ¿Hay mínimo/máximo de días de descanso por semana?
  El legacy no lo documenta. **Decisión abierta** — es una regla laboral, probablemente sí.

## 4. Quién configura qué

| Acción | employee | department_head | global_manager |
|---|:--:|:--:|:--:|
| Ver sus descansos | ✅ | ✅ | ✅ |
| Elegir sus descansos (modo individual) | ✅ | ✅ | — |
| Ver/editar descansos de su ámbito | ❌ | ✅ | ✅ |
| Crear/editar grupos de descanso | ❌ | ❌ | ✅ |
| Asignar personas a grupos | ❌ | ✅ (su ámbito) | ✅ |

> **Decisión abierta:** ¿el empleado elige realmente sus descansos, o los propone y el jefe
> aprueba? El legacy los deja elegir con las validaciones de RN-10.5/10.6 como único freno.

## 5. Recordatorio automático

- **RN-10.10** — Si un empleado o jefe no tiene descansos configurados para la semana en
  curso, el sistema crea/actualiza una notificación recordándoselo
  ([14-notificaciones](./14-notificaciones.md)).
- El recordatorio se **actualiza**, no se duplica: una sola notificación viva por persona.

> ⚠️ **Hallazgo H-4 del legacy:** esta regla vivía dentro del contexto de notificaciones del
> frontend, no en la capa de dominio. En el sistema nuevo debe ser **lógica de servidor**
> (proceso programado o evaluación al iniciar sesión), no un efecto del cliente.

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/me/rest-schedule` | autenticado — resuelto para la fecha pedida |
| `PUT` | `/me/rest-schedule` | autenticado (modo individual) |
| `GET` | `/users/:id/rest-schedule` | department_head (ámbito) |
| `PUT` | `/users/:id/rest-schedule` | department_head (ámbito) |
| `GET` | `/departments/:id/rest-groups` | department_head (ámbito) |
| `POST` / `PATCH` / `DELETE` | `/rest-groups/:id` | global_manager |
| `PUT` | `/rest-groups/:id/members` | department_head (ámbito) |

Función de dominio compartida: `resolveRestDays(userId, date) → number[]`, usada por el
marcaje, la agregación diaria y la reportería. **Una sola implementación.**

## 7. UI

- **Empleado:** selector de días de la semana con la separación mínima validada en vivo
  ("No puedes descansar martes y miércoles: se exigen 2 días de separación").
- **Gestión de grupos:** lista de grupos por departamento con sus días y sus miembros;
  arrastrar/asignar personas.
- Vista de calendario del equipo mostrando quién descansa cada día — útil para el jefe.

## 8. Criterios de aceptación

- [ ] Cambiar los descansos con `effective_from` futuro no altera el reporte del mes pasado.
- [ ] Un día de descanso clasifica `DESCANSO`, nunca `AUSENTE`.
- [ ] Intentar marcar en día de descanso devuelve `REST_DAY`.
- [ ] Con grupos activados, la configuración individual del usuario se ignora.
- [ ] No se puede marcar como descanso un día con marcaje existente.
- [ ] La separación mínima se valida en servidor, no sólo en la UI.
- [ ] Un usuario sin descansos configurados recibe una única notificación recordatoria viva.

## 9. Decisiones abiertas

1. Convención de `days_of_week` (0=domingo vs 1=lunes) — confirmar contra los datos legacy.
2. Lista vacía en `rest_days_min_separation_departments`: ¿ninguno o todos? (RN-10.5)
3. ¿Mínimo/máximo de descansos semanales? (RN-10.9)
4. ¿El empleado elige o propone? (§4)
