# 15 · Agregación diaria, dashboard y paneles de gestión

> **Origen:** `old-docs.md` §3.5, puntos 50, 51, 52, 53.
> **Estado en el sistema legacy:** ✅ implementado (el hook de agregación era el más grande del proyecto, ~600 líneas).
> **Estado en el monorepo nuevo:** ✅ implementado. **Su función pura ya existía**, adelantada por la
> [09](./09-marcaje-asistencia.md) §5 porque el historial propio la necesitaba:
> `computeDailyStatus` en `apps/backend/src/services/daily-status.ts`, con los cinco estados de
> §2, los datos derivados de §3 y 12 pruebas. Está **en el sitio que esta spec manda** —una sola
> definición— precisamente para no repetir el error del legacy, donde la lógica vivía en un
> hook, una función SQL y una edge function a la vez. **Las vacaciones ya entraron** como
> superposición con la [11](./11-vacaciones.md), **y `AJ`/`ANJ` con la
> [13](./13-justificacion-ausencias.md)** — como superposición también, en un campo `absence`,
> no como estados nuevos de la lista de §2: son la *misma* ausencia con una decisión encima. La
> **carga en lote** para varias personas también existía, construida por la 13 para su bandeja
> de ausencias pendientes: al llegar aquí se sacó a `apps/backend/src/services/daily-facts.ts`,
> que es **el servicio que pide la §4**, y de paso el historial propio dejó de componer su
> propia versión — eran dos composiciones del mismo estado, justo el error que la §1 manda no
> repetir.
>
> Lo que esta spec añadió: los endpoints de la §6 (`apps/backend/src/services/dashboard.ts`,
> `routes/dashboard.ts` y dos rutas nuevas en `routes/attendance.ts`), el dashboard de la §5.1
> y **una sola vista para los paneles de la §5.2 y la §5.3** (`/daily`,
> `apps/frontend/src/modules/dashboard/`). 18 pruebas de integración en
> `apps/backend/src/routes/dashboard.test.ts`, incluida la del conteo de consultas.
>
> **La materialización en `attendance_daily_facts` la construyó la
> [16](./16-reporteria-mensual.md)**, que es su dueña. Los paneles siguen leyendo en vivo y no la
> necesitan —11 consultas con 5 personas y 11 con 203, medidas—; quien la usa es el reporte
> mensual.
>
> Dos puntos que esta spec dejaba abiertos y la implementación tuvo que resolver para poder
> pintar el historial; **conviene confirmarlos aquí**:
>
> - **RN-15.2 aplicada tal cual:** un día con marcas sale `PRESENTE`/`TARDE` aunque el
>   calendario lo diera por no laborable, fuera descanso **o hubiera vacaciones aprobadas**.
>   Esconder trabajo que existió es peor que contradecir la precedencia de presentación, y en
>   vivo no puede ocurrir —el marcaje se rechaza antes en los tres casos—, así que sólo llega
>   por importación histórica.
> - **`worked_minutes` suma los pares entrada→salida**, no `última salida − primera entrada`:
>   con la alternancia impuesta (RN-09.9) los pares son inequívocos y así el almuerzo no cuenta
>   como trabajado. Con un solo par da exactamente lo que describe §3.
> - **`pending`:** un `AUSENTE` de una jornada que todavía puede completarse se marca como
>   provisional. No es un estado nuevo —el vocabulario de §2 no lo tiene— sino una bandera, para
>   que la interfaz no pinte en rojo a alguien a media mañana.
> **Depende de:** [09](./09-marcaje-asistencia.md), [10](./10-descansos.md), [11](./11-vacaciones.md), [13](./13-justificacion-ausencias.md), [07](./07-horarios-y-calendario.md).
> **Habilita:** [16-reporteria-mensual](./16-reporteria-mensual.md).

---

## 1. Objetivo

Convertir marcajes crudos en **el estado de un día para una persona**, y presentarlo en tres
vistas según el rol: dashboard personal, panel de departamento y panel global.

La pieza central es la función de agregación: **una sola definición del estado diario**,
compartida por el dashboard, los paneles, el historial del empleado y la reportería mensual.
En el legacy esta lógica estaba duplicada entre un hook de frontend, una función SQL y una
edge function de exportación. **No repetir eso.**

## 2. Estados diarios

