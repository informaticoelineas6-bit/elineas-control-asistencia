# 15 · Agregación diaria, dashboard y paneles de gestión

> **Origen:** `old-docs.md` §3.5, puntos 50, 51, 52, 53.
> **Estado en el sistema legacy:** ✅ implementado (el hook de agregación era el más grande del proyecto, ~600 líneas).
> **Estado en el monorepo nuevo:** ⚠️ parcial. **Su función pura ya existe**, adelantada por la
> [09](./09-marcaje-asistencia.md) §5 porque el historial propio la necesitaba:
> `computeDailyStatus` en `apps/backend/src/services/daily-status.ts`, con los cinco estados de
> §2, los datos derivados de §3 y 12 pruebas. Está **en el sitio que esta spec manda** —una sola
> definición— precisamente para no repetir el error del legacy, donde la lógica vivía en un
> hook, una función SQL y una edge function a la vez. Falta lo demás: vacaciones y AJ/ANJ como
> superposiciones (specs 11 y 13), la carga en lote para varios usuarios, los tres paneles y la
> materialización en `attendance_daily_facts`.
>
> Dos puntos que esta spec dejaba abiertos y la implementación tuvo que resolver para poder
> pintar el historial; **conviene confirmarlos aquí**:
>
> - **RN-15.2 aplicada tal cual:** un día con marcas sale `PRESENTE`/`TARDE` aunque el
>   calendario lo diera por no laborable o fuera descanso. Esconder trabajo que existió es peor
>   que contradecir la precedencia de presentación.
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
| `VACACIONES` | Solicitud aprobada que cubre la fecha ([11](./11-vacaciones.md)) |
| `AJ` / `ANJ` | Ausencia con decisión de justificación ([13](./13-justificacion-ausencias.md)) |

### Orden de precedencia (definir de una vez y respetarlo en todos lados)

```
1. NO_LABORABLE   (calendario del departamento)
2. VACACIONES     (aprobadas y vigentes)
3. DESCANSO       (descansos de la persona en esa fecha)
4. PRESENTE / TARDE  (si hay marcaje)
5. AUSENTE  →  AJ / ANJ  según la revisión de la ausencia
```

- **RN-15.1** — Este orden es normativo. Un día de vacaciones que además era descanso sale
  como `VACACIONES` (y **decisión abierta**: ¿debería consumir saldo? Ver
  [11](./11-vacaciones.md) RN-11.5).
- **RN-15.2** — Un marcaje en un día que debía ser descanso o no laborable: no debería
  existir (se rechaza en origen), pero si existe por importación histórica, gana `PRESENTE`.
  **Confirmar.**

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
- Un servicio que carga el contexto en lote (marcajes, horarios, calendario, descansos,
  vacaciones, revisiones) para un rango y un conjunto de usuarios, y aplica la función.
- El frontend **no calcula estados**. Consume `DailyFact` ya resuelto.
- Para volumen, el resultado se materializa en `attendance_daily_facts`
  ([16-reporteria-mensual](./16-reporteria-mensual.md) §4).

> **Trampa conocida (N+1):** el legacy calculaba por empleado en cliente y tuvo que mover el
> cálculo al servidor para eliminarlo (punto 55). El servicio nuevo debe cargar el contexto en
> **consultas por lote**, nunca una por empleado.

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
- Acción de justificar ausencias en línea ([13](./13-justificacion-ausencias.md)).
- Selector de fecha y de departamento (si gestiona varios — RN-03.2).
- Exportación acotada a su ámbito.

### 5.3 Panel global (`global_manager` / `superadmin`)

- Trabajadores por departamento y asistencia de hoy.
- Detalle por empleado.
- Justificación de ausencias de cualquiera.
- Exportación y envío a Google Sheets ([16](./16-reporteria-mensual.md)).

> Los paneles 5.2 y 5.3 hacen **lo mismo con distinto alcance**. En el monorepo deben ser una
> vista parametrizada por ámbito, no dos páginas.

## 6. API propuesta

| Método | Path | Descripción |
|---|---|---|
| `GET` | `/attendance/daily?date=&scope=&departmentId=` | Estado del día por persona, filtrado por ámbito |
| `GET` | `/attendance/daily-range?from=&to=&userId=` | Serie de días de una persona |
| `GET` | `/dashboard/summary` | Métricas del rol que consulta |
| `GET` | `/dashboard/trend?days=7` | Serie de presencia/ausencia |
| `GET` | `/dashboard/alerts` | Pendientes accionables del ámbito |

Todos aplican el ámbito de [03-roles-y-autorizacion](./03-roles-y-autorizacion.md) §5 en
servidor. Un `department_head` que pida `scope=global` recibe 403, no datos recortados en
silencio.

## 7. Criterios de aceptación

- [ ] Existe **una** implementación del cálculo de estado diario, con tests por cada rama del
      orden de precedencia de §2.
- [ ] Un día de vacaciones aprobado nunca sale como `AUSENTE`.
- [ ] Un día de descanso nunca sale como `AUSENTE`.
- [ ] Una jornada sin salida no reporta `worked_minutes` inventados y se marca incompleta.
- [ ] El estado del día de un departamento en otra zona horaria se calcula en su zona.
- [ ] Un panel con 200 empleados no dispara 200 consultas (test de conteo de consultas).
- [ ] Un `department_head` no obtiene datos de departamentos fuera de su ámbito por ningún
      parámetro de la petición.

## 8. Decisiones abiertas

1. ¿Vacaciones sobre día de descanso: cómo se presenta y si consume saldo? (RN-15.1)
2. ¿Marcaje en día no laborable — se acepta como `PRESENTE` extraordinario? (RN-15.2)
3. ¿El dashboard debe ser configurable por rol o fijo?
4. ¿Se necesita "estado en vivo" (quién está dentro de la sede ahora mismo)? El legacy no lo
   tiene, pero es la pregunta que un jefe de planta hace a diario.
