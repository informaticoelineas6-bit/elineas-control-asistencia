# 01 · Organización: departamentos

> **Origen:** `old-docs.md` §3.1, puntos 3, 20 (modo pausa), 62.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado, salvo lo que depende de specs por venir
> (ver §8). Código: `apps/backend/src/services/departments.ts`,
> `apps/backend/src/routes/departments.ts`,
> `apps/frontend/src/routes/_authed/departments.tsx`. Pruebas:
> `apps/backend/src/routes/departments.test.ts`.
> **Depende de:** nada (es la raíz organizativa).
> **Habilita:** [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md),
> [07-horarios-y-calendario](./07-horarios-y-calendario.md),
> [10-descansos](./10-descansos.md), toda la reportería.

---

## 1. Objetivo

El departamento es el **ancla organizativa** de todo el sistema: de él cuelgan los perfiles,
los horarios de trabajo, los grupos de descanso, las responsabilidades de los jefes y el
alcance de los reportes. Nada de asistencia puede evaluarse sin saber a qué departamento
pertenece la persona.

Además el departamento puede **pausarse**, lo que suspende el marcaje de todos sus miembros
sin necesidad de desactivarlos uno a uno.

## 2. Actores y permisos

| Acción | employee | department_head | global_manager | superadmin |
|---|:--:|:--:|:--:|:--:|
| Ver lista de departamentos | ✅ | ✅ | ✅ | ✅ |
| Ver detalle/miembros de **su** departamento | ❌ | ✅ | ✅ | ✅ |
| Crear / renombrar / eliminar | ❌ | ❌ | ✅ | ✅ |
| Pausar / reanudar | ❌ | ❌ | ✅ | ✅ |
| Activar grupos de descanso (`rest_groups_enabled`) | ❌ | ❌ | ✅ | ✅ |

## 3. Modelo de datos

### `departments`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `name` | text, único | Nombre visible |
| `rest_groups_enabled` | boolean, default `false` | Si `true`, los descansos del departamento se gestionan por grupos y no individualmente (ver [10-descansos](./10-descansos.md)) |
| `is_paused` | boolean, default `false` | Bloquea el marcaje de todos sus miembros |
| `pause_reason` | text, nullable | Obligatorio cuando `is_paused = true` |
| `paused_at` | timestamptz, nullable | Se setea al pausar, se limpia al reanudar |
| `created_at` / `updated_at` | timestamptz | `updated_at` por trigger |

### Semilla inicial

**No hay semilla** (decisión 1, §9): el administrador crea los departamentos desde cero. La
lista del legacy —Picker and Packer, Expedición, Transporte, Inventario, Estibadores,
Administración— queda como referencia histórica, no como estado inicial.

> ⚠️ **El departamento de los gestores globales tiene semántica especial:** todo usuario con
> rol `global_manager` se fuerza a él (ver
> [03-roles-y-autorizacion](./03-roles-y-autorizacion.md), RN-03.6). Ya **no se identifica por
> el nombre "Administración"** sino por la clave de configuración
> `global_manager_department_id` ([06](./06-configuracion-global.md)); un literal atado a un
> nombre renombrable era la trampa del legacy. Mientras una configuración lo señale, **no puede
> eliminarse**. Renombrarlo sí se permite: la referencia es por id, así que el nombre ya no
> cambia el comportamiento de nada.

## 4. Reglas de negocio

- **RN-01.1** — `name` es único y no puede quedar vacío.
- **RN-01.2** — No se puede eliminar un departamento que tenga perfiles activos asociados.
  La operación debe fallar con un mensaje explícito, no borrar en cascada.
- **RN-01.3** — Al pausar un departamento, `pause_reason` es obligatorio y `paused_at` toma
  el instante de la pausa.
- **RN-01.4** — Mientras `is_paused = true`, **todo intento de marcaje de un miembro se
  rechaza** con el motivo de la pausa (ver [09-marcaje-asistencia](./09-marcaje-asistencia.md), RN-09.4).
  La pausa **no** afecta vacaciones, incidencias ni consultas de historial.
- **RN-01.5** — Al reanudar, `is_paused = false`, `pause_reason = null`, `paused_at = null`.
  No se recuperan retroactivamente los marcajes bloqueados durante la pausa; si hace falta,
  se corrigen vía [12-incidencias](./12-incidencias.md).
- **RN-01.6** — Cambiar `rest_groups_enabled` de `true` a `false` **no borra** los grupos
  existentes; sólo deja de usarlos para resolver los descansos. Debe advertirse en UI.
- **RN-01.7** — Un departamento pausado debe distinguirse visualmente en todos los listados
  (badge "En pausa" + motivo).

## 5. Flujos

### 5.1 Pausar un departamento
1. El gestor global abre la gestión de departamentos y elige *Pausar*.
2. Se le pide un motivo (texto libre, obligatorio).
3. Se persiste `is_paused/pause_reason/paused_at` y se escribe entrada en
   [18-auditoria](./18-auditoria.md).
4. **Propuesta (no existía en legacy):** notificar a los miembros del departamento
   (ver [14-notificaciones](./14-notificaciones.md)).

### 5.2 Eliminar un departamento
1. Validar que no haya perfiles asociados (RN-01.2).
2. Validar que no haya horarios, grupos de descanso ni responsabilidades colgando; ofrecer
   reasignación antes que borrado.

