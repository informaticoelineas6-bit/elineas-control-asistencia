# 16 · Reportería mensual

> **Origen:** `old-docs.md` §3.5, puntos 54–59, 73, 78, 79; hallazgo H-1.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con deuda en observabilidad y en el duplicado de la matriz de exportación.
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Lo que ya está hecho de sus cimientos:** la agregación diaria de la
> [15](./15-paneles-y-dashboard.md) —una sola definición del estado de un día, con `AJ`/`ANJ`
> incluidos— y su **carga en lote** (`services/daily-facts.ts`), que es de donde tiene que salir
> el reporte. La materialización en `attendance_daily_facts` de la §4 sigue pendiente y es de
> esta spec: hoy no hace falta para los paneles (11 consultas con 5 personas y 11 con 203), pero
> un reporte mensual de toda la plantilla es otro volumen.
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

*(Los códigos exactos deben confirmarse contra el legacy; AJ/ANJ sí están documentados.)*

### Resumen por empleado (6 columnas)

Presente · Descanso · Tardanza · Ausencia justificada · Ausencia injustificada · Vacaciones

- **RN-16.1 — Los totales deben cuadrar** con los días del periodo: la suma de las 6 columnas
  = días del mes. Debe haber un test que lo verifique.
- **RN-16.2 — Inclusión de jefes.** `include_heads_in_global_reports`
  ([06](./06-configuracion-global.md)) decide si los `department_head` aparecen en el reporte
  global.
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
- **RN-16.10 — El snapshot es caché, no verdad.** Siempre debe poder regenerarse desde los
  datos crudos y dar el mismo resultado. Un test de "recalcular no cambia nada" es la mejor
  garantía contra la deriva.
- **RN-16.11 — Invalidación.** Justificar una ausencia, aprobar vacaciones, cambiar descansos
  con efecto retroactivo o importar histórico deben marcar los días afectados para recálculo.
  *El legacy no documenta esta invalidación — es un hueco real.*

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
  versión nueva. **Confirmar** si el legacy lo hace automáticamente o a mano.

## 6. Observabilidad

KPIs operativos de la reportería: tasa de error, disponibilidad y p95 de duración, contra los
SLOs de `report_slo_error_rate_pct` y `report_slo_availability_pct`.

> ⚠️ **Hallazgo H-1:** en el legacy, la función de KPIs llamaba a la comprobación de jefe de
> departamento **con los argumentos invertidos**. Falla cerrado (no filtra datos ajenos) pero
> un jefe nunca ve los KPIs de su propio departamento. Al reimplementar: **una sola función
> de comprobación de ámbito, tipada** ([03](./03-roles-y-autorizacion.md) §5).

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

## 8. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/reports/monthly?period=&scope=&departmentId=` | department_head (ámbito) — datos en JSON |
| `POST` | `/reports/runs` | department_head (ámbito) — encola una corrida |
| `GET` | `/reports/runs?scope=` | department_head (ámbito) |
| `GET` | `/reports/runs/:id/download` | quien la solicitó / ámbito — enlace firmado |
| `POST` | `/reports/runs/:id/retry` | idem — crea fila nueva (RN-16.4) |
| `GET` | `/reports/kpis` | global_manager |
| `POST` | `/reports/export-to-sheet` | global_manager |
| `POST` | `/attendance/facts/refresh` | global_manager — recálculo por rango |

## 9. Criterios de aceptación

- [ ] La matriz XLSX y la enviada a Sheets se generan desde **el mismo módulo**; un test
      compara ambas salidas celda a celda.
- [ ] Los totales del resumen suman los días del periodo para todo empleado (RN-16.1).
- [ ] Reintentar una corrida fallida crea una fila nueva y conserva la anterior.
- [ ] Dos solicitudes del mismo reporte en paralelo encolan una sola corrida.
- [ ] Una corrida colgada pasa a `failed` por tiempo límite.
- [ ] Recalcular los hechos diarios de un mes cerrado no cambia ningún valor (RN-16.10).
- [ ] Justificar una ausencia de un mes ya calculado actualiza el hecho diario (RN-16.11).
- [ ] Un `department_head` sólo puede encolar y descargar reportes de su ámbito.
- [ ] El enlace de descarga caduca y no es adivinable.

## 10. Pendientes heredados

- **Particionamiento de la tabla de marcajes** (punto 78) — condicional a superar el umbral
  (>10 M filas o p95 > 2 s sostenido). No hacer antes de medirlo.
- **Pruebas de carga** (punto 79) — existe una guía en el legacy, sin evidencia de ejecución.

## 11. Decisiones abiertas

1. Códigos exactos de la matriz — confirmar contra el legacy para no romper la continuidad
   de los reportes históricos.
2. ¿Se mantiene la integración con Google Sheets, o basta el XLSX?
3. ¿El periodo del reporte es siempre mes natural, o hay periodo de nómina propio (p. ej. del
   26 al 25)? Afecta a [17-nomina](./17-nomina.md).
4. ¿Quién puede descargar reportes de periodos anteriores a su incorporación?