| Estado | Definición |
|---|---|
| `PRESENTE` | Hay marcaje de entrada válido dentro de tolerancia |
| `TARDE` | Hay entrada, pero pasada la tolerancia ([07](./07-horarios-y-calendario.md) RN-07.8) |
| `AUSENTE` | Día laborable, no es descanso, no hay entrada |
| `DESCANSO` | Día de descanso de la persona ([10](./10-descansos.md), ya construida: `computeDailyStatus` recibe el `isRestDay` real) |
| `NO_LABORABLE` | El calendario del departamento lo marca así ([07](./07-horarios-y-calendario.md)) |

Y **superpuesto** (no excluyente con los anteriores en el cálculo, pero sí en la
presentación):

| Superposición | Definición |
|---|---|
| `VACACIONES` | Solicitud aprobada que cubre la fecha ([11](./11-vacaciones.md), ya construida: `computeDailyStatus` recibe el `onVacation` real) |
| `AJ` / `ANJ` | Ausencia con decisión de justificación ([13](./13-justificacion-ausencias.md), ✅) |

### Orden de precedencia (definir de una vez y respetarlo en todos lados)

```
1. NO_LABORABLE   (calendario del departamento)
2. VACACIONES     (aprobadas y vigentes)
3. DESCANSO       (descansos de la persona en esa fecha)
4. PRESENTE / TARDE  (si hay marcaje)
5. AUSENTE  →  AJ / ANJ  según la revisión de la ausencia
                    (✅ y **sin revisión también es ANJ**, RN-13.10, con un campo
                     `reviewed` que distingue "lo decidió alguien" de "nadie lo miró")
```

- **RN-15.1** — Este orden es normativo. Un día de vacaciones que además era descanso sale
  como `VACACIONES`, y **no consume saldo** — la pregunta que esta regla dejaba abierta la
  cerró la [11](./11-vacaciones.md) (decisión 2 de su §9): sólo consumen los días laborables que
  además no son descanso. Presentación y consumo son dos cosas distintas, y ésta es la única
  combinación donde se nota la diferencia.
- **RN-15.2** — Un marcaje en un día que debía ser descanso o no laborable: no debería
  existir (se rechaza en origen), pero si existe por importación histórica, gana `PRESENTE`.
  > **Confirmada** (decisión 2 de la §8). Esconder trabajo que existió es peor que contradecir
  > un orden de presentación, y en vivo no puede ocurrir: el marcaje se rechaza antes en los
  > tres casos, así que sólo llega por importación histórica. Hay pruebas de las tres ramas.
  >
  > Una consecuencia que sólo aparece con la [13](./13-justificacion-ausencias.md) construida:
  > si un día justificado deja de ser ausente porque se importa un marcaje suyo, **la
  > superposición `AJ` desaparece** en vez de pintarse sobre un día presente. La fila de
  > revisión se queda huérfana y se ignora, que es menos malo que enseñar "justificada" sobre
  > alguien que estuvo.

## 3. Datos derivados por día

| Campo | Cálculo |
|---|---|
| `in_timestamp` | Primer marcaje `IN` del día |
| `out_timestamp` | Último marcaje `OUT` del día |
| `late_minutes` | Minutos entre `checkin_start_time + tolerancia` y la entrada; 0 si no hay tardanza |
| `worked_minutes` | Diferencia entre entrada y salida; `null` si falta la salida |

- **RN-15.3 — Jornada sin salida.** `worked_minutes = null`, y el día se marca como
  "incompleto". No se inventa una salida. Debe ser visible para el jefe.
- **RN-15.4 — Zona horaria.** El "día" se delimita en la zona horaria del departamento, no en
  UTC ni en la del servidor ([07](./07-horarios-y-calendario.md) RN-07.2).

## 4. Dónde vive el cálculo

**Propuesta para el monorepo:**

- Una función pura `computeDailyStatus(context) → DailyFact` en el backend, sin acceso a base.
  ✅ `services/daily-status.ts`.
- Un servicio que carga el contexto en lote (marcajes, horarios, calendario, descansos,
  vacaciones, revisiones) para un rango y un conjunto de usuarios, y aplica la función.
  ✅ `services/daily-facts.ts`.
- El frontend **no calcula estados**. Consume `DailyFact` ya resuelto. ✅ — ningún esquema del
  contrato lleva insumos para clasificar, sólo resultados.
- Para volumen, el resultado se materializa en `attendance_daily_facts`
  ([16-reporteria-mensual](./16-reporteria-mensual.md) §4). ✅ construida por esa spec, que es su
  dueña. Los paneles siguen leyendo en vivo: no la necesitan.

