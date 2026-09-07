# 13 · Justificación de ausencias

> **Origen:** `old-docs.md` §3.4, puntos 44, 45, 64.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado, **incluida la parte de la
> [17](./17-nomina.md) que RN-13.4 necesita**: sin la tabla de ajustes y el descuento
> automático, la regla crítica de esta spec no se puede construir ni comprobar, y cuatro de los
> ocho criterios de la §8 quedarían sin marcar. Lo que falta de la 17 es su **superficie de
> administración** (ajustes manuales, sueldos, `/payroll/*`), no su modelo.
>
> Vocabulario y RN-13.6 en `packages/validations/src/absences.ts`; la superposición `AJ`/`ANJ`
> en `apps/backend/src/services/daily-status.ts` (la función de la [15](./15-paneles-y-dashboard.md));
> tablas `attendance_absence_reviews` y `payroll_adjustments`; el dominio en
> `apps/backend/src/services/absences.ts` y **la barrera de RN-13.5 en
> `apps/backend/src/services/payroll.ts`**, que no tiene ninguna ruta que lo exponga. Interfaz:
> la bandeja de la §5 en `/team` (`apps/frontend/src/modules/absences/`), y el código `AJ`/`ANJ`
> sobre el día en el historial propio. Pruebas: 36 de integración en
> `apps/backend/src/routes/absences.test.ts`, más las puras de `absence-rules.test.ts` y la
> superposición en `daily-status.test.ts`.
> **Depende de:** [09-marcaje-asistencia](./09-marcaje-asistencia.md), [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).
> **Dispara:** [17-nomina](./17-nomina.md) — el descuento automático nace aquí.
> **No confundir con:** [12-incidencias](./12-incidencias.md) — cuya decisión 1, la que
> esperaba por esta spec, **queda cerrada**: aprobar una incidencia **no** justifica la ausencia
> automáticamente, pero se puede hacer en el mismo acto. Ver §4.

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

**No hay `is_justified` nulo ni estado "pendiente".** Una ausencia sin revisar es *la ausencia
de una fila*, no una fila con un tercer valor. Es lo que hace que RN-13.10 se lea de un vistazo
en vez de dependiendo de cómo se interprete un nulo, y lo que permite que la bandeja de la §5
sea "los días ausentes que no tienen fila".

## 3. Reglas de negocio

- **RN-13.1 — Sólo sobre días efectivamente ausentes.** Se puede revisar un día sólo si la
  agregación diaria lo clasifica como `AUSENTE`
  ([15-paneles-y-dashboard](./15-paneles-y-dashboard.md)). No tiene sentido justificar un día
  presente, de descanso, no laborable o de vacaciones. **Validar en servidor.**
  > Implementado preguntándole a `computeDailyStatus`, no repitiendo la lista de estados
  > excluidos: esa función pone superposición de ausencia **sólo** en un día `AUSENTE` y ya
  > cerrado, así que "¿es revisable?" es "¿tiene superposición?". Se añade un caso que la regla
  > no nombra: **una jornada que todavía puede completarse tampoco se clasifica** — llamar ANJ a
  > alguien a media mañana sería clasificar una ausencia que aún no ha ocurrido.
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
  > La idempotencia la sostiene **la base**, no el código: un índice único parcial sobre
  > (`source_type`, `source_id`) `where status = 'active'` ([17](./17-nomina.md) RN-17.5). Las
  > operaciones escriben y miran si escribieron, que es lo único que gana la carrera de dos
  > revisiones simultáneas del mismo día — hay una prueba de eso.
