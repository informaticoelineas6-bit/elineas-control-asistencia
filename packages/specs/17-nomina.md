# 17 · Nómina: ajustes y descuentos

> **Origen:** `old-docs.md` §3.6, puntos 64, 65, 75, 76; hallazgo H-3.
> **Estado en el sistema legacy:** ⚠️ implementado con huecos conocidos (sin auditoría, sin notificación, divisor fijo).
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Depende de:** [13-justificacion-ausencias](./13-justificacion-ausencias.md), [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md).

---

## 1. Objetivo

Registrar los **ajustes económicos** sobre el sueldo de una persona: descuentos automáticos
por ausencia injustificada y ajustes manuales de cualquier signo. No es un sistema de nómina
completo: no calcula planilla, no emite boletas. Produce el **listado de ajustes del periodo**
que alimenta al proceso de nómina real, sea cual sea.

> Este es el módulo con más impacto y menos madurez del legacy. Tratar con cuidado.

## 2. Modelo de datos

### `payroll_adjustments`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | Afectado |
| `amount` | numeric | **Con signo**: negativo = descuento, positivo = bonificación |
| `category` | enum | `unjustified_absence` · `vacation` · `other` |
| `description` | text, nullable | |
| `status` | enum | `active` · `reverted` |
| `source_type` | text, nullable | Qué lo originó (p. ej. `absence_review`) |
| `source_id` | uuid, nullable | Identificador del origen |
| `effective_period` | date/text | **Propuesta**: a qué periodo de nómina pertenece (§7) |
| `created_by` | uuid | |
| `reverted_by` | uuid, nullable | |
| `reverted_at` | timestamptz, nullable | |
| `created_at` | timestamptz | |

### Sueldo base

`profiles.monthly_salary` — ver [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md) §6
(hallazgo H-3: hoy sin barrera a nivel de columna). Decidir ahí si se mueve a tabla propia.

## 3. Reglas de negocio

- **RN-17.1 — Acceso exclusivo.** Sólo `global_manager` y `superadmin` leen y escriben nómina.
  **El `department_head` no accede**, aunque sus acciones generen ajustes
  ([13](./13-justificacion-ausencias.md) RN-13.5).
- **RN-17.2 — Descuento automático.** Marcar una ausencia como **no justificada** crea un
  ajuste con `amount = −(monthly_salary / divisor)`, `category = unjustified_absence`,
  `source_type = absence_review`, `source_id = <id de la revisión>`.
- **RN-17.3 — Divisor.** En el legacy está **fijo en 30** dentro de la función SQL (punto 75).
  **Requisito nuevo:** exponerlo como configuración (`payroll_daily_divisor`, default 30) en
  [06-configuracion-global](./06-configuracion-global.md).
  ⚠️ El documento legacy sugiere reutilizar `vacation_days_per_worked_day` para esto: **es un
  error**, son parámetros distintos. Clave nueva.
- **RN-17.4 — Reversión, no borrado.** Reclasificar la ausencia como justificada marca el
  ajuste `reverted` con autor y fecha. **Nunca se borra un ajuste.** El historial económico es
  inmutable.
- **RN-17.5 — Idempotencia.** Un mismo `source_id` no puede tener dos ajustes `active`
  simultáneos. Debe existir restricción en base, no sólo control en código.
- **RN-17.6 — Las vacaciones no descuentan.** Decisión de negocio **explícita**: son días
  pagados. La categoría `vacation` existe sólo para ajustes manuales que un administrador
  decida registrar. ([11](./11-vacaciones.md) RN-11.11.)
- **RN-17.7 — Sin sueldo, sin descuento.** Si `monthly_salary` es nulo o cero, no se crea el
  ajuste automático; debe registrarse una advertencia visible para el administrador, no
  fallar en silencio. *(Comportamiento no documentado en el legacy — definir.)*
- **RN-17.8 — Ajustes manuales.** Un `global_manager` puede crear un ajuste de cualquier signo
  con motivo obligatorio, y revertirlo.
- **RN-17.9 — Auditoría.** ⚠️ **Hueco del legacy (punto 76):** los ajustes **no** llegan a la
  bitácora. Requisito nuevo: toda creación y reversión se registra en
  [18-auditoria](./18-auditoria.md), y también todo cambio de `monthly_salary`.
