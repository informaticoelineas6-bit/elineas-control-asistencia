# 11 · Vacaciones

> **Origen:** `old-docs.md` §3.4, puntos 37, 38, 39, 40.
> **Estado en el sistema legacy:** ✅ implementado y completo
> (el documento `plan-implementacion-vacaciones.md` que lo daba por pendiente estaba desactualizado).
> **Estado en el monorepo nuevo:** ✅ implementado. Con esto se cierra **la última costura que
> la [09](./09-marcaje-asistencia.md) dejó abierta**: la bandera `onVacation` recibe datos
> reales, un intento de marcar en un día aprobado se rechaza con `ON_VACATION` y
> `GET /attendance/status` lo dice antes de ofrecer el botón. En la agregación diaria,
> `VACACIONES` entró como **superposición** con precedencia 2
> ([15](./15-paneles-y-dashboard.md) RN-15.1), no como un estado más de la lista.
> **Depende de:** [09-marcaje-asistencia](./09-marcaje-asistencia.md) (los días trabajados salen de ahí), [06-configuracion-global](./06-configuracion-global.md).

Dónde está cada cosa:

| Pieza | Archivo |
|---|---|
| Saldo, solapamiento, días que consume un rango | `packages/validations/src/vacations.ts` |
| Servicio: solicitar, cancelar, revisar, saldo, costuras | `apps/backend/src/services/vacations.ts` |
| Rutas | `apps/backend/src/routes/vacations.ts`, más `/me` y `/users/:id` |
| Interfaz | `apps/frontend/src/modules/vacations/`, montada en `/profile` y `/team` |
| Pruebas | `services/vacation-rules.test.ts` (18, puras) · `routes/vacations.test.ts` (26, con base) |

**Tres de las cinco decisiones abiertas se cierran** (§9); la 1 —cumplimiento de la normativa
laboral cubana— y la 3 —quién aprueba las vacaciones de un jefe— **siguen abiertas**, la primera
porque es de negocio y la segunda porque el sistema no puede resolverla con los datos que tiene
(ver §10).

---

## 1. Objetivo

Permitir que una persona solicite días libres pagados, con un **saldo acumulado en función de
los días efectivamente trabajados**, y que su jefe apruebe o rechace. Un periodo aprobado
bloquea el marcaje y aparece como `VACACIONES` en la reportería.

## 2. Modelo de acumulación

Modelo **simple y deliberado** del legacy:

```
earned    = días_trabajados × vacation_days_per_worked_day
available = earned − aprobados − pendientes
```

- **RN-11.1 — No existe saldo negativo.** La solicitud se **bloquea en origen** si el saldo
  disponible no alcanza. No se aprueba "a deber".
- **RN-11.2 — Tasa configurable.** `vacation_days_per_worked_day` en
  [06-configuracion-global](./06-configuracion-global.md). Es global, no por persona ni por
  departamento. **Decisión abierta:** ¿alcanza, o hay antigüedad/categorías?
- **RN-11.3 — Los pendientes reservan saldo.** Una solicitud en revisión ya descuenta de
  `available`, para que no se pueda pedir dos veces lo mismo.
- **RN-11.4 — Qué cuenta como "día trabajado".** Definición operativa: día con marcaje de
  entrada **aceptado**, contado una vez por `work_date` aunque haya varias marcas. Los días de
  tardanza **sí** cuentan (un `TARDE` tiene entrada válida, así que entra sin caso especial) y
  los de vacaciones **no** (no hay marca). Lo de los **justificados sigue abierto por
  dependencia**, no por decisión: la spec 13 no existe todavía, así que hoy no hay ninguna
  ausencia justificada que contar. Cuando llegue, `countEarnedDays` crece; no se duplica en
  otro sitio.

> ⚠️ Este modelo **no refleja ninguna legislación laboral concreta**: es una simplificación de
> negocio heredada del legacy. La empresa opera en **Cuba**
> ([06](./06-configuracion-global.md) §8), así que la normativa a contrastar es el Código de
> Trabajo cubano y no la peruana que citaba antes esta nota. Si el requisito real es
> cumplimiento legal, esta spec cambia por completo.
> **Decisión abierta de negocio, no técnica.**

