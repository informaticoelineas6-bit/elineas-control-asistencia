# 16 · Reportería mensual

> **Origen:** `old-docs.md` §3.5, puntos 54–59, 73, 78, 79; hallazgo H-1.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con deuda en observabilidad y en el duplicado de la matriz de exportación.
> **Estado en el monorepo nuevo:** ✅ implementado, **menos el transporte a Google Sheets**
> (§7.2), que es la decisión 2 de la §11 y sigue abierta. Lo que esa sección marca como
> *requisito de aceptación* —que la matriz se construya una sola vez y ambos formatos serialicen
> lo mismo— **sí está**, con su prueba celda a celda: falta el transporte, no la forma.
>
> La matriz compartida en `packages/validations/src/reports.ts` (`buildReportGrid`); el XLSX con
> **hucre** en `apps/backend/src/services/xlsx.ts`; las tres tablas de las §3, §4 y §5;
> la cola y su trabajador en `services/report-runs.ts`, arrancado desde `index.ts` y no desde
> `app.ts`; la materialización en `services/daily-facts-store.ts`; la pantalla en
> `/reports`. 19 pruebas puras en `services/report-rules.test.ts` —incluida la comparación
> celda a celda— y 31 de integración en `routes/reports.test.ts`.
> **Depende de:** [15-paneles-y-dashboard](./15-paneles-y-dashboard.md) (la agregación diaria es la entrada).

---

## 1. Objetivo

Producir el **reporte mensual de asistencia**: una matriz empleado × día con el código de
estado de cada jornada y un resumen por empleado. Es el entregable que se usa para nómina y
para el control operativo, y por eso tiene requisitos que las pantallas no tienen:
reproducibilidad, trazabilidad de las reglas aplicadas y capacidad de correrse sobre miles de
filas sin bloquear al usuario.

## 2. Formato del reporte

### Matriz empleado × día

Una fila por empleado, una columna por día del mes, con el código del estado:

| Código | Significado |
|---|---|
| `P` | Presente |
| `T` | Tarde |
| `D` | Descanso |
| `NL` | No laborable |
| `V` | Vacaciones |
| `AJ` | Ausencia justificada |
| `ANJ` | Ausencia no justificada |

> **Decisión 1 de la §11, cerrada con lo que se pudo comprobar.** El código del legacy no está
> en este repositorio y `old-docs.md` sólo documenta dos cosas —que `AJ`/`ANJ` son los de
> ausencia justificada e injustificada (punto 54) y los nombres de las seis columnas del
> resumen—, y las dos coinciden con esta tabla. El resto se toma tal como está escrito.
>
> El riesgo de continuidad es además menor de lo que la pregunta sugiere: los reportes se
> **regeneran** desde la agregación diaria, no se leen de archivos viejos, así que un cambio de
> código no corrompe nada — sólo obliga a mirar dos veces un XLSX archivado.

### Resumen por empleado (6 columnas)

Presente · Descanso · Tardanza · Ausencia justificada · Ausencia injustificada · Vacaciones

- **RN-16.1 — Los totales deben cuadrar** con los días del periodo: la suma de las 6 columnas
  = días del mes. Debe haber un test que lo verifique.
  > ⚠️ **Con seis columnas no puede cuadrar.** Falta una: los días **no laborables**. En un mes
  > con un feriado, `P + D + T + AJ + ANJ + V` da un día menos que el mes, y la regla sería
  > imposible de cumplir. El resumen lleva por tanto un séptimo contador, `noLaborable`, que se
  > devuelve aparte para que **las seis del entregable sigan siendo las seis** — la matriz sí
  > enseña `NL` en su columna del día, que es donde el dato importa. Hay dos pruebas de que la
  > suma de los siete es el número de días, una de ellas sobre un mes entero.
- **RN-16.2 — Inclusión de jefes.** `include_heads_in_global_reports`
  ([06](./06-configuracion-global.md)) decide si los `department_head` aparecen en el reporte
  global.
  > ⚠️ **No se puede aplicar todavía, y la clave se queda esperando.** Este sistema no sabe qué
  > perfiles tienen rol `department_head` sin que esa persona se autentique (RN-00.43): los roles
  > viven en el Identity Server. Hoy el reporte global incluye a todo el mundo. Es la **quinta**
  > aparición de la [decisión 3 de la spec 11 §9](./11-vacaciones.md), después de las
  > notificaciones de vacaciones, las de incidencias, la advertencia de nómina sin sueldo y el
  > aviso de RN-17.7.
