# 17 · Nómina: ajustes y descuentos

> **Origen:** `old-docs.md` §3.6, puntos 64, 65, 75, 76; hallazgo H-3.
> **Estado en el sistema legacy:** ⚠️ implementado con huecos conocidos (sin auditoría, sin notificación, divisor fijo).
> **Estado en el monorepo nuevo:** ⚠️ parcial, **y a propósito**: está construido el
> descuento automático que la [13](./13-justificacion-ausencias.md) necesita, y nada más.
> RN-13.4 no se puede implementar ni comprobar sin la tabla de ajustes, y crear media tabla para
> migrarla después habría sido peor que declararla entera y dejar sin escribir lo que todavía no
> se usa.
>
> **Hay:** la tabla `payroll_adjustments` completa (§2, con el índice único parcial de RN-17.5),
> `payroll_daily_divisor` en configuración (RN-17.3), la creación y reversión del descuento por
> ausencia injustificada en `apps/backend/src/services/payroll.ts` con su bitácora (RN-17.9) y
> su notificación (RN-17.10), y el redondeo decidido (RN-17.12).
>
> **No hay:** ni un solo endpoint. Buscar "payroll" en `apps/backend/src/routes/` no da nada, y
> eso **es** la barrera de RN-13.5 hoy: quien justifica una ausencia llama a `/absences` y el
> servidor escribe en nómina por él. Faltan los ajustes manuales (RN-17.8), la edición de
> sueldos, `/payroll/*` (§6), los totales por periodo, la página de la §5 y la presencia en la
> reportería (RN-17.11).
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

> Tres decisiones de diseño que la §2 dejaba al implementador, tomadas al construirla:
>
> - **`amount` es `numeric(12,2)` con signo**, la misma precisión que el sueldo. Un campo de
>   tipo y otro de valor absoluto obligarían a recordar el signo en cada suma; con el signo
>   dentro, el total de un periodo es un `sum()`.
> - **`effective_period` es el día 1 del mes**, no una cadena `yyyy-MM`: ordena y se filtra por
>   rango como cualquier otra fecha.
> - **`source_type`/`source_id` en vez de una clave ajena** a `attendance_absence_reviews`. Esta
>   spec admite ajustes manuales, que no tienen origen, y otros automáticos que vendrán de otras
>   tablas; una FK ataría la tabla al único origen que existe hoy.
>
> Y una columna que la §2 no lista: **`currency`**, copiada de la compensación al crear el
> ajuste. El importe nunca viaja sin su moneda, y en la misma plantilla puede haber gente
> cobrando en monedas distintas ([02](./02-usuarios-y-perfiles.md) §6a).

### Sueldo base

`profiles.monthly_salary` — ver [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md) §6
(hallazgo H-3: hoy sin barrera a nivel de columna). Decidir ahí si se mueve a tabla propia.

> **Ya se decidió y se movió**: el sueldo vive en `employee_compensation`, una tabla 1:1 con el
> perfil, precisamente para que ningún endpoint de perfiles pueda devolverlo por descuido. El
> descuento lo lee de ahí.

## 3. Reglas de negocio

- **RN-17.1 — Acceso exclusivo.** Sólo `global_manager` y `superadmin` leen y escriben nómina.
  **El `department_head` no accede**, aunque sus acciones generen ajustes
  ([13](./13-justificacion-ausencias.md) RN-13.5).
- **RN-17.2 — Descuento automático.** Marcar una ausencia como **no justificada** crea un
  ajuste con `amount = −(monthly_salary / divisor)`, `category = unjustified_absence`,
  `source_type = absence_review`, `source_id = <id de la revisión>`.
- **RN-17.3 — Divisor.** En el legacy está **fijo en 30** dentro de la función SQL (punto 75).
  **Requisito nuevo:** exponerlo como configuración (`payroll_daily_divisor`, default 30) en
  [06-configuracion-global](./06-configuracion-global.md). ✅ **Hecho.** Es la única clave del
  catálogo cuyo default **no** deja su regla inerte, y a propósito: un divisor no tiene valor
  neutro —el 0 sería una división por cero—, así que el default reproduce lo que el sistema ya
  hacía, que es el mismo espíritu del criterio de la spec 06. El mínimo es 1 para que la clave
  no pueda romper el cálculo desde la configuración.
  ⚠️ El documento legacy sugiere reutilizar `vacation_days_per_worked_day` para esto: **es un
  error**, son parámetros distintos. Clave nueva.
- **RN-17.4 — Reversión, no borrado.** Reclasificar la ausencia como justificada marca el
  ajuste `reverted` con autor y fecha. **Nunca se borra un ajuste.** El historial económico es
  inmutable.
- **RN-17.5 — Idempotencia.** Un mismo `source_id` no puede tener dos ajustes `active`
  simultáneos. Debe existir restricción en base, no sólo control en código.
  > ✅ Índice único **parcial** sobre (`source_type`, `source_id`) `where status = 'active' and
  > source_id is not null`. Parcial porque los revertidos sí conviven: RN-13.4 dice que volver a
  > "injustificada" crea un ajuste **nuevo**, así que un origen acumula filas revertidas y como
  > mucho una activa. Y `source_id is not null` porque los ajustes manuales no tendrán origen y
  > no deben competir entre sí.
- **RN-17.6 — Las vacaciones no descuentan.** Decisión de negocio **explícita**: son días
  pagados. La categoría `vacation` existe sólo para ajustes manuales que un administrador
  decida registrar. ([11](./11-vacaciones.md) RN-11.11.)
