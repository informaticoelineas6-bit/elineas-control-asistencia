# 17 · Nómina: ajustes y descuentos

> **Origen:** `old-docs.md` §3.6, puntos 64, 65, 75, 76; hallazgo H-3.
> **Estado en el sistema legacy:** ⚠️ implementado con huecos conocidos (sin auditoría, sin notificación, divisor fijo).
> **Estado en el monorepo nuevo:** ✅ implementada, **menos el cierre de periodo** (decisión 2,
> que sigue abierta a propósito). Se construyó en dos tiempos: el descuento automático lo
> adelantó la [13](./13-justificacion-ausencias.md) —RN-13.4 no se puede implementar ni comprobar
> sin la tabla de ajustes— y la superficie de administración de la §5 y la §6 llegó después,
> encima del mismo modelo y sin migrar nada.
>
> Vocabulario en `packages/validations/src/payroll.ts` (con `buildPayrollGrid`); contrato en
> `packages/contracts/src/payroll.ts`; tabla `payroll_adjustments` (§2, con el índice único
> parcial de RN-17.5 y `revert_reason`); `payroll_daily_divisor` en configuración (RN-17.3);
> dominio en `apps/backend/src/services/payroll.ts`, donde **las dos funciones del descuento
> automático siguen sin ninguna ruta que las exponga** (RN-13.5) y las cinco de administración
> cuelgan de `apps/backend/src/routes/payroll.ts` detrás de un solo
> `requireRole("global_manager")`. Interfaz: `/payroll` con sus dos pestañas
> (`apps/frontend/src/modules/payroll/`). Pruebas: 28 de integración en
> `apps/backend/src/routes/payroll.test.ts`, más la cadena de la 13 en `absences.test.ts`.
>
> **No hay:** el **cierre de periodo** (§7 y decisión 2), que es lo único que bloquea a la
> [13](./13-justificacion-ausencias.md) RN-13.9, y la pantalla del empleado con su propio
> historial (decisión 3). Y una cosa que la spec pedía y se resolvió de otra forma: los ajustes
> **no** viajan dentro del XLSX del reporte mensual, sino en su propio archivo (RN-17.11).
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
  > ✅ Y también a mano, desde `/payroll`, con **motivo obligatorio** en la columna
  > `revert_reason`. El automático no lo lleva porque su motivo es un hecho —la ausencia se
  > reclasificó, y la revisión que lo cuenta está en `source_id`—; el manual lo exige, que es la
  > misma asimetría de las specs 11, 12 y 13: la razón se le pide a la decisión discrecional.
  >
  > Revertir a mano un descuento **automático** está permitido y la §5 lo da por hecho al pedir
  > que se vea de dónde vino el ajuste. No reclasifica la ausencia: si más tarde alguien vuelve a
  > marcarla injustificada nace un ajuste **nuevo** (RN-13.4), y el índice parcial de RN-17.5 lo
  > permite justamente para eso. El diálogo lo dice antes de revertir, para que la reaparición no
  > sorprenda.
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
  > ✅ **Hecho**, con tres decisiones que la regla dejaba al implementador:
  >
  > - **No tienen origen.** `source_type` y `source_id` quedan nulos, y eso —no la categoría— es
  >   lo que distingue un ajuste manual de uno automático. Por eso el índice de RN-17.5 es
  >   parcial en `source_id is not null`: dos manuales del mismo mes para la misma persona son
  >   legítimos y no deben competir.
  > - **La moneda se hereda del sueldo** salvo que se indique otra, como en el automático. Lo
  >   normal es ajustar en aquella en la que se cobra; indicarla es para la excepción.
  > - **El periodo por defecto es el mes en curso**, en la zona configurada (RN-06.6) y no en la
  >   del servidor.
  >
  > Y una de interfaz que vale dinero: **el signo se elige en dos botones —descuento o
  > bonificación— y el importe se teclea siempre en positivo.** Con un campo firmado, olvidar un
  > carácter convierte un descuento de 250 en una bonificación de 250, y eso es dinero de
  > alguien.
- **RN-17.9 — Auditoría.** ⚠️ **Hueco del legacy (punto 76):** los ajustes **no** llegan a la
  bitácora. Requisito nuevo: toda creación y reversión se registra en
  [18-auditoria](./18-auditoria.md), y también todo cambio de `monthly_salary`.
- **RN-17.10 — Notificación al empleado.** ⚠️ **Hueco del legacy (punto 76):** el empleado no
  se entera. Requisito nuevo: notificarle al aplicarse y al revertirse un ajuste
  ([14](./14-notificaciones.md)).
