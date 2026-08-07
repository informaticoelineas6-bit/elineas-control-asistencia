# 01 · Organización: departamentos

> **Origen:** `old-docs.md` §3.1, puntos 3, 20 (modo pausa), 62.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe.
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

Picker and Packer · Expedición · Transporte · Inventario · Estibadores · **Administración**

> ⚠️ **Administración es un departamento con semántica especial:** todo usuario con rol
> `global_manager` se fuerza a este departamento (ver
> [03-roles-y-autorizacion](./03-roles-y-autorizacion.md), RN-03.6). No debe poder
> eliminarse ni renombrarse mientras existan gestores globales.

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

## 6. API propuesta (`packages/specs`)

| Método | Path | Descripción |
|---|---|---|
| `GET` | `/departments` | Lista. Filtro `?includePaused=` |
| `GET` | `/departments/:id` | Detalle + conteo de miembros |
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
  **Decisión pendiente:** mantener esa unificación o separarla en tres vistas.

## 8. Criterios de aceptación

- [ ] Crear un departamento con nombre duplicado falla con error legible.
- [ ] Eliminar un departamento con miembros falla y no borra nada.
- [ ] Con el departamento pausado, un empleado del mismo no puede marcar y ve el motivo.
- [ ] Al reanudar, el mismo empleado puede marcar inmediatamente.
- [ ] La pausa y la reanudación quedan registradas en la bitácora.

## 9. Decisiones abiertas

1. ¿La semilla de departamentos se mantiene fija o el cliente puede empezar de cero?
2. ¿Se permite jerarquía (departamento padre/hijo)? El legacy es plano; asumimos plano.
3. ¿Notificar a los miembros al pausar/reanudar?