- **RN-13.5 — Barrera de privilegios.** El jefe de departamento **no tiene ni debe tener
  acceso a la tabla de nómina**, pero su acción la escribe. En el legacy esto se resolvía con
  un trigger `SECURITY DEFINER`. En el monorepo: el efecto debe ejecutarse **en el servicio de
  dominio del backend, dentro de la misma transacción**, no exponiendo nómina al handler del
  jefe. Nunca en el cliente.
  > Implementado así, y la comprobación de la barrera es simple: **buscar "payroll" en
  > `routes/` no da nada**. `services/payroll.ts` sólo se llama desde el servicio de ausencias
  > y desde la revisión de incidencias, siempre con la transacción como primer argumento.
  >
  > Hay una consecuencia que la §7 no anticipó y que se resolvió aquí: esa misma barrera obliga
  > a que **el jefe no vea el importe** del descuento que acaba de causar, porque el importe es
  > el sueldo dividido por el divisor y enseñárselo le enseña el sueldo (hallazgo H-3,
  > [17](./17-nomina.md) RN-17.1). Ve el hecho —"se aplicó un descuento de un día de salario"—
  > y un rol administrativo ve además la cifra. La §7 pedía la confirmación económica explícita;
  > se cumple sin romper la barrera.
- **RN-13.6 — Notas.** Obligatorias al justificar (hace falta saber por qué se perdonó una
  ausencia); opcionales al marcar como injustificada.
  > **Confirmada tal como está escrita.** El legacy **no lo documenta** (`old-docs.md` punto 44
  > no menciona la obligatoriedad), así que no había nada contra lo que confirmar y manda el
  > texto de la spec. Es la asimetría **inversa** a las de las specs 11 y 12, donde el que exige
  > motivo es el rechazo, y el criterio es el mismo: se pide la razón de la decisión
  > **discrecional**. Allí lo discrecional era negar algo a una persona; aquí, perdonar un
  > descuento.
- **RN-13.7 — Notificación al empleado.** Debe saber que su ausencia se clasificó y si se le
  aplicó un descuento. ⚠️ **El legacy no lo hace** (punto 76): el empleado se entera en la
  boleta. Es un requisito nuevo razonable.
- **RN-13.8 — Auditoría.** Toda decisión se registra en [18-auditoria](./18-auditoria.md) con
  el valor anterior. ⚠️ En el legacy, los ajustes de nómina **no** llegaban a la bitácora
  (punto 76).
- **RN-13.9 — Plazo de revisión.** **Sigue abierta:** ¿se puede reclasificar una ausencia
  de un periodo de nómina ya cerrado? Si la nómina del mes ya se pagó, revertir el descuento
  necesita un tratamiento distinto (ajuste del mes siguiente).
  > No se puede cerrar aquí: depende del **cierre de periodo**, que es la decisión 2 de la
  > [17](./17-nomina.md) §7 y que nadie ha tomado. Lo que sí está construido es la mitad que no
  > dependía de ella: **`effective_period` se calcula desde la fecha de la ausencia**, no desde
  > la de la revisión (§7 de la 17), así que el día que se decida el cierre, los datos ya están
  > imputados al mes correcto. Hoy no hay plazo: se puede reclasificar cualquier día.
- **RN-13.10 — Sin decisión = injustificada por defecto en el reporte.** Un día ausente sin
  fila de revisión sale como **ANJ** en el reporte pero **no** genera descuento (el descuento
  requiere la decisión explícita).
  > **Confirmada.** Las dos mitades de la asimetría tienen el mismo motivo: el descuento mueve
  > dinero y exige que una persona lo decida; el reporte no debe **esconder** una ausencia que
  > nadie explicó — ocultarla hasta que alguien la revise haría que un mes sin revisar
  > pareciera un mes sin ausencias.
  >
  > Para que las dos cosas convivan, la superposición lleva un campo `reviewed`: "ANJ porque
  > alguien lo decidió" y "ANJ porque nadie la miró" se ven igual en el reporte y **no** son lo
  > mismo en la nómina. La interfaz aprovecha la distinción y pinta *«ANJ sin revisar»* en la
  > bandeja, para que "sin decisión" no se lea como neutro.

## 4. Relación con las incidencias

Ver [12-incidencias](./12-incidencias.md) §2. En el legacy los dos flujos estaban
desconectados: aprobar la incidencia "olvidé marcar" no justificaba el día, y el descuento se
aplicaba igual.

**La decisión compartida queda cerrada: no es automático, pero se puede hacer en el mismo
acto.** `POST /incidents/:id/review` acepta `justifyAbsence`, y la revisión de una incidencia
sobre un día ausente ofrece la casilla —marcada por defecto— dentro del mismo diálogo y la
misma transacción.

