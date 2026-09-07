# 06 · Configuración global

> **Origen:** `old-docs.md` §3.6, §3.7, punto 15.
> **Estado en el sistema legacy:** ✅ implementado (`app_config`, clave/valor JSONB).
> **Estado en el monorepo nuevo:** ✅ implementado. Tabla `app_config`, catálogo completo de §3
> tipado con default en código (`packages/validations/src/config.ts`), caché con invalidación al
> escribir (RN-06.7), auditoría del cambio (RN-06.3), validación cruzada del modo de salida
> (RN-06.5), `GET`/`PATCH /api/config` restringidos a `global_manager+` (RN-06.1) y
> `GET /api/config/public` con la lista blanca de §5. La pestaña *General* está en
> `apps/frontend/src/modules/config/config-form.tsx` y la de *Horarios y calendario* en
> `apps/frontend/src/modules/schedules/` ([07](./07-horarios-y-calendario.md)) y la de *Sedes y
> geocerca* en `apps/frontend/src/modules/locations/` ([08](./08-sedes-y-geocerca.md)). Pruebas en
> `apps/backend/src/routes/config.test.ts`.
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

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `global_timezone` | string IANA | `America/Havana` | Todo cálculo de fecha/hora |
| `default_work_start_time` | `HH:mm` \| null | `null` | [07](./07-horarios-y-calendario.md) al crear horarios |
| `default_work_end_time` | `HH:mm` \| null | `null` | idem |
| `late_tolerance_minutes` | int 0–240 | `0` | [09](./09-marcaje-asistencia.md) RN-09.7 |

> **Criterio de los defaults.** El valor por defecto es el que hace que el sistema se comporte
> *como si la clave no estuviera configurada* — nunca un valor plausible inventado. Una
> tolerancia de 0 minutos o una tasa de vacaciones de 0 se notan enseguida y se corrigen; una
> inventada se queda ahí produciendo cálculos equivocados que nadie revisa.

### 3.2 Modo de salida

| Clave | Tipo | Valores | Default | Consumido por |
|---|---|---|---|---|
| `attendance_checkout_mode` | enum | `manual` · `schedule` · `geofence_exit` | `manual` | [09](./09-marcaje-asistencia.md) RN-09.13 |
| `attendance_auto_checkout_time` | `HH:mm` \| null | obligatoria si modo `schedule` | `null` | idem |
| `attendance_geofence_exit_minutes` | int 1–720 \| null | obligatorio si modo `geofence_exit` | `null` | idem |

> ⚠️ El modo `geofence_exit` **no es fiable hoy** y la interfaz lo advierte al elegirlo: necesita
> seguimiento de ubicación en segundo plano, que Android corta ([08](./08-sedes-y-geocerca.md) §4,
> deuda del punto 77). La clave se queda en el catálogo; ofrecerlo de verdad es una decisión de la
> [20](./20-app-movil-y-distribucion.md).

### 3.3 Descansos

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `rest_days_min_separation` | int 0–31 (días) | `0` (regla desactivada) | [10](./10-descansos.md) RN-10.5 |
| `rest_days_min_separation_departments` | uuid[] | `[]` = **todos** | acota a qué departamentos aplica la regla anterior |
| `rest_days_min_per_week` | int 0–7 | `0` (sin mínimo) | [10](./10-descansos.md) RN-10.9 |
| `rest_days_max_per_week` | int 0–7 | `7` (sin máximo) | [10](./10-descansos.md) RN-10.9 |

> **La lista vacía significa "a todos"** ([10](./10-descansos.md), decisión 2, cerrada): el
> interruptor de la regla es el número —0 la desactiva— y la lista sólo la acota. Con el criterio
> contrario habría dos formas de decir "a nadie" y ninguna de decir "a todos" sin enumerar los
> departamentos y acordarse de añadir cada uno nuevo.
>
> Los límites semanales son **configuración y no un número en el código** porque la cifra es una
> regla laboral que pone el negocio; los defaults dejan la regla inerte, siguiendo el criterio de
> esta spec. Un mínimo por encima del máximo se rechaza al guardar (RN-06.5): no invalidaría una
> elección concreta de días, sino todas.

### 3.4 Vacaciones

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `vacation_days_per_worked_day` | number 0–1 | `0` (nadie acumula) | [11](./11-vacaciones.md) RN-11.2 — ya en uso: multiplica los días trabajados para dar `earned` |

> ⚠️ En el legacy esta clave aparece además citada como candidata para el **divisor de
> nómina** (punto 75), que hoy está fijo en `/30` dentro de la función SQL. Son **dos cosas
> distintas**: no reutilizar la misma clave. Ver [17-nomina](./17-nomina.md) §7.

### 3.5 Incidencias

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `incident_report_window_days` | int 0–365 | `0` (sin plazo) | [12](./12-incidencias.md) RN-12.4 |

> **`0` desactiva el plazo**, y por eso es el default: el interruptor es el número, igual que en
> `rest_days_min_separation`. La spec 12 proponía 7 días; la cifra es una regla laboral —¿hasta
> cuándo se admite un reclamo sobre un mes ya pagado?— y la pone el negocio. Sin plazo, alguien
> puede reclamar un día de hace seis meses; con uno mal elegido, alguien de baja médica pierde
> la vía formal de reportar. Ninguna de las dos la decide el código, y lo que tenía que existir
> ya es el sitio donde ponerla.

### 3.6 Nómina

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `payroll_daily_divisor` | int 1–31 | `30` (lo que hacía el legacy) | [17](./17-nomina.md) RN-17.3 |