## 3. Modelo de datos

### `vacation_requests`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `start_date` / `end_date` | date | Inclusivos |
| `requested_days` | int | Calculado al crear, congelado |
| `status` | enum | `pending` · `approved` · `rejected` · `cancelled` |
| `review_comment` | text, nullable | Comentario del revisor |
| `reviewed_by` | uuid, nullable | Sin FK, como `deactivated_by` (RN-02.8): el rastro de quién decidió sobrevive al borrado del perfil |
| `reviewed_at` | timestamptz, nullable | |
| `cancelled_by` / `cancelled_at` | uuid / timestamptz, nullable | **Añadidos:** cancelar no es revisar (RN-11.10), y una solicitud que su dueño retiró no debe parecer revisada por nadie |
| `created_at` / `updated_at` | timestamptz | |

`status` no es un enum de PostgreSQL sino `text` con el vocabulario cerrado en Zod, igual que
`mark_type` en la spec 09: añadir un estado no debe ser una migración de tipo.

**No hay columna de saldo.** Se resuelve leyendo el historial de marcas y las solicitudes
vigentes (`services/vacations.ts`); guardarlo crearía dos verdades sobre cuánto le queda a
alguien, y la que se desincronizara sería la que la gente ve.

## 4. Reglas de negocio

- **RN-11.5 — Cálculo de `requested_days`.** **Sólo los días laborables que además no son
  descanso** (decisión 2, cerrada): la persona no iba a trabajar esos días de todas formas, y
  cobrárselos del saldo sería penalizarla por algo que no le costó nada. Se calcula con
  `countWorkableDays`, que comparten servidor e interfaz, y queda **congelado** en la fila: un
  cambio posterior del calendario o de sus descansos no reescribe lo que costó una solicitud ya
  aprobada — el mismo principio que `is_late` en la spec 09.
  Un rango que no incluye ningún día laborable se **rechaza** en vez de crear una solicitud de
  cero días, que no tendría ningún efecto salvo ocupar la lista.
- **RN-11.6 — Sin solapamiento.** No puede haber dos solicitudes `pending` o `approved` que
  se solapen en fechas para la misma persona.
- **RN-11.7 — Sólo a futuro.** `start_date` no puede ser anterior a **hoy en la zona del
  departamento** (RN-07.2), y **sin excepción de rol**: a diferencia de los descansos
  (RN-10.7, que sí exime al rol administrativo), aquí una regularización hacia atrás es una
  incidencia (spec 12), no unas vacaciones con la fecha movida. El único rol "administrativo"
  del sistema, `global_manager`, tampoco llega a esta comprobación: no marca (RN-03.4), así que
  no acumula ni solicita.
- **RN-11.8 — Aprobación.** Aprueba el `department_head` con ámbito sobre el departamento de
  quien pidió, o un `global_manager` — resuelto con `canManage`, leyendo el departamento **de la
  solicitud**, no uno que mande el cliente. **Nadie aprueba su propia solicitud**, y eso sí está
  implementado y probado.
  **Sigue abierta la otra mitad** —¿quién aprueba las de un jefe de departamento?— y no por
  falta de criterio: ver §10.
- **RN-11.9 — Bloqueo del marcaje.** Con una solicitud `approved` que cubre la fecha, el
  marcaje se rechaza con `ON_VACATION` ([09](./09-marcaje-asistencia.md) RN-09.2).
- **RN-11.10 — Cancelación.** Implementada tal como la describe la regla: el solicitante
  cancela mientras esté `pending`; una `approved` que **todavía no ha empezado** también, y
  devuelve saldo; una **en curso o pasada**, sólo rol administrativo. Una ya rechazada o
  cancelada responde 409 en vez de volver a "cancelarse".
  Devolver saldo no necesita nada especial: `available` resta sólo lo `pending` y lo `approved`,
  así que cancelar lo libera por definición. Y cuando cancela alguien que no es su dueño, se le
  notifica — enterarse de que el descanso con el que contaba ya no existe no puede depender de
  que abra la pantalla.
  *(La spec pedía "confirmar contra el legacy"; no había código legacy a mano que consultar, así
  que se implementó la regla tal como está redactada, que es coherente por sí sola.)*