No es automático por dos razones, y la primera es dirimente:

1. **Cuatro de los cinco tipos de incidencia no implican una ausencia.** Una tardanza y una
   salida temprana son días *presentes*; un problema de GPS o de geocerca puede acabar con la
   persona marcando más tarde. "Aprobar justifica el día" sería correcto sólo para
   `forgot_to_mark` y silenciosamente equivocado en el resto. (Hay una prueba de esto: aprobar
   con `justifyAbsence` una tardanza no toca nada y la aprobación sigue adelante.)
2. **Aprobar y justificar no dicen lo mismo.** Aprobar es "te creo que intentaste marcar";
   justificar es "ese día no se te descuenta". Lo primero va sobre el registro, lo segundo mueve
   dinero, y encadenarlas haría que un jefe pagara un día sin haber decidido pagarlo.

Lo que **sí** era un defecto del legacy es que el jefe tuviera que acordarse de la segunda
acción y buscarla en otra pantalla. La respuesta es ofrecerla donde ya está mirando, no
ejecutarla sin que la pida.

## 5. Dónde se hace

En el legacy la justificación se hace desde dos pantallas distintas:

- **Panel de departamento** (jefe) — sobre la asistencia del día de su equipo.
- **Panel global** (gestor global) — sobre cualquier empleado.

Ambas escriben lo mismo. En el monorepo debe ser **un componente compartido** con el ámbito
como parámetro, no dos implementaciones.

> **Un solo componente, y el ámbito ni siquiera es un parámetro**: el servidor devuelve lo que
> gestiona quien pregunta (RN-03.2), así que `AbsenceReviewPanel` sirve igual al jefe y al
> gestor global sin recibir nada. Vive en `/team`, junto a las otras dos bandejas de decisión.

**Falta en el legacy y hace falta:** una vista de "ausencias pendientes de revisar" —
hoy sólo se ven navegando día por día. Propuesta: bandeja con las ausencias sin decisión del
ámbito del jefe, con badge en la navegación, igual que las incidencias.