> **Trampa conocida (N+1):** el legacy calculaba por empleado en cliente y tuvo que mover el
> cálculo al servidor para eliminarlo (punto 55). El servicio nuevo debe cargar el contexto en
> **consultas por lote**, nunca una por empleado.

**Consultas reales:** dos por rango —marcas y revisiones de ausencia— más una de vacaciones y
tres por **departamento** (departamento, horario y contextos de descanso). No hay ninguna por
persona, y por eso el número no se mueve entre 5 empleados y 200. La prueba lo mide comparando
las dos cifras en vez de fijar un número mágico, que es lo único que sobrevive a añadir una
consulta legítima más adelante.

Y una consecuencia del sitio donde vive: `daily-facts.ts` **lee las tablas directamente, sin
pasar por los servicios de dominio**. Si pidiera las revisiones de ausencia a `absences.ts`,
ese servicio —que necesita clasificar días para aplicar RN-13.1— acabaría importándose a sí
mismo a través de aquí. La agregación va **debajo** de los dominios que la consumen, no al lado.

## 5. Las tres vistas

### 5.1 Dashboard de inicio (todos los roles, contenido variable)

| Rol | Qué ve |
|---|---|
| `employee` | Su estado de hoy, sus marcajes, su semana, su saldo de vacaciones |
| `department_head` | Lo anterior **+** presentes/ausentes/tarde de su equipo hoy, pendientes por revisar |
| `global_manager` / `superadmin` | Resumen ejecutivo global, por departamento, tendencia de 7 días, alertas |

Elementos: tarjetas de métrica, tendencia de 7 días, alertas de gestión (ausencias sin
revisar, incidencias pendientes, vacaciones por aprobar, departamentos pausados).

### 5.2 Panel de departamento (`department_head`)

- Asistencia del día del equipo, con estado por persona.
- Acción de justificar ausencias en línea ([13](./13-justificacion-ausencias.md)). *La 13 la
  construyó como **bandeja** en `/team` en vez de en línea sobre el panel del día, porque el
  panel no existe todavía y porque su §5 pedía justamente eso: una vista de pendientes, que el
  legacy no tenía. Cuando este panel exista, reutiliza el mismo endpoint.*
- Selector de fecha y de departamento (si gestiona varios — RN-03.2).
- Exportación acotada a su ámbito.

### 5.3 Panel global (`global_manager` / `superadmin`)

- Trabajadores por departamento y asistencia de hoy.
- Detalle por empleado.
- Justificación de ausencias de cualquiera.
- Exportación y envío a Google Sheets ([16](./16-reporteria-mensual.md)).

> Los paneles 5.2 y 5.3 hacen **lo mismo con distinto alcance**. En el monorepo deben ser una
> vista parametrizada por ámbito, no dos páginas.

**Son una: `/daily`, "Asistencia del día".** Y el ámbito ni siquiera es un parámetro — el
servidor devuelve lo que gestiona quien pregunta (RN-03.2), así que un jefe ve su departamento y
un gestor la empresa **con la misma petición**. El selector de departamento sólo aparece cuando
hay más de uno que elegir.

Dos cosas de la §5.2 que se resolvieron de otra manera, y conviene saber por qué:

- **La acción de justificar en línea no está en este panel.** La [13](./13-justificacion-ausencias.md)
  la construyó como bandeja en `/team`, porque su §5 pedía exactamente eso —una vista de
  ausencias pendientes, que el legacy no tenía— y tener el mismo acto en dos pantallas invita a
  dos formas distintas de hacerlo. Desde el panel se **ve** quién está ausente y con qué
  clasificación; se decide en *Mi equipo*.
- **La exportación acotada al ámbito** es de la [16](./16-reporteria-mensual.md), que no está.

## 6. API propuesta

| Método | Path | Descripción |
|---|---|---|
| `GET` | `/attendance/daily?date=&departmentId=` | Estado del día por persona, filtrado por ámbito |
| `GET` | `/attendance/daily-range?from=&to=&userId=` | Serie de días de una persona, con sus marcas |
| `GET` | `/dashboard/summary` | Métricas del rol que consulta |
| `GET` | `/dashboard/trend?days=7` | Serie de presencia/ausencia |
| `GET` | `/dashboard/alerts` | Pendientes accionables del ámbito |

