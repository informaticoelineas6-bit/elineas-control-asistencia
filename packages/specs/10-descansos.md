# 10 · Descansos

> **Origen:** `old-docs.md` §3.2, puntos 33, 34, 35, 36, 49.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado. Las tres tablas
> (`user_rest_schedule`, `rest_groups`, `rest_group_members`) y la resolución compartida están
> en su sitio, y **las dos costuras que la [09](./09-marcaje-asistencia.md) dejó preparadas
> están conectadas**: `validateMarkTime` recibe el predicado `isRestDay(workDate)` real y la
> agregación diaria clasifica `DESCANSO`. Como la spec anticipaba, esa parte fue *conectar dos
> argumentos*; el trabajo estuvo en la vigencia por fecha (RN-10.1) y en las validaciones de
> servidor. **Las cuatro decisiones abiertas de la §9 están cerradas**, y el modelo dejó una
> consecuencia conocida que conviene leer antes de tocar los grupos: la decisión 5 de esa
> misma sección.
> **Depende de:** [01-organizacion-departamentos](./01-organizacion-departamentos.md), [06-configuracion-global](./06-configuracion-global.md).
> **Habilita:** [09-marcaje-asistencia](./09-marcaje-asistencia.md) (no se marca en descanso), [15](./15-paneles-y-dashboard.md) y [16](./16-reporteria-mensual.md) (estado `DESCANSO`).

Dónde está cada cosa:

| Pieza | Archivo |
|---|---|
| Convención de días, separación mínima, número por semana | `packages/validations/src/rest.ts` |
| Resolución pura (RN-10.1, RN-10.2, RN-10.3) | `apps/backend/src/services/rest-rules.ts` |
| Carga, escritura, grupos, recordatorio | `apps/backend/src/services/rest-schedules.ts` |
| Rutas | `apps/backend/src/routes/rest.ts`, más `/me` y `/users/:id` |
| Interfaz | `apps/frontend/src/modules/rest/`, montada en `/profile` y `/rest-days` |
| Pruebas | `services/rest-rules.test.ts` (24, puras) · `routes/rest.test.ts` (43, con base) |

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
| `user_id` | uuid FK | `on delete cascade` |
| `days_of_week` | int[] | 0 = domingo … 6 = sábado (decisión 1, cerrada) |
| `effective_from` | date | Desde cuándo rige esta configuración |
| `created_at` / `updated_at` | timestamptz | |

Único por `(user_id, effective_from)`: dos filas con la misma fecha dejarían RN-10.1 sin
respuesta única, y cuál gana dependería del plan de consulta.

### `rest_groups`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `department_id` | uuid FK | `on delete cascade` |
| `name` | text | "Grupo A". Único por departamento, sin distinguir mayúsculas (RN-01.1) |
| `days_of_week` | int[] | |
| `is_active` | boolean, default `true` | **Añadido:** un grupo con historial no se borra, se retira — mismo criterio que las sedes (RN-08.10) |
| `created_at` / `updated_at` | timestamptz | |

### `rest_group_members`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `group_id` | uuid FK, **admite nulo** | Nulo = salió de todo grupo en esa fecha. `on delete restrict` |
| `user_id` | uuid FK | `on delete cascade` |
| `effective_from` | date | Desde cuándo pertenece al grupo |
| `created_at` | timestamptz | |

Único por `(user_id, effective_from)` **en toda la tabla**, no por grupo: nadie pertenece a dos
grupos el mismo día.

> **Por qué `group_id` admite nulo.** Es la decisión de diseño de esta tabla. Sacar a alguien de
> un grupo, sin una fila que lo diga, obligaría a **borrar** sus filas —reescribiendo el pasado,
> justo lo que RN-10.1 impide— o a dejarla dentro para siempre. Con el nulo, la tabla es un
> historial de asignaciones donde "sin grupo" es un hecho fechado como cualquier otro, y la
> resolución es la misma para todos los casos: la fila más reciente con `effective_from ≤ D`.

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
  de días entre dos descansos de la misma persona. `rest_days_min_separation_departments`
  **acota** a qué departamentos aplica, y la **lista vacía significa "todos"** (decisión 2,
  cerrada). La distancia entre dos días se mide en el **ciclo semanal**, que es circular:
  sábado y domingo están a un día, no a seis — medirla en línea recta dejaría pasar justo el
  caso que la regla quiere evitar. Se valida en servidor y en la interfaz **con la misma
  función**, `restDaysIssue`.
