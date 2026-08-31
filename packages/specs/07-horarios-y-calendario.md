# 07 · Horarios por departamento y calendario laboral

> **Origen:** `old-docs.md` §3.2, puntos 17, 18, 19, 20.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado. Tablas `department_schedules` y
> `work_calendar`; aritmética de la ventana compartida entre servidor y formulario en
> `packages/validations/src/schedules.ts`; **la función pura de la §4** en
> `apps/backend/src/services/schedule-rules.ts`, con la conversión de zona por date-fns
> (`@date-fns/tz`); lecturas y escrituras en `apps/backend/src/services/schedules.ts` y
> `apps/backend/src/routes/schedules.ts`; `GET /api/me/schedule` en
> `apps/backend/src/routes/me.ts`. En la interfaz: pestaña *Horarios y calendario* de
> Configuración (`apps/frontend/src/modules/schedules/`) sobre el componente de calendario
> `apps/frontend/src/components/ui/calendar.tsx`, y la tarjeta *Mi horario* en el perfil
> propio. Pruebas: `apps/backend/src/services/schedule-rules.test.ts` (unitarias, la función
> pura) y `apps/backend/src/routes/schedules.test.ts` (integración).
> Las cuatro decisiones de la §8 están cerradas.
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
| `note` | text, nullable | **Añadido en la implementación.** Por qué esa fecha es distinta: "Feriado: 1 de mayo", "Inventario". Sin etiqueta, un día marcado no dice de qué se trataba — ni en la pantalla ni medio año después |
| `created_at` / `updated_at` | timestamptz | |

## 3. Reglas de negocio

- **RN-07.1 — Un horario por departamento.** No hay turnos múltiples ni horarios por
  persona. *Limitación heredada real.* **Decidido: se mantiene** (§8.1); `department_id` es
  único en la tabla. Si el negocio llega a necesitar turnos, es una tabla nueva con vigencias,
  no una columna dejada preparada aquí.
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
  *Comportamiento no documentado en el legacy.* **Decidido: se soporta** (§8.2).
  Implementación: las cuatro horas se anclan en orden sobre el día laboral en **minutos
  absolutos** —pasar de 1440 significa "del día siguiente"—, así que no hay un interruptor de
  "jornada nocturna" que alguien pueda dejar mal puesto. Al validar una marca se prueban dos
  días laborales candidatos, el local y el anterior, y gana el que contenga la hora; para un
  horario diurno el segundo nunca puede ganar. El día resuelto sale en el resultado
  (`workDate`) porque lo necesita la agregación diaria ([15](./15-paneles-y-dashboard.md)).
  Se rechaza al guardar una **entrada** que cruce medianoche y una jornada de más de 24 h: con
  ellas, una misma marca tendría dos días laborales posibles.
- **RN-07.6 — Día no laborable.** Si existe una fila de `work_calendar` para la fecha con
  `is_workday = false`, no se espera asistencia: el día se clasifica `NO_LABORABLE` y el
  marcaje **se rechaza** con `NOT_WORKDAY` (§8.3). Si de verdad se trabajó ese día, la
  corrección pasa por [12-incidencias](./12-incidencias.md), que es el camino auditable; el
  mensaje del rechazo lo dice.
- **RN-07.7 — Fecha sin fila en el calendario.** Se considera laborable por defecto, salvo
  que sea día de descanso de la persona ([10-descansos](./10-descansos.md)).
- **RN-07.8 — Precedencia de tolerancia.** `work_calendar.late_tolerance_minutes` (por fecha)
  → si es null, `app_config.late_tolerance_minutes` (global).
- **RN-07.9 — Departamento en pausa.** Bloquea el marcaje independientemente del horario
  ([01](./01-organizacion-departamentos.md) RN-01.4).
- **RN-07.10 — Cambio de horario notificado.** Al modificar el horario de un departamento se
  notifica automáticamente a todos sus miembros activos
  ([14-notificaciones](./14-notificaciones.md)), **en la transacción del cambio** y con el
  cuerpo del aviso ya resuelto ("Puedes entrar entre las 07:45 y las 08:15"). Dos detalles de
  la implementación: guardar un horario **idéntico** no notifica —abrir el formulario y pulsar
  guardar no debe llegarle a toda la plantilla— y el aviso lleva `dedupe_key` por
  departamento, así que corregir una hora actualiza el mismo aviso en vez de apilar otro.