- **RN-16.3 — Alcance.** El reporte global incluye todos los departamentos; el de
  departamento, sólo el ámbito del solicitante ([03](./03-roles-y-autorizacion.md) §5).

## 3. Generación asíncrona

Un reporte mensual de toda la empresa no se genera en una petición HTTP. El legacy lo resolvió
con un **job encolado** y esa decisión se mantiene.

### `report_runs`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `scope` | enum `global` / `department` | |
| `department_id` | uuid, nullable | Requerido si `scope = department` |
| `period_start` / `period_end` | date | |
| `status` | enum | `queued` → `running` → `completed` / `failed` |
| `requested_by` | uuid | |
| `artifact_bucket` / `artifact_path` | text, nullable | Dónde quedó el archivo |
| `checksum` | text, nullable | Integridad del artefacto |
| `row_count` | int, nullable | |
| `duration_ms` | int, nullable | |
| `error_message` | text, nullable | |
| `retry_count` | int | |
| `rule_version_id` | uuid FK | Qué reglas regían (§5) |
| `created_at` / `updated_at` | timestamptz | |

### Reglas

- **RN-16.4 — Reintentar crea una fila nueva**, nunca muta el historial. El historial de
  corridas es un registro, no un estado mutable.
- **RN-16.5 — Descarga por enlace firmado y temporal.** El artefacto vive en almacenamiento
  privado; el enlace caduca. El bucket del legacy: `monthly-reports`, privado, límite 50 MB.
- **RN-16.6 — Seguimiento en la UI.** Sondeo cada 15 s mientras haya corridas activas; se
  detiene cuando no las hay. Notificación al terminar ([14](./14-notificaciones.md)).
- **RN-16.7 — Sin corridas duplicadas.** No se encolan dos corridas del mismo `scope` +
  periodo + departamento mientras una esté `queued` o `running`.
- **RN-16.8 — Tiempo límite.** Una corrida `running` que supere N minutos pasa a `failed`
  con motivo. Sin esto, una corrida colgada bloquea RN-16.7 para siempre.
  > `N` son 15 minutos (`REPORT_RUN_TIMEOUT_MS`), y la comprobación corre **justo antes de tomar
  > trabajo nuevo**, que es el momento en que importa: si no, la siguiente petición de ese mismo
  > reporte chocaría contra el índice de RN-16.7 y nadie podría desbloquearlo. Hay una prueba que
  > cuelga una corrida, la caduca y comprueba que **se puede volver a encolar**.

> **Dónde vive el artefacto.** El bucket `monthly-reports` del legacy era de Supabase, que la
> [00](./00-migracion-datos-e-identidad.md) sacó del proyecto. Aquí es un **volumen del
> contenedor** (`REPORTS_DIR`, declarado en los dos compose) que no se sirve como estático, y la
> descarga pasa por un endpoint que comprueba ámbito y devuelve un enlace firmado. El nombre del
> bucket se conserva en `artifact_bucket` como etiqueta de dónde vive.
>
> La firma es un HMAC del identificador **y su caducidad**, así que no hay tabla de tokens que
> limpiar y cambiar la fecha invalida el enlace. El secreto sale de `REPORT_DOWNLOAD_SECRET`; sin
> él se usa uno aleatorio por proceso —igual de seguro, pero un redespliegue invalida los enlaces
> recién entregados—, y por eso el `.env.production.example` lo pide.
>
> **El endpoint del archivo no exige sesión**, y es deliberado: un enlace que además pida la
> cookie no es un enlace, es la misma pantalla. Lo que autoriza ahí es la firma, que sólo pudo
> emitirla `GET /runs/:id/download` **después** de comprobar el ámbito.

## 4. Escala: hechos diarios precalculados

### `attendance_daily_facts`

Snapshot día × empleado con el estado ya resuelto ([15](./15-paneles-y-dashboard.md)).

| Campo | Tipo |
|---|---|
| `user_id`, `date` | clave única |
| `department_id` | uuid |
| `status` | enum de [15](./15-paneles-y-dashboard.md) §2 |
| `in_timestamp` / `out_timestamp` | timestamptz nullable |
| `late_minutes` / `worked_minutes` | int nullable |
| `rule_version_id` | uuid |
| `computed_at` | timestamptz |