- **RN-10.6 — No marcar como descanso un día ya trabajado.** Si existe un marcaje en esa
  fecha, la configuración es inválida. La validación es de UI y de servidor.
- **RN-10.7 — Cambio hacia el pasado prohibido.** `effective_from` no puede ser anterior a
  hoy salvo para rol administrativo (y queda en bitácora).
- **RN-10.8 — Un grupo con miembros no se elimina;** primero se reasignan.
- **RN-10.9 — Número de descansos.** Hay mínimo y máximo por semana, y son **configuración**:
  `rest_days_min_per_week` y `rest_days_max_per_week` ([06](./06-configuracion-global.md) §3.3),
  con los defaults que dejan la regla inerte —0 y 7 no excluyen ningún conjunto— porque la cifra
  es laboral y la pone el negocio (decisión 3, cerrada). Un mínimo por encima del máximo se
  rechaza al guardar la configuración (RN-06.5): no invalidaría una elección concreta, sino
  **todas**.
- **RN-10.11 — Un grupo con historial no se elimina, se retira.** *(Añadida al implementar.)*
  El `DELETE` de un grupo sólo funciona si **ninguna** fila de asignación lo referencia — el
  grupo que se creó por error. En cuanto tuvo a alguien, forma parte de su historial de
  descansos y borrarlo cambiaría reportes ya cerrados; la salida es reasignar a su gente y
  poner `is_active = false`. Y un grupo con miembros vigentes tampoco se retira: primero se
  reasignan, igual que pide RN-10.8.

## 4. Quién configura qué

| Acción | employee | department_head | global_manager |
|---|:--:|:--:|:--:|
| Ver sus descansos | ✅ | ✅ | ✅ |
| Elegir sus descansos (modo individual) | ✅ | ✅ | — |
| Ver/editar descansos de su ámbito | ❌ | ✅ | ✅ |
| Crear/editar grupos de descanso | ❌ | ❌ | ✅ |
| Asignar personas a grupos | ❌ | ✅ (su ámbito) | ✅ |

> **Cerrado (decisión 4): el empleado elige.** Es lo que hacía el legacy, con RN-10.5 y RN-10.6
> como único freno, y las dos se validan en servidor. Un flujo de aprobación es otra
> funcionalidad —estados, notificaciones, pantalla de pendientes— que nadie ha pedido.

Dos matices que salieron al implementarlo:

- **En modo por grupos, `PUT /me/rest-schedule` responde 409** en vez de guardar algo que no se
  aplicaría (RN-10.2). Lo que había guardado **no se borra**: apagar el interruptor lo devuelve
  intacto (RN-01.6).
- **Un `global_manager` no configura sus propios descansos** porque no marca (RN-03.4), de ahí
  el `—` de la segunda fila. Sí configura los de otros.

## 5. Recordatorio automático

- **RN-10.10** — Si un empleado o jefe no tiene descansos configurados para la semana en
  curso, el sistema crea/actualiza una notificación recordándoselo
  ([14-notificaciones](./14-notificaciones.md)).
- El recordatorio se **actualiza**, no se duplica: una sola notificación viva por persona.

> ⚠️ **Hallazgo H-4 del legacy:** esta regla vivía dentro del contexto de notificaciones del
> frontend, no en la capa de dominio. En el sistema nuevo debe ser **lógica de servidor**
> (proceso programado o evaluación al iniciar sesión), no un efecto del cliente.

**Implementado como evaluación al iniciar sesión** —la segunda de las dos formas que admite la
spec, porque el proyecto no tiene todavía procesos programados—, en
`remindMissingRestSchedule`. Cuatro detalles que no estaban en la §5:

- El aviso **dice quién puede arreglarlo**, y eso cambia con el modelo del departamento: en modo
  individual lo arregla la persona y el aviso lleva a `/profile`; con grupos activados sólo su
  jefe puede asignarla, y mandarla a una pantalla donde no puede hacer nada incumpliría RN-05.10.