- **RN-07.11 — No retroactividad.** Cambiar el horario no reclasifica días pasados
  ([06](./06-configuracion-global.md) RN-06.4).
- **RN-07.13 — Hasta dónde ensanchan los interruptores.** *(Añadida en la implementación: la
  spec no fijaba el límite.)* `allow_early_checkin` abre la entrada **desde la medianoche del
  día laboral** y `allow_late_checkout` cierra la salida **al final del día natural en que
  termina la jornada**. El límite es el día y no un margen en minutos porque ese margen habría
  que inventarlo, y un número plausible metido a mano se queda decidiendo rechazos que nadie
  revisa (mismo criterio que los defaults de [06](./06-configuracion-global.md) §3.1). Con el
  día como frontera, la interfaz puede decir la hora exacta hasta la que se acepta.
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

**Implementada** como `validateMarkTime` en `apps/backend/src/services/schedule-rules.ts`, con
36 pruebas unitarias en `schedule-rules.test.ts` — sin base de datos, sin Identity Server y sin
reloj del sistema: el instante entra como argumento, que es lo que permite probar la medianoche,
una zona horaria distinta a la del servidor y el minuto exacto del límite.

Detalles de la firma que conviene conocer antes de construir la [09](./09-marcaje-asistencia.md):

- Los **descansos entran como predicado** `isRestDay(workDate)`, no como array de días de la
  semana: la convención de `days_of_week` sigue siendo decisión abierta de la
  [10](./10-descansos.md) y esta función no tiene por qué elegirla ni cambiar cuando se elija.
- El **calendario entra como mapa por fecha**, sólo con las filas que existan: la ausencia de
  fila significa laborable (RN-07.7), y eso se decide dentro.
- La salida añade a lo que pide la spec: `workDate` (RN-07.5), `localTime`, `toleranceSource`
  y la ventana exigida en hora local, para que el rechazo pueda decir qué se esperaba.
- Los **minutos de tardanza son de retraso real** sobre la hora de apertura, no lo que sobra de
  la tolerancia: con 6 minutos y tolerancia de 5, lo que tiene que ver el reporte es 6. La
  tolerancia sólo decide si cuenta como tardanza.
- Los motivos de rechazo son el enum de la [09](./09-marcaje-asistencia.md) §6 en
  `packages/validations/src/attendance.ts`, con **sólo los seis valores que esta función puede
  devolver hoy**; el resto se añade con su spec.

## 5. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/departments/:id/schedule` | department_head (ámbito) — `null` si no hay horario |
| `PUT` | `/departments/:id/schedule` | global_manager — upsert; `timezone` opcional |
| `DELETE` | `/departments/:id/schedule` | global_manager — **añadido**, ver abajo |
| `GET` | `/departments/:id/calendar?from=&to=` | department_head (ámbito) |
| `PUT` | `/departments/:id/calendar` | global_manager — upsert por lote de fechas |
| `GET` | `/me/schedule?from=&to=` | autenticado — el horario que le aplica hoy |

Tres cosas que la §5 original no decía y que la implementación tuvo que resolver:

- **`DELETE /departments/:id/schedule`** existe porque el borrado de un departamento se bloquea
  si tiene horario ([01](./01-organizacion-departamentos.md) §5.2) y sin esta operación ese
  bloqueo sería un callejón sin salida. También es la forma de dejar de exigir marcaje a un
  departamento que pasa a no tenerlo. Avisa a los miembros, como el cambio.
- **El `PUT` del calendario admite `clearDates`** además de `entries`: "no laborable" y "sin
  fila" no son lo mismo (RN-07.7), y hacía falta poder volver al estado por defecto sin
  inventar un tercer valor de `is_workday`. Todo el lote es una transacción y **una sola**
  entrada de bitácora — marcar los domingos de un año son 52 fechas, y 52 entradas idénticas
  enterrarían el resto del rastro.
- **`/me/schedule` devuelve también las filas del calendario del rango pedido** (por defecto, el
  mes en curso resuelto en la zona del horario). Un `employee` no tiene ámbito sobre
  `/departments/:id/calendar`, así que sin esto no habría forma de que viera sus propios días no
  laborables. Sólo salen las de su departamento.

## 6. UI