- **RN-16.9 — Refresco.** Proceso programado diario que recalcula el día anterior, más una
  operación de recálculo por rango invocable manualmente (para cuando se corrige una
  justificación o se importa histórico).
- **RN-16.9 — Refresco.** *(Ver arriba.)* El proceso programado corre **cada hora** en vez de a
  una hora fija: sin un planificador externo, así el día anterior queda calculado aunque el
  contenedor se reinicie a cualquier hora, y recalcular lo mismo es inocuo por RN-16.10. Lo
  arranca `index.ts`, no `app.ts`, para que las pruebas no se peleen con un proceso de fondo.
- **RN-16.10 — El snapshot es caché, no verdad.** Siempre debe poder regenerarse desde los
  datos crudos y dar el mismo resultado. Un test de "recalcular no cambia nada" es la mejor
  garantía contra la deriva.
  > La prueba está, y además **no existe ninguna operación que edite un hecho**: sólo se
  > recalculan enteros desde `loadDailyFacts`, la misma función que alimenta los paneles y el
  > historial. Que no haya un camino para modificar uno a mano es lo que hace cierta la regla,
  > más que cualquier prueba.
  >
  > Por eso **leer el reporte de un periodo lo materializa primero**. Un periodo que nunca se
  > calculó daría un reporte vacío, y eso no se lee como "sin datos": se lee como un mes sin
  > ausencias. El refresco es idempotente por esta misma regla, cuesta las mismas consultas que
  > un panel y deja la tabla caliente para la corrida asíncrona.
- **RN-16.11 — Invalidación.** Justificar una ausencia, aprobar vacaciones, cambiar descansos
  con efecto retroactivo o importar histórico deben marcar los días afectados para recálculo.
  *El legacy no documenta esta invalidación — es un hueco real.*
  > **Dos de los cuatro se enganchan, con su rango exacto**: justificar una ausencia
  > (`services/absences.ts`, también por la vía de la acción combinada de la spec 12) y revisar
  > vacaciones (`services/vacations.ts`, el rango entero de la solicitud). El refresco va
  > **después** de confirmar la transacción, porque el recálculo lee con la conexión suelta y no
  > vería lo que aún no se ha escrito.
  >
  > Los otros dos no, por razones distintas: **cambiar los días de un grupo de descanso alcanza
  > al pasado de sus miembros** ([10](./10-descansos.md) §9, decisión 5) y ese pasado no tiene
  > principio, así que no hay rango que refrescar — la herramienta para eso es precisamente el
  > recálculo manual, que existe por esto; y **la importación de histórico** es de la
  > [21](./21-migracion-desde-legacy.md) y todavía no existe.

## 5. Trazabilidad: versiones de reglas

### `attendance_rule_versions`

| Campo | Tipo |
|---|---|
| `id` | uuid PK |
| `version` | int |
| `params` | jsonb — la foto de la configuración aplicada |
| `is_active` | boolean |
| `activated_at` | timestamptz |

- **RN-16.12** — Cada corrida y cada hecho diario guardan con qué versión de reglas se
  calcularon. Permite responder "por qué en marzo este día salía distinto".
- **RN-16.13** — Cambiar una clave de configuración que afecte al cálculo debería crear una
  versión nueva.
  > **Automático, pero perezoso.** No hay disparador sobre la tabla de configuración: la versión
  > se comprueba y se crea cuando algo va a *usarla* —al materializar hechos o al encolar una
  > corrida—. Un disparador tendría que decidir qué hacer con las claves que **no** afectan al
  > cálculo, y versionar en el momento del uso da la misma respuesta con una pieza menos.
  >
  > Cuáles afectan está enumerado en `CALCULATION_KEYS`: zona, tolerancia, modo de salida,
  > límites de descansos, tasa de vacaciones y divisor de nómina. El identificador de la hoja de
  > cálculo y los SLOs **no**: incluirlos crearía una versión cada vez que alguien corrige una
  > URL, y el historial dejaría de significar nada.

## 6. Observabilidad

KPIs operativos de la reportería: tasa de error, disponibilidad y p95 de duración, contra los
SLOs de `report_slo_error_rate_pct` y `report_slo_availability_pct`.