- **RN-11.11 — Las vacaciones no generan descuento de nómina.** Decisión de negocio
  **explícita**: son días pagados. Sólo se registra un ajuste si un administrador lo crea a
  mano ([17-nomina](./17-nomina.md) RN-17.6).
- **RN-11.12 — Estado en reportería.** El día clasifica como `VACACIONES`, superpuesto al
  estado que le hubiera correspondido ([15](./15-paneles-y-dashboard.md)).
- **RN-11.13 — Todas las mutaciones pasan por una operación de dominio transaccional.**
  Cumplido: `requestVacation`, `cancelVacationRequest` y `reviewVacationRequest` en
  `services/vacations.ts`, cada una con su transacción y su entrada de bitácora dentro
  (RN-18.4). No hay CRUD genérico sobre `vacation_requests`.
  **Sólo solicitar necesita bloquear**, y esto merece leerse antes de "optimizarlo": pedir es la
  única operación que puede dejar el saldo en negativo bajo concurrencia (RN-11.1), porque
  aprobar no cambia lo que se resta —`available` resta igual lo pendiente que lo aprobado— y
  cancelar sólo libera. El bloqueo es un `SELECT … FOR UPDATE` sobre la fila de `profiles` de esa
  persona: serializa sus solicitudes simultáneas sin exponerse a un error de serialización que
  haya que reintentar, que es lo que traería una transacción `serializable`.

## 5. Flujos

### 5.1 Solicitar
1. El empleado ve su saldo (`earned`, `used`, `pending`, `available`).
2. Elige rango → el sistema calcula `requested_days` (RN-11.5).
3. Valida saldo (RN-11.1) y solapamiento (RN-11.6) **en servidor, en transacción**.
4. Queda `pending`. Notificación al jefe ([14](./14-notificaciones.md)) — **con una
   limitación conocida**, ver §10: este sistema sólo puede identificar como jefes de un
   departamento a quienes lo gestionan como responsabilidad **adicional** (spec 03 §3), no al
   jefe cuyo ámbito es su propio departamento. Ése se entera por su bandeja de revisión, que es
   el camino fiable en cualquier caso.

### 5.2 Revisar
1. El jefe ve las pendientes de **todo su ámbito** en una sola lista (`?scope=managed`), sin
   tener que elegir departamento primero: revisar es por persona, no por departamento — a
   diferencia de los grupos de descanso, donde la configuración sí es departamental.
2. Aprueba o rechaza, con comentario opcional (obligatorio si rechaza).
3. Notificación al solicitante.

> La **cobertura del equipo** de esta sección —quién más está de vacaciones en esas fechas—
> era una **Propuesta**, y se deja para más adelante: no bloquea decidir (las fechas de cada
> solicitud están a la vista) y el jefe ya tiene el calendario de descansos del equipo en
> `/rest-days`. Anotada en §10.

### 5.3 Cancelar
Según RN-11.10; devuelve saldo y notifica.

## 6. API

Contrato en `packages/contracts/src/vacations.ts`.

| Método | Path | Rol |
|---|---|---|
| `GET` | `/api/me/vacations/balance` | autenticado — saldo propio |
| `GET` | `/api/users/:id/vacations/balance` | department_head (ámbito) |
| `GET` | `/api/vacations/requests?status=&scope=&departmentId=` | `scope=own` (default) cualquiera · `scope=managed` department_head+ |
| `POST` | `/api/vacations/requests` | autenticado que marque (RN-03.4) — siempre para uno mismo |
| `POST` | `/api/vacations/requests/:id/cancel` | solicitante o administrativo (RN-11.10) |
| `POST` | `/api/vacations/requests/:id/review` | department_head con ámbito — `{ approved, comment }` |

Dos desviaciones de la tabla original, las dos por forma:

1. **El saldo cuelga de `/me` y de `/users/:id`**, no de `/vacations/balance/:userId`: es un dato
   *de una persona*, y así queda junto al horario (spec 07) y los descansos (spec 10), que ya
   siguen ese reparto. Un `/vacations/balance/:userId` habría sido un tercer sitio donde buscar
   "lo de alguien".
2. **`scope` se define como `own | managed`**, que la tabla dejaba a criterio. Sin `scope=managed`
   el endpoint devuelve siempre **las propias**, incluso a un gestor: es el mismo criterio que
   `/attendance/me`, donde no hay forma de pedir las de otra persona por descuido.

**No hay endpoint para pedir vacaciones en nombre de otro.** La §5.1 está escrita en primera
persona, y añadirlo sería una vía para saltarse el flujo de aprobación que nadie ha pedido.

## 7. UI

- **Empleado — "Mis vacaciones", en `/profile`**, junto al horario y los descansos: la spec 05
  §3 ya ponía las vacaciones ahí. Saldo (ganado / usado / pendiente / disponible), selector de
  rango y lista de sus solicitudes con su estado y el comentario del revisor si lo hubo.
- **El consumo se calcula en vivo antes de enviar** (RN-11.5) con la **misma función** que
  valida el servidor, `countWorkableDays`. Con un atajo documentado: los descansos se aproximan
  con el patrón semanal vigente **hoy** aplicado a todo el rango, en vez de resolver día a día
  como hace el servidor (RN-10.1) — sería exacto pidiendo el descanso de cada fecha por
  separado, y sólo difiere si la persona ya tiene programado un cambio de descansos dentro del
  rango que está eligiendo. El número que manda es el que devuelve el servidor al crear.
- **Jefe — `/team`**, que deja de ser un marcador. Bandeja de pendientes de todo su ámbito, con
  aprobar/rechazar y el comentario en el mismo diálogo. Es la primera pieza de esa pantalla:
  crece con las incidencias (spec 12) y las ausencias (spec 13), igual que `/settings` fue
  creciendo pestaña a pestaña. Todavía **sin pestañas**, porque una pestaña sola no es una
  pestaña, es la página.
- **Sin badge de pendientes en la navegación** todavía: hace falta un contador propio y RN-05.5
  lo pide junto al de incidencias, así que entra con la spec 12 y no antes. Anotado en §10.

## 8. Criterios de aceptación

- [x] Solicitar más días de los disponibles falla antes de crearse la solicitud.
- [x] Dos solicitudes solapadas: la segunda falla.
- [x] Una solicitud pendiente reduce el disponible; al rechazarla, lo devuelve.
- [x] Con vacaciones aprobadas vigentes, el marcaje devuelve `ON_VACATION`.
- [x] Un día de vacaciones aparece como `VACACIONES` en el reporte mensual.
      *(Probado sobre la agregación diaria — `GET /attendance/me` —, que es de donde la spec 16
      sacará el reporte cuando exista: una sola definición del estado del día, spec 15 §4.)*
- [x] Aprobar unas vacaciones **no** crea ningún ajuste de nómina.
      *(Por construcción: ninguna función de este servicio toca `employee_compensation` ni
      escribe ajustes, y la spec 17 aún no tiene tabla que tocar.)*
- [x] Dos solicitudes concurrentes del mismo usuario que juntas exceden el saldo: sólo una
      pasa (test de concurrencia sobre la transacción de RN-11.13).

Dos matices que las casillas no recogen y conviene saber:

- **`GET /attendance/status` aplica el bloqueo, no sólo el `POST`.** Sin eso, la pantalla de
  marcaje ofrecería el botón en un día aprobado y el servidor lo rechazaría al pulsarlo. Y como
  RN-09.2 se evalúa **antes** de resolver la jornada (spec 09 §3), la vacación se comprueba
  contra **hoy**, no contra el día laboral que resolvería la marca — lo que en una jornada
  nocturna es la simplificación que ese orden implica.
- **Un marcaje que ya existe gana sobre `VACACIONES` en la presentación** (RN-15.2). Sólo puede
  pasar por importación histórica, porque en vivo el marcaje se rechaza antes; esconder trabajo
  que existió sería peor.