- **RN-17.11 — Presencia en la reportería.** ⚠️ **Hueco del legacy (punto 76):** los ajustes no
  aparecen en el XLSX ni en Sheets. Requisito nuevo: sección o pestaña de ajustes del periodo
  en el reporte mensual ([16](./16-reporteria-mensual.md)).
  > **Cumplida, pero no ahí — y es un choque de reglas, no una comodidad.** El XLSX del reporte
  > mensual es un artefacto que se genera en cola y queda guardado, y lo descarga *cualquiera con
  > ámbito sobre él* (decisión 3 de la [16](./16-reporteria-mensual.md) §11), o sea también un
  > `department_head`. Un importe de ausencia injustificada es el sueldo dividido por el divisor:
  > enseñárselo le enseña el sueldo, que es exactamente lo que RN-17.1 y el hallazgo H-3
  > prohíben. Una hoja más en ese libro tiraría la barrera de privilegios por la puerta de atrás,
  > y ninguna comprobación de rol al descargar puede arreglarlo, porque el archivo ya existe con
  > los importes dentro.
  >
  > Así que los ajustes del periodo se exportan **desde `/payroll`**, por
  > `GET /payroll/adjustments/export`, detrás del rol administrativo y **sin guardarse en ningún
  > volumen**: un XLSX con los sueldos de la plantilla en disco es una copia esperando a que
  > alguien la encuentre. La forma se comparte con el reporte —`buildPayrollGrid` junto a
  > `buildReportGrid`, un solo serializador (`gridToXlsx`)— y la prueba es la misma: se escribe,
  > se vuelve a leer y se compara celda a celda.
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

> ✅ **Construida**, en dos pestañas: *Ajustes* primero —es la que mueve dinero, el mismo orden
> con el que las ausencias abren `/team`— y *Sueldos* después. Cuatro cosas que la §5 no decía y
> que se decidieron al construirla:
>
> - **Los totales van por moneda.** No hay una cifra por departamento y no puede haberla: en la
>   misma plantilla se cobra en monedas distintas ([02](./02-usuarios-y-perfiles.md) §6a) y sumar
>   CUP con USD produce un número que no significa nada.
> - **Un ajuste revertido sigue en la lista**, atenuado. RN-17.4 lo conserva justamente para que
>   se pueda leer; esconderlo aquí sería conservarlo a medias.
> - **El listado se acota al periodo por defecto.** Una tabla que sólo crece, sin filtro por mes,
>   es la consulta que un día tumba la pantalla — y el mes es además la unidad de trabajo (§7).
> - **La edición de un sueldo es el diálogo de la [02](./02-usuarios-y-perfiles.md)**,
>   reutilizado tal cual. Mismo endpoint, mismo rol y misma entrada de bitácora; un segundo
>   formulario serían dos sitios donde arreglar la misma regla.
>
> Y lo que la vista de conjunto añade y el diálogo por persona no podía dar: **cuánta gente no
> tiene sueldo registrado**, con su aviso. Una ausencia injustificada suya no descuenta (RN-17.7),
> y sin esta lista eso sólo se descubre cuando el descuento no aparece y nadie sabe por qué.

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

> ✅ **Construidos, con dos diferencias respecto de esta tabla.**
>
> El rol no se comprueba endpoint por endpoint sino **una vez para todo el router**: la barrera
> de [13](./13-justificacion-ausencias.md) RN-13.5 no puede depender de que alguien se acuerde de
> repetir la línea al añadir la séptima ruta. Es el mismo criterio con el que `hasScope` vive en
> una sola función tipada. Y con esto la barrera pasa de **404 a 403**: antes un jefe recibía
> "aquí no hay nada", ahora recibe "no tienes permiso", que es lo que la regla pedía. La prueba
> de `routes/absences.test.ts` ya está actualizada.
>
> - **No hay `PUT /payroll/salaries/:userId`.** Editar un sueldo ya existe desde la
>   [02](./02-usuarios-y-perfiles.md): `PUT /users/:id/compensation`, con el mismo rol mínimo y la
>   misma entrada de bitácora (`compensation.updated`). Lo que faltaba era **verlos todos**, y
>   eso es `GET /payroll/salaries`.
> - **Hay uno que la tabla no lista:** `GET /payroll/adjustments/export`, el XLSX del periodo
>   (RN-17.11). Devuelve el archivo y no un enlace firmado, al contrario que el reporte mensual:
>   son decenas de filas, caben en la respuesta, y así no queda una copia de los importes en
>   ningún volumen.
>
> Sobre la decisión abierta, sigue resuelta a medias y **a propósito**: el empleado ve el importe
> de su propio descuento en la notificación de RN-17.10 —es su sueldo y es el dato que necesita
> para reclamar—, pero no tiene pantalla ni endpoint. Añadirlo es una decisión de producto, no
> una omisión técnica.

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