- **RN-17.7 — Sin sueldo, sin descuento.** Si `monthly_salary` es nulo o cero, no se crea el
  ajuste automático; debe registrarse una advertencia visible para el administrador, no
  fallar en silencio. *(Comportamiento no documentado en el legacy — definir.)*
  > **Definido:** la revisión de la ausencia **no falla** —que se cayera por un dato de otro
  > departamento dejaría la decisión sin tomar— y la respuesta trae `effect:
  > "skipped_no_salary"`, que la interfaz enseña a quien acaba de actuar.
  >
  > ⚠️ La advertencia **no** se puede además notificar "a los administradores" como grupo: este
  > sistema no sabe quién tiene rol `global_manager` sin que esa persona se autentique
  > (RN-00.43). Es la cuarta aparición de la decisión 3 de la [11](./11-vacaciones.md) §9, y aquí
  > la salida es que lo vea el propio revisor.
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
  `monthly_salary / divisor`.
  > **Cerrada: el cálculo se hace en PostgreSQL**, `-round(monthly_salary::numeric / divisor,
  > 2)`, con el sueldo viajando como cadena hasta el parámetro. Dos decimales, media al alza,
  > exacto. **No se calcula en JavaScript**: pasarlo por un `double` es exactamente lo que la
  > compensación de la [02](./02-usuarios-y-perfiles.md) evita al representar el importe como
  > cadena — un dato de dinero no pasa por coma flotante.
  >
  > La moneda **no es S/**: la empresa opera en Cuba ([06](./06-configuracion-global.md) §8) y
  > cada sueldo lleva la suya, del vocabulario cerrado de `currencySchema` (CUP, USD, EUR, MLC,
  > Tropical, Clásica). El ajuste la copia del sueldo al crearse.

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

Página de nómina (`/payroll`), sólo rol administrativo:

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

> **Ninguno de estos endpoints existe todavía**, y esa es la barrera de
> [13](./13-justificacion-ausencias.md) RN-13.5 en su forma más simple: un jefe recibe **404**,
> no 403. Cuando se construyan, cada uno lleva su `requireRole("global_manager")` y hay una
> prueba en `routes/absences.test.ts` que hay que actualizar de 404 a 403.
>
> Sobre la decisión abierta, un dato que ya está resuelto en parte: **el empleado sí ve el
> importe de su propio descuento**, en la notificación de RN-17.10. Es su sueldo y es el dato
> que necesita para reclamar. Lo que no tiene es una pantalla con su historial de ajustes.

## 7. Periodo de nómina

El legacy no modela periodos: los ajustes se filtran por fecha de creación. Eso es frágil —
un descuento por una ausencia de marzo registrado en abril, ¿a qué mes pertenece?

**Propuesta:** `effective_period` explícito, calculado a partir de la **fecha de la ausencia**
(no de la fecha de registro), y una noción de periodo cerrado tras la cual un ajuste ya no se
modifica y las correcciones van al periodo siguiente
([13](./13-justificacion-ausencias.md) RN-13.9).

> **La primera mitad está hecha**: `effective_period` es el día 1 del mes de la ausencia
> (`effectivePeriodOf`), así que la pregunta de arriba ya tiene respuesta — un descuento por una
> ausencia de marzo registrado en abril pertenece a marzo.
>
> **El cierre de periodo sigue abierto** (decisión 2), y es lo que bloquea RN-13.9. Se puede
> decidir después sin migrar nada: los datos ya están imputados al mes correcto.

## 8. Criterios de aceptación

Cinco de estos nueve ya se cumplen con lo que trajo la [13](./13-justificacion-ausencias.md);
los cuatro que quedan necesitan la superficie de administración, que no existe.

- [ ] Un `department_head` recibe 403 en todos los endpoints de nómina. *(Hoy **404**: no hay
      endpoints. Comprobado así en `routes/absences.test.ts`.)*
- [x] Marcar una ausencia injustificada crea un ajuste con el monto exacto esperado.
- [x] Reclasificar la revierte; no queda ningún registro borrado.
- [x] Dos escrituras concurrentes de la misma revisión no crean dos ajustes activos (RN-17.5,
      restricción en base).
- [x] Un empleado sin sueldo configurado no rompe el flujo de justificación.
- [x] Todo ajuste aparece en la bitácora. *(Y todo cambio de sueldo ya lo hacía, desde la
      [02](./02-usuarios-y-perfiles.md): `compensation.updated`.)*
- [x] El empleado recibe notificación de cada ajuste. *(De los que existen: los de ausencia. Los
      manuales necesitarán su propio tipo de notificación, porque no nacen de una clasificación.)*
- [ ] El reporte mensual incluye los ajustes del periodo. *(Necesita la [16](./16-reporteria-mensual.md).)*
- [ ] Los totales por departamento cuadran con la suma de ajustes activos. *(Necesita
      `/payroll/summary`.)*

## 9. Decisiones abiertas

1. ~~Redondeo y decimales del descuento diario.~~ **Cerrada: dos decimales, media al alza, y el
   cálculo en PostgreSQL sobre `numeric`.** Ver RN-17.12.
2. **⚠️ Sigue abierta — ¿cierre de periodo?** (§7) El `effective_period` ya está; lo que falta
   es la noción de "este mes ya no admite cambios", y es lo que bloquea
   [13](./13-justificacion-ausencias.md) RN-13.9.
3. ¿El empleado ve sus propios ajustes? (§6) — resuelta a medias: ve el importe de su descuento
   en la notificación, pero no tiene pantalla.
4. ¿El descuento debería ser proporcional a horas no trabajadas en vez de día completo?
5. ¿Otros conceptos automáticos (tardanzas acumuladas, horas extra)? Hoy sólo la ausencia
   injustificada descuenta.