## 9. Decisiones

**Cerradas al implementar:**

2. **Los días no laborables y de descanso dentro del rango NO consumen saldo** (RN-11.5). La
   persona no iba a trabajar esos días de todas formas; contarlos le cobraría del saldo algo que
   no le costó nada. Cierra además la pregunta que dejaba abierta RN-15.1: un día de vacaciones
   que además era descanso no consume, aunque **sí** se presente como `VACACIONES` (la
   precedencia de presentación y el consumo son dos cosas distintas, y ésta es la única
   combinación donde se nota).
4. **No se piden medios días.** `requested_days` es un entero desde el diseño de la tabla (§3);
   admitir medios días es un cambio de tipo, y ninguna otra parte del sistema —ni el horario, ni
   los descansos, ni la nómina— trabaja con fracciones de jornada.
5. **Los días acumulados no caducan.** El saldo es una cuenta corriente, como dice la fórmula
   del §2. Una caducidad necesitaría su clave de configuración y una fecha de corte que nadie ha
   pedido; si la decisión 1 se cierra alguna vez a favor de cumplir la normativa cubana, entrará
   como parte de ese cambio y no antes.

**Siguen abiertas, y por qué:**

1. **¿El modelo de acumulación debe cumplir la normativa laboral cubana?** (§2) — la más
   importante, y **de negocio, no técnica**: nadie de este lado puede decidirla. Lo implementado
   es el modelo simple del legacy, tal como lo describe la spec. Si la respuesta es "sí", esta
   spec cambia por completo, y con ella las decisiones 5 y probablemente la 4.
2. **¿La tasa global alcanza, o hay antigüedad y categorías?** (RN-11.2) — igual de comercial
   que la anterior. Hoy es una sola clave global.
3. **¿Quién aprueba las vacaciones de un jefe de departamento?** (RN-11.8) — abierta por una
   razón concreta, no por falta de criterio: **este sistema no puede saber el rol de un perfil
   ajeno mirando su propia base.** Los roles los otorga el Identity Server y sólo se conocen
   cuando esa persona se autentica (RN-00.43); lo único que queda localmente es
   `user_department_responsibilities`, y ésa sólo registra el ámbito **adicional** de un jefe, no
   el departamento propio (spec 03 §3) — que es el caso más común. Cualquier regla del tipo "a un
   jefe sólo lo aprueba un gestor global" sería, hoy, una detección de rol que falla en silencio
   justo en el caso normal. Lo que **sí** está implementado es la mitad verificable: nadie
   aprueba su propia solicitud. Resolver la otra mitad pide una de dos cosas, y las dos son
   decisiones de arquitectura que exceden esta spec: consultar al IS los roles de un usuario
   cualquiera (hoy `lib/identity.ts` sólo sabe hacerlo por *session token*), o registrar
   localmente qué perfil es jefe de qué departamento.

## 10. Lo que queda pendiente

Ninguna de estas cosas bloquea el flujo completo —solicitar, revisar, cancelar y que el marcaje
lo respete—, y todas están anotadas donde toca en el código:

- **La notificación al jefe no llega al jefe "propio" de un departamento**, sólo a quien lo
  gestiona como responsabilidad adicional. Es la consecuencia directa de la decisión 3 que sigue
  abierta: sin saber quién tiene rol de jefe, no hay a quién notificar. Su bandeja de revisión
  (`/team`) sí muestra todo su ámbito, así que ninguna solicitud se queda sin ver — sólo sin
  empujar.
- **Sin "cobertura del equipo" al revisar** (§5.2, marcada como *Propuesta*): quién más está de
  vacaciones en esas mismas fechas. Con el calendario de descansos del equipo ya en `/rest-days`
  y las fechas de cada solicitud a la vista, se puede decidir sin ella.
- **Sin badge de pendientes en la navegación** (§7): RN-05.5 lo pide junto al de incidencias, así
  que su sitio natural es la spec 12.
- **Los días justificados no cuentan como trabajados** porque todavía no existen (RN-11.4): es
  una costura para la spec 13, no una decisión tomada.