- **Se retira al configurar los descansos.** Un recordatorio de algo ya hecho es ruido; en cuanto
  la persona tiene días vigentes, la notificación se borra.
- **No se recuerda a `global_manager`** (no marca, RN-03.4) ni a quien no tiene departamento (su
  aviso pendiente es otro, RN-02.12).
- **No lanza nunca.** Un aviso no puede impedir un inicio de sesión: si falla, se registra en
  consola y el login sigue.

El jefe además lo ve en pantalla, sin depender de la campana de cada uno: `/rest-days` lista a
quien no tiene descansos vigentes. Con los grupos activados es el único que puede resolverlo.

## 6. API

Contrato en `packages/contracts/src/rest.ts`.

| Método | Path | Rol |
|---|---|---|
| `GET` | `/api/me/rest-schedule?date=` | autenticado — resuelto para la fecha pedida |
| `PUT` | `/api/me/rest-schedule` | autenticado (modo individual; 409 si mandan los grupos) |
| `GET` | `/api/users/:id/rest-schedule?date=` | department_head (ámbito) |
| `PUT` | `/api/users/:id/rest-schedule` | department_head (ámbito) |
| `GET` | `/api/departments/:id/rest-groups` | department_head (ámbito) |
| `POST` | `/api/departments/:id/rest-groups` | global_manager |
| `PATCH` / `DELETE` | `/api/rest-groups/:id` | global_manager |
| `PUT` | `/api/rest-groups/:id/members` | department_head (ámbito del grupo) |
| `GET` | `/api/departments/:id/rest-days?from=&to=` | department_head (ámbito) |

Dos desviaciones de la tabla original, las dos por forma:

1. **La creación cuelga del departamento**, no de `POST /rest-groups/:id`: un grupo pertenece a
   un departamento y no tiene id antes de existir. El `:id` de la tabla original era el del
   departamento, y ponerlo donde ya está en el `GET` evita dos formas de decir lo mismo.
2. **Se añade `GET /departments/:id/rest-days`** para el calendario de equipo que pide la §7:
   resolverlo en el cliente obligaría a pedir los descansos persona a persona y a repetir allí
   la precedencia de RN-10.2.

El ámbito de `PUT /rest-groups/:id/members` se comprueba contra el **departamento del grupo**,
leído de la base, no contra lo que diga el cliente.

Función de dominio compartida: `resolveRestDays(userId, date)`, usada por el marcaje, la
agregación diaria y la reportería. **Una sola implementación**, en `rest-rules.ts`, y **pura**:
sin base ni reloj. Quien necesita varias fechas pide el predicado —`restDayResolverFor`— para no
repetir las consultas por día; el predicado resuelve **fecha a fecha**, porque un rango de un mes
puede atravesar un cambio de configuración y un único conjunto de días daría el mismo resultado
al día 1 y al 30.

## 7. UI

- **Empleado — "Mis descansos", en `/profile`** ([05](./05-shells-y-navegacion.md) §3, junto a
  *Mi horario*). Selector de días con la separación mínima validada en vivo *con la misma
  función que aplica el servidor* y con los límites que llegan en la respuesta: lo que se lee
  es exactamente lo que se va a rechazar, no una frase escrita a mano que se queda vieja cuando
  alguien cambia la configuración global. En modo por grupos el selector se pinta **igual, en
  lectura**: saber qué días descansas es útil aunque no puedas cambiarlos.
- **Jefe y gestor — `/rest-days`**, con el calendario de quién descansa cada día y los grupos
  del departamento. Es **una ruta propia y no una pestaña de Configuración** por la matriz de
  la §4: asignar personas a un grupo es del `department_head`, y Configuración empieza en
  `global_manager` — meterlo allí habría dejado al jefe sin la única operación que le
  corresponde. Dentro, crear y editar grupos sólo se ofrece a un gestor.
- El **campo "desde cuándo"** está a la vista en los dos formularios, no escondido en un menú:
  es lo que decide si el cambio toca el pasado (RN-10.1), y sin él alguien esperaría que el
  reporte del mes entero se recalculara.