> **Construida**, con su badge. Dos notas de implementación:
>
> - Resolver "qué días son ausencias sin decisión" obliga a **clasificar cada jornada de cada
>   miembro del ámbito**, así que va por lotes: una consulta de marcas, una de revisiones, una
>   de vacaciones y tres por departamento, en vez de las cinco o seis *por persona* que costaría
>   reutilizar el historial individual. La misma función sirve para la bandeja y para validar un
>   solo día en RN-13.1.
> - Por eso el rango está **acotado** —medio año como máximo, los últimos 30 días por defecto—:
>   sin límite, la consulta crecería con la antigüedad de la empresa.
>
> El badge de `/team` **suma** las incidencias por revisar y las ausencias sin clasificar: el
> badge de un ítem de menú responde "¿tengo algo que hacer ahí?", y abrir la página ya separa de
> qué se trata.

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/absences/pending?from=&to=&departmentId=` | department_head (ámbito) — días ausentes sin revisar |
| `GET` | `/absences/pending-count` | department_head — **añadido**, para el badge (RN-05.8) |
| `GET` | `/absences?userId=&from=&to=` | department_head (ámbito) |
| `PUT` | `/absences/:userId/:date` | department_head (ámbito) — `{ isJustified, notes }`, upsert |

La respuesta indica explícitamente **qué pasó con la nómina**
(`payrollAdjustment: { effect, amount, currency, effectivePeriod }`) para que la UI lo confirme
al jefe antes y después de la acción.

Dos diferencias con lo que decía esta tabla:

- **`scope=` no existe aquí**, al contrario que en incidencias y vacaciones: **no hay ningún
  endpoint de ámbito propio**, y el router entero exige al menos `department_head`. El empleado
  no inicia este flujo, así que no tiene nada que pedir; se entera por la notificación de
  RN-13.7 y por el código `AJ`/`ANJ` sobre el día en `GET /attendance/me`, que es donde ya mira
  su historial.
- **`effect` tiene un cuarto valor que la spec no listaba: `skipped_no_salary`.** Es el caso de
  [17](./17-nomina.md) RN-17.7 — sin sueldo configurado no se crea el ajuste—, y sin un valor
  propio se confundiría con `unchanged` y la advertencia que esa regla exige no tendría dónde
  apoyarse.

## 7. UI

- En la fila del empleado ausente: dos acciones claras, *Justificada* / *No justificada*,
  con campo de notas.
- **Confirmación explícita del impacto económico** antes de marcar como no justificada:
  "Se aplicará un descuento de S/ X a [nombre]". El legacy no lo advierte.
- Mostrar quién y cuándo tomó la decisión anterior si se está cambiando.

> Las tres están. La confirmación económica es un **segundo paso dentro del diálogo** y no un
> `confirm()` del navegador, porque lo que hay que leer antes de seguir es *qué* va a pasar; y
> dice **el hecho, no la cifra** cuando quien clasifica es un jefe (ver RN-13.5). El importe en
> pesos sólo aparece para un rol administrativo — y en la notificación al propio empleado, que
> es su sueldo y es el dato que necesita para reclamar.
>
> El botón *Justificada* está deshabilitado sin notas, por RN-13.6, en vez de dejar enviar y
> devolver un error.

## 8. Criterios de aceptación

- [x] Justificar un día que no está ausente devuelve error. *(Presente, no laborable y una
      jornada que aún puede completarse, los tres.)*
- [x] Marcar `no justificada` crea exactamente un ajuste de nómina con el monto correcto.
- [x] Reclasificar a `justificada` marca el ajuste como revertido, sin borrarlo.
- [x] Repetir la misma decisión dos veces no duplica ajustes. *(Y dos revisiones
      **simultáneas** tampoco.)*
- [x] Un `department_head` puede justificar pero recibe 403 en cualquier endpoint de nómina.
      *(Hoy responden **404**: la superficie de nómina no existe todavía. La prueba lo comprueba
      así y dice qué actualizar cuando la [17](./17-nomina.md) la construya. Lo que sí está
      cerrado es que el jefe no ve el importe.)*
- [x] La decisión aparece en la bitácora con el valor anterior. *(Y los ajustes también,
      RN-17.9, que en el legacy no llegaban.)*
- [x] El empleado recibe notificación de la clasificación.
- [ ] El día aparece como AJ o ANJ en el reporte mensual del periodo. *(El reporte es de la
      [16](./16-reporteria-mensual.md) y no existe. Lo que sí se comprueba es que el día sale
      `AJ`/`ANJ` en el historial propio, que consume la **misma** agregación diaria de la que
      saldrá el reporte.)*

## 9. Decisiones abiertas

1. ~~¿Aprobar una incidencia justifica el día automáticamente?~~ **Cerrada: no
   automáticamente, pero se puede en el mismo acto.** Ver §4.
2. **⚠️ Sigue abierta — ¿se puede reclasificar tras cerrar el periodo de nómina?** (RN-13.9)
   Depende del cierre de periodo, que es la decisión 2 de la [17](./17-nomina.md) §7 y que nadie
   ha tomado. Hoy no hay plazo. La mitad que no dependía de ella ya está: `effective_period` se
   calcula desde la fecha de la ausencia.
3. ~~¿Ausencia sin revisar cuenta como ANJ en el reporte sin generar descuento?~~
   **Cerrada: sí.** Ver RN-13.10, con el campo `reviewed` que hace que las dos cosas convivan.
4. ~~¿Notas obligatorias al justificar?~~ **Cerrada: sí, y opcionales al marcar
   injustificada.** Ver RN-13.6.
5. **⚠️ Sigue abierta — ¿tipos de justificación** (enfermedad, permiso, licencia) en vez de un
   booleano? Cambiaría el reporte, que hoy sólo distingue AJ/ANJ. Es una pregunta de negocio, no
   técnica, y el modelo puede crecer sin romperse: sería una columna nullable junto a
   `is_justified`, no un cambio de la decisión ni de la cadena de nómina.