> **Estado:** implementado para perfiles, responsabilidades, referencias de la configuración
> ([06](./06-configuracion-global.md) RN-06.8) y **horario**
> ([07](./07-horarios-y-calendario.md)): con horario configurado el borrado responde 409 y hay
> que quitarlo antes, con `DELETE /departments/:id/schedule`. El bloqueo no es por integridad
> —la clave ajena es `on delete cascade`— sino porque un horario es una regla que alguien
> configuró y no debe desaparecer de rebote. Las filas del **calendario laboral** sí se van en
> cascada: son fechas, no una regla, y quedan en la bitácora del cambio que las creó.
>
> Los **grupos de descanso** ([10](./10-descansos.md)) bloquean también: el borrado responde 409
> mientras el departamento tenga alguno. Además de ser reglas configuradas, su historial de
> asignaciones sostiene reportes ya cerrados (RN-10.1), y la cascada los llevaría por delante sin
> más rastro que la entrada de bitácora del borrado.

## 6. API propuesta (`packages/contracts`)

| Método | Path | Descripción |
|---|---|---|
| `GET` | `/departments` | Lista. Filtro `?includePaused=` |
| `GET` | `/departments/:id` | Detalle + conteo de miembros |
| `GET` | `/departments/:id/members`| Listado de miembros de un departamento |
| `POST` | `/departments` | Crear |
| `PATCH` | `/departments/:id` | Renombrar, `rest_groups_enabled` |
| `POST` | `/departments/:id/pause` | Body: `{ reason }` |
| `POST` | `/departments/:id/resume` | |
| `DELETE` | `/departments/:id` | Sujeto a RN-01.2 |

Esquemas Zod en `packages/validations`: `departmentSchema`, `createDepartmentInput`,
`pauseDepartmentInput`.

## 7. UI

- **Gestión de departamentos** (rol administrativo): tabla con nombre, nº de miembros,
  estado de pausa, grupos de descanso activados. Acciones inline.
- La pantalla legacy (`DepartmentsManagement.tsx`) mezclaba tres cosas: CRUD de
  departamentos, grupos de descanso y asignación de responsabilidades multi-depto.
  **Decidido: se separan en tres vistas.** Esta spec cubre sólo el CRUD de departamentos
  (`/departments`); los grupos de descanso viven en `/rest-days` con la
  [10](./10-descansos.md) —ya construida— y las responsabilidades multi-departamento con la
  [02](./02-usuarios-y-perfiles.md) / [03](./03-roles-y-autorizacion.md).
- Las acciones de cada fila van en un **desplegable**, no como botones sueltos en la celda.

## 8. Criterios de aceptación

- [x] Crear un departamento con nombre duplicado falla con error legible. *(También sin
      distinguir mayúsculas: "Transporte" y "transporte" son el mismo departamento. Lo
      garantiza un índice único sobre `lower(name)` además del servicio.)*
- [x] Eliminar un departamento con miembros falla y no borra nada. *(Bloquea con **cualquier**
      perfil asociado, activo o desactivado: el historial de quien ya no trabaja aquí sigue
      necesitando su ancla. También bloquea si hay responsabilidades de jefes colgando, y si es
      el departamento de los gestores globales.)*
- [ ] Con el departamento pausado, un empleado del mismo no puede marcar y ve el motivo.
      **Bloqueado por la [09](./09-marcaje-asistencia.md):** todavía no hay marcaje que
      rechazar. La comprobación ya existe y está lista para invocarse:
      `assertDepartmentNotPaused` en `apps/backend/src/services/departments.ts`.
- [ ] Al reanudar, el mismo empleado puede marcar inmediatamente. **Bloqueado por la
      [09](./09-marcaje-asistencia.md)**, por lo mismo. Lo que sí está probado es que reanudar
      limpia `is_paused`, `pause_reason` y `paused_at` (RN-01.5).
- [x] La pausa y la reanudación quedan registradas en la bitácora. *(Con actor, motivo y estado
      anterior, en la misma transacción que el cambio — RN-18.4.)*
- [x] **Añadido:** los miembros activos reciben una notificación al pausar y al reanudar
      (decisión 3, §9).
- [x] **Añadido:** ningún endpoint de esta spec devuelve `monthly_salary`, ni el de miembros
      que consume `department_head` (spec 02 §6).

## 9. Decisiones tomadas

1. **Sin semilla: el administrador crea los departamentos desde cero.** Se retiró el script
   `db:seed` que insertaba los seis del legacy. Consecuencia asumida: recién instalado el
   sistema no hay ningún departamento, así que todos los perfiles nacen incompletos y nadie
   puede marcar hasta que se cree el primero y se asignen las personas. La pantalla lo dice
   explícitamente en su estado vacío.
2. **No hay jerarquía.** La organización es plana, como el legacy. Si algún día hace falta un
   departamento padre, es una migración, no un campo dejado "por si acaso".
3. **Sí se notifica a los miembros al pausar y reanudar**, y para eso se adelantó el mínimo
   viable del sistema de notificaciones de la [14](./14-notificaciones.md): tabla
   `notifications`, generación **en el servidor** dentro de la transacción del hecho, endpoints
   de lectura y campana en la cabecera. Entrega por sondeo cada 30 s; la entrega en vivo (SSE o
   WebSocket) sigue siendo decisión abierta de la 14.