> ⚠️ **Hallazgo H-1:** en el legacy, la función de KPIs llamaba a la comprobación de jefe de
> departamento **con los argumentos invertidos**. Falla cerrado (no filtra datos ajenos) pero
> un jefe nunca ve los KPIs de su propio departamento. Al reimplementar: **una sola función
> de comprobación de ámbito, tipada** ([03](./03-roles-y-autorizacion.md) §5).
>
> **Aquí no hay comprobación de ámbito que invertir.** Estos KPIs son de la **reportería
> entera** —cuántas corridas fallaron, cuánto tardan—, no de un departamento, así que la ruta
> los reserva a un `global_manager` con el mismo `requireRole` que todo lo demás. El hallazgo se
> evita quitando la pieza que fallaba, no reescribiéndola con más cuidado.

Dos decisiones del cálculo, porque un KPI mal definido es peor que no tenerlo:

- **La tasa de error se calcula sobre las corridas terminadas**, no sobre todas. Una encolada
  hace un segundo no es ni un éxito ni un fallo, y meterla en el denominador haría que la tasa
  de error **bajara sola** por pedir reportes.
- **El p95 es el del "nearest rank"**: devuelve una duración que existió de verdad, en vez de
  interpolar entre dos. Sin muestra devuelve nulo y no cero — cero diría "todas tardaron nada",
  que es falso: no hubo.

## 7. Exportaciones

### 7.1 XLSX

Descarga del archivo con la matriz y el resumen de §2.

### 7.2 Google Sheets

Envío a una hoja de cálculo (`google_sheets_report_spreadsheet_id`), autenticado con una
cuenta de servicio.

> ⚠️ **Deuda crítica heredada (punto 73):** en el legacy, la exportación a Sheets
> **reimplementa a mano la misma matriz** que la exportación XLSX, porque la función remota no
> podía importar el código compartido. No hay contrato común ni test que detecte una
> desincronización: cambiar una columna en un lado deja el otro silenciosamente mal.
>
> **En el monorepo esto se resuelve de raíz:** la matriz se construye **una vez**, en un
> módulo compartido (`packages/` o backend), y ambos formatos serializan la misma estructura.
> **Requisito de aceptación, no sugerencia.**

**Hecho, y con su prueba.** `buildReportGrid` vive en `@elineas/validations` —el paquete que ya
comparten servidor e interfaz— y de ahí salen **tres** consumidores, no dos: el XLSX, la matriz
de valores que la API de Sheets consume tal cual, y **la tabla de la pantalla**, que si armara
la suya sería la primera en desincronizarse. La prueba escribe el XLSX de verdad, lo vuelve a
leer y lo compara con la matriz de valores **celda a celda**.

Sobre **hucre** para el XLSX, por si alguien se pregunta por qué no una de las habituales: cero
dependencias (SheetJS ya no se publica en npm y ExcelJS arrastra nueve), ESM y TypeScript
nativos —como todo lo demás aquí— y un formato de escritura por filas que es exactamente la
forma que ya tiene `ReportGrid`, así que la traducción cabe en una línea.

## 8. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/reports/monthly?period=&scope=&departmentId=` | department_head (ámbito) — datos en JSON |
| `POST` | `/reports/runs` | department_head (ámbito) — encola una corrida |
| `GET` | `/reports/runs?scope=` | department_head (ámbito) |
| `GET` | `/reports/runs/:id/download` | quien la solicitó / ámbito — enlace firmado |
| `POST` | `/reports/runs/:id/retry` | idem — crea fila nueva (RN-16.4) |
| `GET` | `/reports/kpis` | global_manager |
| ~~`POST`~~ | ~~`/reports/export-to-sheet`~~ | **no está** — decisión 2 de la §11, abierta |
| `POST` | `/attendance/facts/refresh` | global_manager — recálculo por rango |
| `GET` | `/reports/artifacts/:id?expires=&token=` | **añadido** — el archivo en sí, autorizado por la firma |

Una diferencia con la tabla: **`POST /reports/runs` no lleva `scope` en el cuerpo.** Se deduce
de si viene `departmentId`; sin él la corrida es global, y quién puede pedir una global lo
decide el rol. Un cuerpo con `scope: "global"` y un `departmentId` a la vez es contradictorio, y
admitirlo obliga a decidir cuál gana — sin el campo, la pregunta no existe.

## 9. Criterios de aceptación

- [x] La matriz XLSX y la enviada a Sheets se generan desde **el mismo módulo**; un test
      compara ambas salidas celda a celda.