> Es la **única clave del catálogo cuyo default no deja su regla inerte**, y es deliberado: un
> divisor no tiene valor neutro —el 0 sería una división por cero—, así que el default reproduce
> lo que el sistema ya hacía, que es el mismo espíritu del criterio de arriba. El mínimo es 1
> para que la clave no pueda romper el cálculo desde la configuración.
>
> En el legacy este 30 estaba **fijo dentro de una función SQL** (punto 75), que es exactamente
> el tipo de número que hay que poder cambiar sin despliegue.
>
> ⚠️ **No es la tasa de vacaciones.** `old-docs.md` sugería reutilizar
> `vacation_days_per_worked_day` para esto y es un error: son parámetros distintos (§3.4,
> [17](./17-nomina.md) §7).

### 3.7 Reportería

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `include_heads_in_global_reports` | boolean | `true` | [16](./16-reporteria-mensual.md) |
| `report_slo_error_rate_pct` | number 0–100 | `1` | [16](./16-reporteria-mensual.md) §KPIs |
| `report_slo_availability_pct` | number 0–100 | `99` | idem |
| `google_sheets_report_spreadsheet_id` | string \| null | `null` | [16](./16-reporteria-mensual.md) §Sheets |

### 3.8 Ámbito

| Clave | Tipo | Default | Consumido por |
|---|---|---|---|
| `global_manager_department_id` | uuid \| null | `null` (regla desactivada) | [03](./03-roles-y-autorizacion.md) RN-03.6 |

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
  `attendance_geofence_exit_minutes` es obligatorio y > 0. Se valida el resultado **efectivo**,
  no el parche: alguien puede fijar la hora hoy y cambiar el modo mañana, y lo que tiene que
  quedar coherente es lo guardado. La misma función (`checkoutModeIssue`) la usan el servidor y
  el formulario, para que el aviso salga al teclear y no al recibir el 400.
- **RN-06.6** — La zona horaria es **una sola global**, pero cada departamento tiene además
  la suya en su horario ([07](./07-horarios-y-calendario.md)). Precedencia: la del
  departamento gana; la global es el default al crear un horario nuevo. *Confirmar que este
  era el comportamiento real del legacy.* **Decisión abierta.** Implementado así en la
  [07](./07-horarios-y-calendario.md): omitir la zona al crear un horario toma la global, y
  omitirla al actualizar **conserva la que tenía** — tratar la omisión como "vuelve a la global"
  movería de zona a un departamento por no repetir un campo que nadie tocó.
- **RN-06.7** — La configuración se cachea en el backend; una escritura invalida la caché de
  forma inmediata. ⚠️ Con la implementación actual la caché es **de proceso** (TTL de 30 s):
  con una sola instancia del backend la invalidación es efectivamente inmediata, pero con
  varias cada proceso podría servir un valor viejo durante ese TTL. Cuando haya más de una
  instancia, esto pasa a Redis o a escuchar `NOTIFY`.
- **RN-06.8 — Los ids de departamento se comprueban al escribir.** Un id que no existe en
  `global_manager_department_id` o en `rest_days_min_separation_departments` dejaría la regla
  apuntando al vacío. Y al revés: un departamento referenciado por la configuración no se puede
  borrar ([01](./01-organizacion-departamentos.md) §3).

## 5. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/config` | global_manager |
| `PATCH` | `/config` | global_manager — body: mapa parcial clave→valor, validado por clave |
| `GET` | `/config/public` | autenticado — subconjunto seguro (zona horaria, modo de salida, tolerancia) |

El subconjunto público es una **lista blanca explícita** (`PUBLIC_CONFIG_KEYS`), no un "todo
menos X": añadir una clave al catálogo no debe exponerla por descuido. Hoy son
`global_timezone`, `late_tolerance_minutes`, las tres del modo de salida y
`incident_report_window_days` — esta última porque el formulario de incidencias tiene que
poder decir "esa fecha ya quedó fuera de plazo" antes de enviar, con la misma cifra que aplica
el servidor ([12](./12-incidencias.md) RN-12.4). Es un plazo, igual que la tolerancia: no
revela nada.

## 6. UI

Pestaña *General* dentro de Configuración, agrupada por las secciones de §3. Cada campo con
su descripción de qué afecta — un valor mal puesto aquí cambia el cálculo de asistencia de
toda la empresa.

## 7. Criterios de aceptación

- [x] Guardar `attendance_checkout_mode = schedule` sin hora falla con error de validación.
- [x] Una clave ausente en base devuelve el default de código.
- [x] Un valor con tipo inválido en base no rompe la app: cae al default y se registra.
- [ ] Cambiar la tolerancia no altera el estado de días ya cerrados. *(Con la
      [09](./09-marcaje-asistencia.md): todavía no hay días que cerrar.)*
- [x] Un `department_head` recibe 403 en `GET /config`.
- [x] `GET /config/public` lo lee cualquier autenticado y no devuelve ninguna clave privada.

## 8. Decisiones abiertas

> **Confirmado:** `global_timezone` es `America/Havana` y la interfaz formatea fechas con
> `es-CU`. La empresa opera en Cuba: las monedas del sueldo son CUP, MLC, TRO y CLA
> ([02](./02-usuarios-y-perfiles.md) §6) y el Identity Server valida los teléfonos con país por
> defecto `CU`.


1. Precedencia real entre zona horaria global y por departamento (RN-06.6).
2. ¿Configuración por departamento para alguna de estas claves, o sólo global?
3. ¿Historial de cambios de configuración propio, o basta la bitácora general?