Todos aplican el ámbito de [03-roles-y-autorizacion](./03-roles-y-autorizacion.md) §5 en
servidor. Un `department_head` que pida `scope=global` recibe 403, no datos recortados en
silencio.

> **`scope=` no existe.** En vez de aceptarlo y rechazarlo, se quitó: el ámbito sale de la
> sesión y `departmentId` sólo **acota** dentro de él, comprobado con `requireScope`. La
> propiedad que la frase de arriba busca se cumple más fuerte — el parámetro que puede ensanchar
> el ámbito es el parámetro por el que se escapan los datos. Es la misma decisión que en
> `/absences`, y hay una prueba que manda `?scope=global` como jefe y comprueba que no cambia
> nada.
>
> `summary` es el único que **no** exige rol de gestión: la §5.1 describe tres filas de una
> tabla, no tres pantallas, así que es un endpoint cuyo contenido decide el rol. Un empleado
> recibe lo suyo y `scope: null`. Los otros cuatro exigen `department_head`, porque no existe
> una versión "propia" de ellos que signifique algo — la tendencia de una sola persona es su
> historial, que ya está en `/attendance/me`.

## 7. Criterios de aceptación

- [x] Existe **una** implementación del cálculo de estado diario, con tests por cada rama del
      orden de precedencia de §2. *(Y al construir esta spec dejó de haber una segunda a medias:
      el historial propio componía su propio contexto en paralelo.)*
- [x] Un día de vacaciones aprobado nunca sale como `AUSENTE`.
- [x] Un día de descanso nunca sale como `AUSENTE`.
- [x] Una jornada sin salida no reporta `worked_minutes` inventados y se marca incompleta.
- [x] El estado del día de un departamento en otra zona horaria se calcula en su zona. *(Con un
      departamento en `Pacific/Kiritimati`, UTC+14.)*
- [x] Un panel con 200 empleados no dispara 200 consultas (test de conteo de consultas).
      *(**11 consultas con 5 personas y 11 con 203.** Se comparan las dos cifras en vez de fijar
      un número: así la prueba sigue valiendo si mañana se añade una consulta legítima.)*
- [x] Un `department_head` no obtiene datos de departamentos fuera de su ámbito por ningún
      parámetro de la petición.

> El último criterio encontró un fallo real antes de que llegara a ninguna parte: el resumen
> decidía si había ámbito mirando si `managedDepartmentIds` estaba vacía, y esa lista incluye el
> departamento **propio** de cualquiera — así que un `employee` habría recibido el resumen de
> sus compañeros. El ámbito lo decide el rol, no la lista; es la misma distinción que hace
> `hasScope` en el middleware.

## 8. Decisiones abiertas

1. ~~¿Vacaciones sobre día de descanso?~~ **Cerrada por la [11](./11-vacaciones.md)**
   (decisión 2 de su §9): se presenta como `VACACIONES` y **no consume saldo**. Presentación y
   consumo son dos cosas distintas, y ésta es la única combinación donde se nota. Ver RN-15.1.
2. ~~¿Marcaje en día no laborable?~~ **Cerrada: sí, gana `PRESENTE`.** Ver RN-15.2.
3. ~~¿El dashboard debe ser configurable por rol o fijo?~~ **Cerrada: fijo.** La §5.1 ya
   describe qué ve cada rol y las filas son acumulativas, así que es *una* pantalla cuyas
   secciones aparecen según lo que el servidor manda. Hacerlo configurable añadiría preferencias
   por usuario que nadie ha pedido y una segunda forma de que dos personas del mismo rol vean
   cosas distintas — que es justo lo que complica explicar un panel por teléfono.
4. ~~¿Se necesita "estado en vivo"?~~ **Cerrada a medias, con la mitad que se puede construir
   hoy: sí a "quién tiene la jornada abierta", no a "quién está dentro de la sede".** Cada fila
   del panel y el resumen del ámbito traen `open`: entrada sin salida y el día en curso. Es la
   pregunta del jefe de planta respondida con lo que el sistema sabe de verdad.
   > Lo otro —quién está **físicamente** en la geocerca ahora— exige seguimiento de ubicación en
   > segundo plano, que un navegador no da y que Android corta. **No está en el alcance**: la
   > spec de la app móvil se retiró y esa deuda vive en [08](./08-sedes-y-geocerca.md) §4.
   > Fingirlo con la última marca sería peor que no tenerlo: diría "dentro" de alguien que se fue
   > sin marcar.
