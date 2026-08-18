# 11 · Vacaciones

> **Origen:** `old-docs.md` §3.4, puntos 37, 38, 39, 40.
> **Estado en el sistema legacy:** ✅ implementado y completo
> (el documento `plan-implementacion-vacaciones.md` que lo daba por pendiente estaba desactualizado).
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Depende de:** [09-marcaje-asistencia](./09-marcaje-asistencia.md) (los días trabajados salen de ahí), [06-configuracion-global](./06-configuracion-global.md).

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
  entrada válido. **Confirmar** si cuentan los días de tardanza (sí), los justificados
  (¿?) y los de vacaciones (no).

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
| `reviewed_by` | uuid, nullable | |
| `reviewed_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

## 4. Reglas de negocio

- **RN-11.5 — Cálculo de `requested_days`.** ¿Se cuentan los días de descanso y no laborables
  dentro del rango? El legacy no lo aclara. **Decisión abierta** — cambia el saldo consumido
  y es una fuente clásica de reclamos.
- **RN-11.6 — Sin solapamiento.** No puede haber dos solicitudes `pending` o `approved` que
  se solapen en fechas para la misma persona.
- **RN-11.7 — Sólo a futuro.** `start_date` no puede ser anterior a hoy.
  **Confirmar** si el legacy lo impone; si no, hace falta para evitar regularizaciones
  encubiertas.
- **RN-11.8 — Aprobación.** Aprueba el `department_head` del ámbito de la persona, o un
  `global_manager`. Nadie aprueba su propia solicitud (ni un jefe la suya).
  **Decisión abierta:** ¿quién aprueba las vacaciones de un jefe de departamento?
- **RN-11.9 — Bloqueo del marcaje.** Con una solicitud `approved` que cubre la fecha, el
  marcaje se rechaza con `ON_VACATION` ([09](./09-marcaje-asistencia.md) RN-09.2).
- **RN-11.10 — Cancelación.** El solicitante puede cancelar mientras esté `pending`.
  Cancelar una ya `approved` **con fechas futuras**: permitido, devuelve saldo.
  Cancelar una en curso o pasada: sólo rol administrativo. **Confirmar contra el legacy.**
- **RN-11.11 — Las vacaciones no generan descuento de nómina.** Decisión de negocio
  **explícita**: son días pagados. Sólo se registra un ajuste si un administrador lo crea a
  mano ([17-nomina](./17-nomina.md) RN-17.6).
- **RN-11.12 — Estado en reportería.** El día clasifica como `VACACIONES`, superpuesto al
  estado que le hubiera correspondido ([15](./15-paneles-y-dashboard.md)).
- **RN-11.13 — Todas las mutaciones pasan por una operación de dominio transaccional.**
  En el legacy eran RPC (`request_vacation`, `cancel_vacation_request`,
  `review_vacation_request`) y nunca `insert`/`update` directo, porque el saldo debe
  recalcularse y validarse dentro de la misma transacción. **Mantener ese patrón**: en el
  monorepo, un servicio de dominio con transacción, no un CRUD genérico.

## 5. Flujos

### 5.1 Solicitar
1. El empleado ve su saldo (`earned`, `used`, `pending`, `available`).
2. Elige rango → el sistema calcula `requested_days` (RN-11.5).
3. Valida saldo (RN-11.1) y solapamiento (RN-11.6) **en servidor, en transacción**.
4. Queda `pending`. Notificación al jefe ([14](./14-notificaciones.md)).

### 5.2 Revisar
1. El jefe ve las pendientes de su ámbito con el saldo del solicitante y quién más está de
   vacaciones en esas fechas (**cobertura del equipo** — no lo tenía el legacy, pero es lo
   primero que un jefe necesita para decidir). **Propuesta.**
2. Aprueba o rechaza, con comentario opcional (obligatorio si rechaza).
3. Notificación al solicitante.

### 5.3 Cancelar
Según RN-11.10; devuelve saldo y notifica.

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/vacations/balance` | autenticado — saldo propio |
| `GET` | `/vacations/balance/:userId` | department_head (ámbito) |
| `GET` | `/vacations/requests?status=&scope=` | autenticado (propias) / department_head (ámbito) |
| `POST` | `/vacations/requests` | autenticado |
| `POST` | `/vacations/requests/:id/cancel` | solicitante o administrativo |
| `POST` | `/vacations/requests/:id/review` | department_head (ámbito) — `{ approved, comment }` |

## 7. UI

- **Empleado:** tarjeta de saldo (ganado / usado / pendiente / disponible), selector de
  rango con el consumo calculado en vivo, lista de sus solicitudes con estado.
- **Jefe:** bandeja de pendientes con badge en la navegación, saldo del solicitante y
  calendario del equipo en esas fechas.
- El rango debe mostrar **qué días se van a consumir** antes de enviar (RN-11.5).

## 8. Criterios de aceptación

- [ ] Solicitar más días de los disponibles falla antes de crearse la solicitud.
- [ ] Dos solicitudes solapadas: la segunda falla.
- [ ] Una solicitud pendiente reduce el disponible; al rechazarla, lo devuelve.
- [ ] Con vacaciones aprobadas vigentes, el marcaje devuelve `ON_VACATION`.
- [ ] Un día de vacaciones aparece como `VACACIONES` en el reporte mensual.
- [ ] Aprobar unas vacaciones **no** crea ningún ajuste de nómina.
- [ ] Dos solicitudes concurrentes del mismo usuario que juntas exceden el saldo: sólo una
      pasa (test de concurrencia sobre la transacción de RN-11.13).

## 9. Decisiones abiertas

1. **¿El modelo de acumulación debe cumplir la normativa laboral?** (§2) — la más importante.
2. ¿Los días no laborables y de descanso dentro del rango consumen saldo? (RN-11.5)
3. ¿Quién aprueba las vacaciones de un jefe de departamento? (RN-11.8)
4. ¿Se pueden solicitar medios días?
5. ¿Caducan los días acumulados?