- El selector de días vive en `modules/rest/weekday-picker.tsx` y **lo comparte el filtro por
  día de la semana del calendario laboral** (spec 07), que tenía la lista escrita a mano: se
  pinta empezando en lunes y se guarda con 0 = domingo, en un solo sitio, así que no hay
  traducción que nadie pueda olvidar.

## 8. Criterios de aceptación

- [x] Cambiar los descansos con `effective_from` futuro no altera el reporte del mes pasado.
- [x] Un día de descanso clasifica `DESCANSO`, nunca `AUSENTE`.
- [x] Intentar marcar en día de descanso devuelve `REST_DAY`.
- [x] Con grupos activados, la configuración individual del usuario se ignora.
- [x] No se puede marcar como descanso un día con marcaje existente.
- [x] La separación mínima se valida en servidor, no sólo en la UI.
- [x] Un usuario sin descansos configurados recibe una única notificación recordatoria viva.

Los siete están cubiertos por pruebas. Dos que conviene destacar porque su matiz no está en la
casilla:

- **Un intento de marcaje rechazado no cuenta como día trabajado** para RN-10.6. No es trabajo,
  es un rechazo registrado (RN-09.8); si contara, un solo intento fuera de la geocerca impediría
  para siempre poner ese día como descanso.
- **`GET /attendance/status` aplica los descansos**, no sólo el `POST`. Sin eso la pantalla de
  marcaje ofrecería el botón en un día de descanso y el servidor lo rechazaría a continuación.

## 9. Decisiones cerradas

1. **`days_of_week` es 0 = domingo … 6 = sábado.** Es la convención de `Date.getDay()` en
   JavaScript y la de `extract(dow from …)` en PostgreSQL, que son los dos motores por los que
   pasa el dato. Cualquier otra obliga a convertir en cada frontera, y la conversión que alguien
   olvide corre los descansos un día — un fallo que no rompe nada visible y que sale en un
   reporte meses después. Que la semana se **pinte** empezando en lunes es cosa de la interfaz.
2. **La lista vacía de `rest_days_min_separation_departments` significa "todos".** El
   interruptor de la regla es el número —0 la desactiva— y la lista sólo la acota. Con el
   criterio contrario habría **dos** formas de decir "a nadie" y **ninguna** de decir "a todos"
   sin enumerar los departamentos y acordarse de añadir cada uno nuevo; y poner el número
   olvidando la lista dejaría una regla configurada que no hace nada, que es el fallo que nadie
   nota.
3. **Sí hay mínimo y máximo semanal, y son configuración**: `rest_days_min_per_week` y
   `rest_days_max_per_week`, con defaults 0 y 7 que dejan la regla inerte. La cifra es laboral y
   la pone el negocio; lo que tenía que existir ya es el sitio donde ponerla, o el día que se
   decida será un despliegue en vez de un cambio de configuración.
4. **El empleado elige, no propone.** Ver §4.
5. **Cambiar los días de un grupo alcanza al pasado, y es deliberado no arreglarlo aquí.**
   `rest_groups` no lleva `effective_from` —la §2 no se lo da, y RN-10.1 habla sólo de
   `user_rest_schedule` y `rest_group_members`—, así que los días nuevos pasan a valer también
   para las fechas ya reportadas de sus miembros. Es lo correcto para **corregir** un grupo mal
   creado y lo equivocado para **rotar** turnos: para eso se crea otro grupo y se reasigna, que
   es la operación que el historial de asignaciones sí fecha bien. La interfaz lo advierte antes
   de guardar cuando el grupo tiene gente dentro. Darle vigencia propia al grupo sería un modelo
   distinto del que pide la spec, y se deja para cuando el negocio confirme que rota turnos de
   verdad.

## 10. Lo que queda pendiente

- **El recordatorio se evalúa al iniciar sesión, no en un proceso programado.** Quien no entre
  en una semana no recibe el aviso — y precisamente esa persona es la que más falta le hace.
  Cuando el proyecto tenga un planificador, RN-10.10 debería pasar a ejecutarse una vez por
  semana; la función ya está aislada y no depende de la petición.
- **No hay `effective_from` en `rest_groups`** (decisión 5), así que rotar turnos se hace
  creando grupos, no editando los que hay.
