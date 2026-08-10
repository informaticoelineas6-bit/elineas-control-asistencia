# 13 · Justificación de ausencias

> **Origen:** `old-docs.md` §3.4, puntos 44, 45, 64.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Depende de:** [09-marcaje-asistencia](./09-marcaje-asistencia.md), [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).
> **Dispara:** [17-nomina](./17-nomina.md) — el descuento automático nace aquí.
> **No confundir con:** [12-incidencias](./12-incidencias.md).

---

## 1. Objetivo

Cuando una persona **no asiste** un día laborable, el jefe decide si esa ausencia está
justificada o no. Esa decisión tiene dos consecuencias:

1. **Reportería** — el día sale como **AJ** (ausencia justificada) o **ANJ** (injustificada).
2. **Nómina** — una ausencia **injustificada genera un descuento automático**; reclasificarla
   como justificada lo **revierte**.

Es el flujo con más impacto económico del sistema. Un clic aquí mueve dinero.

## 2. Modelo de datos

### `attendance_absence_reviews`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `date` | date | **Único por (`user_id`, `date`)** — una decisión por día |
| `is_justified` | boolean | |
| `notes` | text, nullable | |
| `reviewed_by` | uuid | |
| `reviewed_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz | |

La escritura es un **upsert** por (`user_id`, `date`): revisar de nuevo el mismo día
sobrescribe la decisión anterior (y dispara la reversión o creación del ajuste de nómina).

## 3. Reglas de negocio

- **RN-13.1 — Sólo sobre días efectivamente ausentes.** Se puede revisar un día sólo si la
  agregación diaria lo clasifica como `AUSENTE`
  ([15-paneles-y-dashboard](./15-paneles-y-dashboard.md)). No tiene sentido justificar un día
  presente, de descanso, no laborable o de vacaciones. **Validar en servidor.**
- **RN-13.2 — Una decisión por día.** Clave única (`user_id`, `date`). Cambiar la decisión
  sobrescribe, dejando trazabilidad de quién y cuándo.
- **RN-13.3 — Quién decide.** El `department_head` del ámbito o un `global_manager`.
  Nadie justifica sus propias ausencias.
- **RN-13.4 — Efecto en nómina (el crítico).**
  - Marcar `is_justified = false` → **crea** un ajuste de descuento por
    `sueldo_mensual / divisor` ([17-nomina](./17-nomina.md)).
  - Reclasificar a `is_justified = true` → **revierte** el ajuste
    (lo marca `reverted`, **no lo borra**).
  - Volver a `false` → crea un ajuste **nuevo**, no resucita el anterior.
  - Esta cadena debe ser idempotente: dos escrituras iguales seguidas no producen dos
    descuentos.
- **RN-13.5 — Barrera de privilegios.** El jefe de departamento **no tiene ni debe tener
  acceso a la tabla de nómina**, pero su acción la escribe. En el legacy esto se resolvía con
  un trigger `SECURITY DEFINER`. En el monorepo: el efecto debe ejecutarse **en el servicio de
  dominio del backend, dentro de la misma transacción**, no exponiendo nómina al handler del
  jefe. Nunca en el cliente.
- **RN-13.6 — Notas.** Obligatorias al justificar (hace falta saber por qué se perdonó una
  ausencia); opcionales al marcar como injustificada.
  **Confirmar contra el legacy** — probablemente ambas eran opcionales.
- **RN-13.7 — Notificación al empleado.** Debe saber que su ausencia se clasificó y si se le
  aplicó un descuento. ⚠️ **El legacy no lo hace** (punto 76): el empleado se entera en la
  boleta. Es un requisito nuevo razonable.
- **RN-13.8 — Auditoría.** Toda decisión se registra en [18-auditoria](./18-auditoria.md) con
  el valor anterior. ⚠️ En el legacy, los ajustes de nómina **no** llegaban a la bitácora
  (punto 76).
- **RN-13.9 — Plazo de revisión.** **Decisión abierta:** ¿se puede reclasificar una ausencia
  de un periodo de nómina ya cerrado? Si la nómina del mes ya se pagó, revertir el descuento
  necesita un tratamiento distinto (ajuste del mes siguiente).
- **RN-13.10 — Sin decisión = injustificada por defecto en el reporte.** Un día ausente sin
  fila de revisión sale como **ANJ** en el reporte pero **no** genera descuento (el descuento
  requiere la decisión explícita). **Confirmar** — es una asimetría importante.

## 4. Relación con las incidencias

Ver [12-incidencias](./12-incidencias.md) §2. Los dos flujos están desconectados: aprobar la
incidencia "olvidé marcar" no justifica el día. **Decisión abierta compartida.**

## 5. Dónde se hace

En el legacy la justificación se hace desde dos pantallas distintas:

- **Panel de departamento** (jefe) — sobre la asistencia del día de su equipo.
- **Panel global** (gestor global) — sobre cualquier empleado.

Ambas escriben lo mismo. En el monorepo debe ser **un componente compartido** con el ámbito
como parámetro, no dos implementaciones.

**Falta en el legacy y hace falta:** una vista de "ausencias pendientes de revisar" —
hoy sólo se ven navegando día por día. Propuesta: bandeja con las ausencias sin decisión del
ámbito del jefe, con badge en la navegación, igual que las incidencias.

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/absences/pending?scope=` | department_head (ámbito) — días ausentes sin revisar |
| `GET` | `/absences?userId=&from=&to=` | department_head (ámbito) |
| `PUT` | `/absences/:userId/:date` | department_head (ámbito) — `{ isJustified, notes }`, upsert |

La respuesta debe indicar explícitamente **qué pasó con la nómina**
(`payrollAdjustment: { created \| reverted \| unchanged, amount }`) para que la UI lo confirme
al jefe antes y después de la acción.

## 7. UI

- En la fila del empleado ausente: dos acciones claras, *Justificada* / *No justificada*,
  con campo de notas.
- **Confirmación explícita del impacto económico** antes de marcar como no justificada:
  "Se aplicará un descuento de S/ X a [nombre]". El legacy no lo advierte.
- Mostrar quién y cuándo tomó la decisión anterior si se está cambiando.

## 8. Criterios de aceptación

- [ ] Justificar un día que no está ausente devuelve error.
- [ ] Marcar `no justificada` crea exactamente un ajuste de nómina con el monto correcto.
- [ ] Reclasificar a `justificada` marca el ajuste como revertido, sin borrarlo.
- [ ] Repetir la misma decisión dos veces no duplica ajustes.
- [ ] Un `department_head` puede justificar pero recibe 403 en cualquier endpoint de nómina.
- [ ] La decisión aparece en la bitácora con el valor anterior.
- [ ] El empleado recibe notificación de la clasificación.
- [ ] El día aparece como AJ o ANJ en el reporte mensual del periodo.

## 9. Decisiones abiertas

1. ¿Aprobar una incidencia justifica el día automáticamente? (compartida con [12](./12-incidencias.md))
2. ¿Se puede reclasificar tras cerrar el periodo de nómina? (RN-13.9)
3. ¿Ausencia sin revisar cuenta como ANJ en el reporte sin generar descuento? (RN-13.10)
4. ¿Notas obligatorias al justificar? (RN-13.6)
5. ¿Tipos de justificación (enfermedad, permiso, licencia) en vez de un booleano? Cambiaría el
   reporte, que hoy sólo distingue AJ/ANJ.