- **Tarjeta de horario por departamento** en Configuración: cuatro horas, zona horaria, dos
  interruptores, y un previsualizador de la ventana resultante ("Puedes entrar entre 07:45 y
  08:15").
- **Calendario laboral**: vista de mes por departamento, marcar/desmarcar días, edición
  masiva por rango, tolerancia por fecha.
- Advertencia visible al guardar: "Se notificará a los N miembros del departamento".

Implementado en la pestaña **Horarios y calendario** de `/settings`
(`apps/frontend/src/modules/schedules/`), con un selector de departamento arriba — el horario y
el calendario son de un departamento, y sin ese selector habría que ir y volver de la pantalla
de departamentos por cada cambio. Notas de la implementación:

- La frase del previsualizador la genera **la misma función que aplica el servidor**
  (`describeMarkWindow`), igual que `checkoutModeIssue` en la [06](./06-configuracion-global.md):
  lo que se lee en el formulario es exactamente lo que se va a exigir. Con jornada nocturna
  aparece además el aviso de que la salida cuenta para el día anterior.
- El editor del calendario **acumula los cambios y los guarda de una vez**, con contador de días
  tocados y botón de descartar; los días con cambios sin guardar llevan un punto.
- La selección es por día, por **cabecera de día de la semana** (todos los domingos del mes),
  por **número de semana** y por **rango con filtro de días de la semana**. Marcar 52 domingos a
  mano es lo que hace que nadie mantenga el calendario al día.
- **Mi horario** en `/profile` (`GET /me/schedule`): la ventana que le aplica, el estado de hoy
  con su tolerancia y de dónde sale, y el mes del calendario de su departamento en modo lectura.
  Es el único sitio donde un empleado ve esto.
- Todo se apoya en un **componente de calendario propio**
  (`apps/frontend/src/components/ui/calendar.tsx`) construido sobre date-fns: selección simple,
  múltiple y por rango; celdas con espacio para tono, etiqueta, detalle y puntos; varios meses;
  números de semana; límites y días deshabilitados; navegación por teclado y tabla con
  encabezados nativos. Es el calendario del proyecto: las specs 09, 10 y 11 no deben añadir otro.

## 7. Criterios de aceptación

- [x] Un marcaje 1 minuto después de `checkin_end_time` se rechaza con motivo legible.
- [x] Con `allow_early_checkin`, un marcaje 30 min antes se acepta y no cuenta como tardanza.
- [x] Un marcaje dentro de ventana pero pasada la tolerancia se acepta **y** queda como tarde.
- [x] Un día con `is_workday = false` clasifica como `NO_LABORABLE`: el marcaje se rechaza con
      ese motivo y `/me/schedule` lo devuelve como no laborable. *La clasificación del día en el
      reporte llega con la [15](./15-paneles-y-dashboard.md), que es su dueña; el dato y el
      resolutor ya existen.*
- [x] La tolerancia por fecha gana sobre la global.
- [x] Cambiar el horario genera una notificación por cada miembro del departamento.
- [x] Los cálculos son correctos para un departamento con zona horaria distinta a la del servidor.

## 8. Decisiones (cerradas)

1. ~~¿Turnos múltiples por departamento o por persona?~~ **Uno por departamento** (RN-07.1),
   como el legacy. Turnos serían otro modelo de datos, otra API y otra validación: si el negocio
   los pide, es una spec nueva.
2. ~~¿Se soportan jornadas que cruzan medianoche?~~ **Sí** (RN-07.5): la salida de la madrugada
   pertenece al día laboral anterior. Sin esto un turno de noche es inmarcable.
3. ~~En día no laborable: ¿rechazar o registrar como extraordinario?~~ **Rechazar** con
   `NOT_WORKDAY` (RN-07.6); lo trabajado de más se corrige por incidencias
   ([12](./12-incidencias.md)). Marcarlo como extraordinario obligaría a decidir ya cómo se paga,
   que es asunto de la [17](./17-nomina.md).
4. ~~¿Feriados nacionales precargados o carga manual?~~ **Carga manual**, con edición masiva por
   rango y filtro por día de la semana. Nada se escribe en el calendario sin que alguien lo pida.

Queda por decidir, y no bloquea nada de esta spec:

- Hasta dónde deben ensanchar los interruptores de entrada anticipada y salida tardía. Hoy es el
  día natural (RN-07.13); si en planta hace falta un margen en minutos, es una clave de
  configuración y un cambio en `markWindow`.
