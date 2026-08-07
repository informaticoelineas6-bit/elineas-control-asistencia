# 06 · Configuración global

> **Origen:** `old-docs.md` §3.6, §3.7, punto 15.
> **Estado en el sistema legacy:** ✅ implementado (`app_config`, clave/valor JSONB).
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Depende de:** [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).
> **Habilita:** casi todas las reglas de asistencia leen de aquí.

---

## 1. Objetivo

Un único lugar donde viven los parámetros que cambian el comportamiento del sistema sin
tocar código: zona horaria, tolerancias, modos de salida, tasa de acumulación de vacaciones,
SLOs de reportería. Debe construirse **antes** que las reglas de asistencia, porque casi
todas dependen de estos valores.

## 2. Modelo de datos

### `app_config`

| Campo | Tipo | Notas |
|---|---|---|
| `key` | text PK | |
| `value` | jsonb | |
| `updated_at` | timestamptz | |
| `updated_by` | uuid, nullable | |

> El legacy usa clave/valor con JSONB. Es flexible pero **no tipado**.
> **Propuesta para el monorepo:** mantener la tabla clave/valor, pero definir un esquema Zod
> por clave en `packages/validations` y un objeto de configuración tipado que valide al leer.
> Un valor corrupto en base debe caer al default declarado, no romper la aplicación.

## 3. Catálogo de claves

### 3.1 Tiempo y jornada

| Clave | Tipo | Default sugerido | Consumido por |
|---|---|---|---|
| `global_timezone` | string IANA | `America/Lima` (confirmar) | Todo cálculo de fecha/hora |
| `default_work_start_time` | `HH:mm` | — | [07](./07-horarios-y-calendario.md) al crear horarios |
| `default_work_end_time` | `HH:mm` | — | idem |
| `late_tolerance_minutes` | int ≥ 0 | — | [09](./09-marcaje-asistencia.md) RN-09.7 |

### 3.2 Modo de salida

| Clave | Tipo | Valores | Consumido por |
|---|---|---|---|
| `attendance_checkout_mode` | enum | `manual` · `schedule` · `geofence_exit` | [09](./09-marcaje-asistencia.md) RN-09.13 |
| `attendance_auto_checkout_time` | `HH:mm` | sólo si modo `schedule` | idem |
| `attendance_geofence_exit_minutes` | int | sólo si modo `geofence_exit` | idem |

### 3.3 Descansos

| Clave | Tipo | Consumido por |
|---|---|---|
| `rest_days_min_separation` | int (días) | [10](./10-descansos.md) RN-10.5 |
| `rest_days_min_separation_departments` | uuid[] | acota a qué departamentos aplica la regla anterior |

### 3.4 Vacaciones

| Clave | Tipo | Consumido por |
|---|---|---|
| `vacation_days_per_worked_day` | number | [11](./11-vacaciones.md) RN-11.2 |

> ⚠️ En el legacy esta clave aparece además citada como candidata para el **divisor de
> nómina** (punto 75), que hoy está fijo en `/30` dentro de la función SQL. Son **dos cosas
> distintas**: no reutilizar la misma clave. Ver [17-nomina](./17-nomina.md) §7.

### 3.5 Reportería

| Clave | Tipo | Consumido por |
|---|---|---|
| `include_heads_in_global_reports` | boolean | [16](./16-reporteria-mensual.md) |
| `report_slo_error_rate_pct` | number | [16](./16-reporteria-mensual.md) §KPIs |
| `report_slo_availability_pct` | number | idem |
| `google_sheets_report_spreadsheet_id` | string | [16](./16-reporteria-mensual.md) §Sheets |

## 4. Reglas de negocio

- **RN-06.1** — Sólo `global_manager` y `superadmin` leen y escriben la configuración
  completa. Algunas claves (zona horaria, tolerancia) las **lee** cualquier rol de forma
  indirecta a través de los endpoints que las aplican, pero la tabla no se expone entera.
- **RN-06.2** — Toda clave tiene un valor por defecto en código. La base sólo guarda
  sobrescrituras.
- **RN-06.3** — Un cambio de configuración se registra en [18-auditoria](./18-auditoria.md)
  con valor anterior y nuevo.
- **RN-06.4** — Los cambios **no son retroactivos**. Cambiar la tolerancia de tardanza hoy no
  reclasifica marcajes de ayer. Para reportería esto se materializa en versiones de reglas
  ([16-reporteria-mensual](./16-reporteria-mensual.md) §versiones).
- **RN-06.5** — Validación cruzada al guardar: si `attendance_checkout_mode = schedule`,
  `attendance_auto_checkout_time` es obligatorio; si es `geofence_exit`,
  `attendance_geofence_exit_minutes` es obligatorio y > 0.
- **RN-06.6** — La zona horaria es **una sola global**, pero cada departamento tiene además
  la suya en su horario ([07](./07-horarios-y-calendario.md)). Precedencia: la del
  departamento gana; la global es el default al crear un horario nuevo. *Confirmar que este
  era el comportamiento real del legacy.* **Decisión abierta.**
- **RN-06.7** — La configuración se cachea en el backend; una escritura invalida la caché de
  forma inmediata para todos los procesos.

## 5. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/config` | global_manager |
| `PATCH` | `/config` | global_manager — body: mapa parcial clave→valor, validado por clave |
| `GET` | `/config/public` | autenticado — subconjunto seguro (zona horaria, modo de salida, tolerancia) |

## 6. UI

Pestaña *General* dentro de Configuración, agrupada por las secciones de §3. Cada campo con
su descripción de qué afecta — un valor mal puesto aquí cambia el cálculo de asistencia de
toda la empresa.

## 7. Criterios de aceptación

- [ ] Guardar `attendance_checkout_mode = schedule` sin hora falla con error de validación.
- [ ] Una clave ausente en base devuelve el default de código.
- [ ] Un valor con tipo inválido en base no rompe la app: cae al default y se registra.
- [ ] Cambiar la tolerancia no altera el estado de días ya cerrados.
- [ ] Un `department_head` recibe 403 en `GET /config`.

## 8. Decisiones abiertas

1. Precedencia real entre zona horaria global y por departamento (RN-06.6).
2. ¿Configuración por departamento para alguna de estas claves, o sólo global?
3. ¿Historial de cambios de configuración propio, o basta la bitácora general?