Los nueve se cumplen. Cinco los trajo la [13](./13-justificacion-ausencias.md) con el descuento
automático; los otros cuatro necesitaban la superficie de administración, y uno de ellos —el del
reporte— se cumple **de otra forma que la que pedía**, por una razón que la §11 no anticipaba.

- [x] Un `department_head` recibe 403 en todos los endpoints de nómina. *(Antes **404**: no
      existían. Comprobado contra los seis, y también contra un empleado, en
      `routes/payroll.test.ts`; la de `absences.test.ts` sigue guardando la mitad que le toca a
      esa spec.)*
- [x] Marcar una ausencia injustificada crea un ajuste con el monto exacto esperado.
- [x] Reclasificar la revierte; no queda ningún registro borrado. *(Y revertir a mano tampoco
      borra: la fila queda con autor, fecha, motivo y **el mismo importe**. Revertir dos veces es
      409, no un segundo autor.)*
- [x] Dos escrituras concurrentes de la misma revisión no crean dos ajustes activos (RN-17.5,
      restricción en base).
- [x] Un empleado sin sueldo configurado no rompe el flujo de justificación. *(Y ahora además se
      **ve**: la pestaña de sueldos avisa de cuánta gente está así.)*
- [x] Todo ajuste aparece en la bitácora. *(Los automáticos y los manuales, creación y reversión.
      Y todo cambio de sueldo ya lo hacía desde la [02](./02-usuarios-y-perfiles.md):
      `compensation.updated`.)*
- [x] El empleado recibe notificación de cada ajuste. *(Los manuales tienen ya **su propio tipo**
      —`payroll_adjustment.applied` y `.reverted`—, que es lo que la [14](./14-notificaciones.md)
      dejaba anotado: no nacen de una clasificación, así que `absence.reviewed` no los podía
      contar.)*
- [x] El reporte mensual incluye los ajustes del periodo. ⚠️ **No dentro de ese XLSX**, y no por
      comodidad: ese archivo lo descarga cualquiera con ámbito sobre él, incluido un jefe, y el
      importe de un descuento es el sueldo dividido por el divisor (RN-17.1, H-3). Van en su
      propio archivo, desde `/payroll` y detrás del rol administrativo. Ver RN-17.11.
- [x] Los totales por departamento cuadran con la suma de ajustes activos. *(Comprobado, y
      **moneda a moneda**: un revertido no cuenta y dos monedas no se suman.)*

## 9. Decisiones abiertas

1. ~~Redondeo y decimales del descuento diario.~~ **Cerrada: dos decimales, media al alza, y el
   cálculo en PostgreSQL sobre `numeric`.** Ver RN-17.12.
2. **⚠️ Sigue abierta — ¿cierre de periodo?** (§7) El `effective_period` ya está y los datos
   quedan imputados al mes correcto, así que cerrarla no obliga a migrar nada; lo que falta es la
   noción de "este mes ya no admite cambios", y es lo único que bloquea
   [13](./13-justificacion-ausencias.md) RN-13.9. **Es la única pieza de esta spec sin
   construir.**
3. ¿El empleado ve sus propios ajustes? (§6) — sigue resuelta a medias, y ahora por decisión: ve
   el importe de su descuento en la notificación, y no hay endpoint que le devuelva su historial.
   Añadirlo es una línea de producto, no de arquitectura.
4. ¿El descuento debería ser proporcional a horas no trabajadas en vez de día completo?
5. ¿Otros conceptos automáticos (tardanzas acumuladas, horas extra)? Hoy sólo la ausencia
   injustificada descuenta. El modelo no se opone: un concepto nuevo es otro `source_type`, y el
   índice de RN-17.5 ya lo aísla del que existe.

Y tres que la implementación cerró sin que estuvieran en esta lista:

- **Un total nunca va sin moneda** (§5, RN-17.12). No hay una cifra por departamento: hay una por
  departamento **y moneda**.
- **Los ajustes del periodo no caben en el reporte mensual** sin romper RN-17.1. Salen por su
  propio endpoint (RN-17.11).
- **Un ajuste manual se distingue por no tener origen**, no por su categoría. Las tres categorías
  siguen disponibles a mano; lo que no se puede falsificar es un `source_id`.