- **RN-17.10 — Notificación al empleado.** ⚠️ **Hueco del legacy (punto 76):** el empleado no
  se entera. Requisito nuevo: notificarle al aplicarse y al revertirse un ajuste
  ([14](./14-notificaciones.md)).
- **RN-17.11 — Presencia en la reportería.** ⚠️ **Hueco del legacy (punto 76):** los ajustes no
  aparecen en el XLSX ni en Sheets. Requisito nuevo: sección o pestaña de ajustes del periodo
  en el reporte mensual ([16](./16-reporteria-mensual.md)).
- **RN-17.12 — Redondeo y moneda.** Definir: moneda (S/), decimales y modo de redondeo del
  `monthly_salary / divisor`. **Decisión abierta** — sin esto, cada implementación redondea
  distinto y los totales no cuadran.

## 4. Flujos

### 4.1 Descuento automático (el importante)

```
Jefe marca ausencia como NO justificada
  → misma transacción:
      · upsert de attendance_absence_reviews
      · creación del payroll_adjustment (con privilegio elevado, RN-13.5)
      · entrada en bitácora
      · notificación al empleado
```

Reclasificar a justificada ejecuta la cadena inversa (reversión, bitácora, notificación).

### 4.2 Ajuste manual
Administrador → elige empleado, monto con signo, categoría y motivo → se crea `active`.

### 4.3 Reversión manual
Administrador → marca `reverted` con motivo. No se borra.

## 5. UI

Página de nómina (`/nomina`), sólo rol administrativo:

- **Sueldos** — edición de `monthly_salary` por empleado, con filtro por departamento.
- **Historial de ajustes** — filtros por departamento, empleado, periodo, categoría y estado;
  totales por empleado y por departamento.
- **Alta manual** y **reversión**, ambas con motivo obligatorio.
- Al revertir, mostrar de dónde vino el ajuste (enlace a la revisión de ausencia que lo creó).

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/payroll/adjustments?period=&departmentId=&userId=&status=` | global_manager |
| `POST` | `/payroll/adjustments` | global_manager |
| `POST` | `/payroll/adjustments/:id/revert` | global_manager |
| `GET` | `/payroll/salaries` | global_manager |
| `PUT` | `/payroll/salaries/:userId` | global_manager |
| `GET` | `/payroll/summary?period=` | global_manager — totales por empleado/departamento |

Ningún endpoint de nómina es accesible a `department_head` ni a `employee`.
**Decisión abierta:** ¿el empleado debería ver sus propios ajustes? Hoy no puede.

## 7. Periodo de nómina

El legacy no modela periodos: los ajustes se filtran por fecha de creación. Eso es frágil —
un descuento por una ausencia de marzo registrado en abril, ¿a qué mes pertenece?

**Propuesta:** `effective_period` explícito, calculado a partir de la **fecha de la ausencia**
(no de la fecha de registro), y una noción de periodo cerrado tras la cual un ajuste ya no se
modifica y las correcciones van al periodo siguiente
([13](./13-justificacion-ausencias.md) RN-13.9).

## 8. Criterios de aceptación

- [ ] Un `department_head` recibe 403 en todos los endpoints de nómina.
- [ ] Marcar una ausencia injustificada crea un ajuste con el monto exacto esperado.
- [ ] Reclasificar la revierte; no queda ningún registro borrado.
- [ ] Dos escrituras concurrentes de la misma revisión no crean dos ajustes activos (RN-17.5,
      restricción en base).
- [ ] Un empleado sin sueldo configurado no rompe el flujo de justificación.
- [ ] Todo ajuste y todo cambio de sueldo aparece en la bitácora.
- [ ] El empleado recibe notificación de cada ajuste.
- [ ] El reporte mensual incluye los ajustes del periodo.
- [ ] Los totales por departamento cuadran con la suma de ajustes activos.

## 9. Decisiones abiertas

1. Redondeo y decimales del descuento diario. (RN-17.12)
2. ¿Periodo de nómina propio y cierre de periodo? (§7)
3. ¿El empleado ve sus propios ajustes? (§6)
4. ¿El descuento debería ser proporcional a horas no trabajadas en vez de día completo?
5. ¿Otros conceptos automáticos (tardanzas acumuladas, horas extra)? Hoy sólo la ausencia
   injustificada descuenta.