- [x] Los totales del resumen suman los días del periodo para todo empleado (RN-16.1). *(Con la
      séptima columna que la regla necesitaba y no nombraba — ver RN-16.1.)*
- [x] Reintentar una corrida fallida crea una fila nueva y conserva la anterior.
- [x] Dos solicitudes del mismo reporte en paralelo encolan una sola corrida.
- [x] Una corrida colgada pasa a `failed` por tiempo límite. *(Y con eso se puede volver a
      encolar, que es lo que la regla protege.)*
- [x] Recalcular los hechos diarios de un mes cerrado no cambia ningún valor (RN-16.10).
      *(Fila a fila, con `computed_at` como única diferencia admitida.)*
- [x] Justificar una ausencia de un mes ya calculado actualiza el hecho diario (RN-16.11).
      *(Sin volver a leer el reporte: lo hace la invalidación.)*
- [x] Un `department_head` sólo puede encolar y descargar reportes de su ámbito. *(Y tampoco
      puede pedir el global, que es lo que ocurre al omitir el departamento.)*
- [x] El enlace de descarga caduca y no es adivinable. *(Token manipulado → 403; caducidad
      cambiada → 403, porque la firma la incluye.)*

## 10. Pendientes heredados

- **Particionamiento de la tabla de marcajes** (punto 78) — condicional a superar el umbral
  (>10 M filas o p95 > 2 s sostenido). No hacer antes de medirlo.
- **Pruebas de carga** (punto 79) — existe una guía en el legacy, sin evidencia de ejecución.

## 11. Decisiones abiertas

1. ~~Códigos exactos de la matriz.~~ **Cerrada con lo que se pudo comprobar**: los de la tabla
   de la §2. Ver la nota de esa sección.
2. **⚠️ Sigue abierta — ¿se mantiene la integración con Google Sheets, o basta el XLSX?** Es una
   decisión de negocio, y no técnica, con una restricción de infraestructura detrás: exige una
   cuenta de servicio de Google y salida a sus APIs desde el servidor, y la empresa opera en Cuba
   ([06](./06-configuracion-global.md) §8), donde eso no se puede dar por hecho. La clave
   `google_sheets_report_spreadsheet_id` ya existe con default nulo — "sin configurar"—, así que
   la spec 06 nunca dio por supuesto que estuviera.
   > **Lo que no está pendiente es la forma.** El requisito duro de la §7 —una sola matriz, dos
   > serializadores— está construido y probado celda a celda. Si la respuesta es "sí", lo que
   > falta es el transporte: autenticar con la cuenta de servicio y mandar `toValueMatrix(...)` a
   > `spreadsheets.values.update`. Si es "no", no hay nada que deshacer.
3. ~~¿Mes natural o periodo de nómina propio?~~ **Cerrada: mes natural.** Es lo que la spec
   describe y lo que hay. Un periodo del 26 al 25 no lo ha pedido nadie y arrastraría a la
   [17](./17-nomina.md), cuyo cierre de periodo (§7) sigue siendo *su* decisión abierta; cuando
   se resuelva allí, aquí es cambiar `periodRange` y nada más — es una función de cuatro líneas
   con sus pruebas.
4. ~~¿Quién puede descargar reportes de periodos anteriores a su incorporación?~~ **Cerrada:
   cualquiera con ámbito sobre ese reporte.** El reporte es de un departamento y un periodo, no
   de una persona: acotarlo por fecha de alta dejaría a un jefe recién nombrado sin poder mirar
   el mes anterior al suyo, que es justo cuando más falta le hace.
   > ⚠️ **Esta decisión tiene una consecuencia que apareció al construir la
   > [17](./17-nomina.md):** si el artefacto lo descarga cualquiera con ámbito —o sea también un
   > `department_head`—, entonces **nada con importes puede entrar en él**. Su RN-17.11 pedía una
   > hoja de ajustes del periodo dentro de este XLSX, y un importe de ausencia injustificada es
   > el sueldo dividido por el divisor: enseñárselo a un jefe le enseña el sueldo (RN-17.1,
   > hallazgo H-3). Los ajustes se exportan por su cuenta desde `/payroll`, con la misma
   > maquinaria —`gridToXlsx` sobre una cuadrícula construida una sola vez, §7— y otro control de
   > acceso. **Regla para lo que venga: una hoja nueva en este libro hereda a todos sus
   > lectores.**
