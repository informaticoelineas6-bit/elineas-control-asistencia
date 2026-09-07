# 14 · Notificaciones

> **Origen:** `old-docs.md` §3.6, puntos 46, 47, 48, 49; hallazgo H-4; punto 76.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con lógica de negocio en el cliente.
> **Estado en el monorepo nuevo:** ⚠️ parcial (mínimo viable, adelantado por la
> [01](./01-organizacion-departamentos.md)). Existen la tabla `notifications` con su índice de
> deduplicación, la generación **en el servidor y en la transacción del hecho** (RN-14.1/14.2),
> los cuatro endpoints de lectura y marcado de §7, y la campana con panel en la cabecera.
> **Entrega por sondeo cada 30 s** (RN-14.4); no hay entrega en vivo ni aviso emergente
> (RN-14.5). Del catálogo de §4 se emiten: pausa y reanudación de departamento, aparición de un
> perfil incompleto (RN-02.12), cierre del alta al asignar departamento, **cambio de horario del
> departamento** (RN-07.10, con `dedupe_key` por departamento) y **sede de trabajo desactivada**
> (spec 08 RN-08.6). Código:
> `apps/backend/src/services/notifications.ts`, `apps/frontend/src/modules/notifications/`.
> **Depende de:** [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md), [05-shells-y-navegacion](./05-shells-y-navegacion.md).

---

## 1. Objetivo

Avisar en la aplicación (y en el móvil, por notificación del sistema) de los hechos que
requieren atención: una solicitud por revisar, una decisión tomada sobre algo tuyo, un cambio
de horario, un recordatorio pendiente.

## 2. Modelo de datos

### `notifications`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | Destinatario. Aislamiento estricto por usuario |
| `type` | text/enum | Ver catálogo §4 |
| `title` | text | |
| `body` | text | |
| `action_url` | text, nullable | A dónde lleva al tocarla |
| `read_at` | timestamptz, nullable | `null` = no leída |
| `dedupe_key` | text, nullable | **Propuesta**: para las que se actualizan en vez de duplicarse (§5) |
| `created_at` | timestamptz | |

**Índice:** (`user_id`, `read_at`), (`user_id`, `created_at desc`).

## 3. Reglas de negocio

- **RN-14.1 — Aislamiento.** Un usuario sólo lee y modifica sus notificaciones. Ni siquiera un
  `global_manager` ve las de otro.
- **RN-14.2 — Sólo el servidor las crea.** Ningún cliente inserta notificaciones. Se generan
  como efecto de las operaciones de dominio, en la misma transacción que el hecho que las
  origina (o en un evento posterior fiable).
- **RN-14.3 — Marcar leída** es la única mutación que hace el usuario. También "marcar todas".
- **RN-14.4 — Entrega en vivo.** El legacy usaba tiempo real de Supabase + **sondeo cada 30 s
  como respaldo**. En el monorepo hay que elegir mecanismo (SSE, WebSocket o sondeo).
  **Mantener siempre un respaldo por sondeo**: la entrega en vivo falla en móviles con la
  pantalla apagada y en redes de planta.
- **RN-14.5 — Aviso emergente** al llegar una nueva mientras la app está abierta.
- **RN-14.6 — Retención.** **Decisión abierta:** ¿se purgan las leídas tras N días? Sin purga
  la tabla crece sin límite.

## 4. Catálogo de eventos

| Evento | Destinatario | Origen |
|---|---|---|
| Nueva solicitud de vacaciones | Jefe(s) del ámbito | [11](./11-vacaciones.md) — ✅ `vacation.requested`, con la limitación de §10 de esa spec: sólo llega a los jefes con responsabilidad **adicional** |
| Vacaciones aprobadas / rechazadas | Solicitante | [11](./11-vacaciones.md) — ✅ `vacation.reviewed` |
| Vacaciones canceladas por otro | Solicitante | [11](./11-vacaciones.md) RN-11.10 — ✅ `vacation.cancelled`, sólo si no las canceló él mismo |
| Nueva incidencia reportada | Jefe(s) del ámbito | [12](./12-incidencias.md) |
| Incidencia aprobada / rechazada | Empleado | [12](./12-incidencias.md) |
| Cambio de horario del departamento | Todos los miembros | [07](./07-horarios-y-calendario.md) RN-07.10 ✅ |
| Recordatorio de configurar descansos | Empleado / jefe | [10](./10-descansos.md) §5 — ✅ `rest_schedule.missing`, evaluado al iniciar sesión |
| Ausencia clasificada (AJ/ANJ) | Empleado | [13](./13-justificacion-ausencias.md) RN-13.7 ⚠️ *nuevo* |
| Ajuste de nómina aplicado o revertido | Empleado | [17](./17-nomina.md) ⚠️ *nuevo, punto 76* |
| Reporte mensual listo | Quien lo solicitó | [16](./16-reporteria-mensual.md) |
| Departamento pausado / reanudado | Miembros | [01](./01-organizacion-departamentos.md) *propuesta* ✅ |
| Sede de trabajo desactivada | Quien la tenía elegida | [08](./08-sedes-y-geocerca.md) RN-08.6 ✅ *nuevo* |

Los marcados ⚠️ **no existen en el legacy** y cubren huecos reales: hoy al empleado le
descuentan sin avisarle.

## 5. Notificaciones que se actualizan en vez de duplicarse

El recordatorio de descansos es el caso claro: si la persona sigue sin configurarlos, no
deben acumularse siete avisos. Se usa `dedupe_key` (p. ej. `rest-reminder:2026-W32`) y se
hace upsert.

> ⚠️ **Hallazgo H-4:** en el legacy esta lógica (`syncRestScheduleReminder`) vivía **dentro
> del contexto de notificaciones del frontend**. Consecuencias: sólo se ejecutaba si el
> usuario abría la app, y la regla no aparecía al buscarla en la capa de dominio.
> **En el sistema nuevo esta y cualquier otra regla de generación vive en el servidor.**

## 6. Notificaciones del sistema (móvil)

- Permisos solicitados en el primer render autenticado en runtime nativo, no al arrancar.
- Si el usuario los niega, la aplicación sigue funcionando con las notificaciones in-app.
- **Decisión abierta:** ¿se implementan notificaciones push reales (FCM) o sólo locales?
  El legacy sólo pide permisos; no hay evidencia de un servicio push. Sin push, un jefe no se
  entera de una solicitud hasta que abre la app.

## 7. API propuesta

| Método | Path |
|---|---|
| `GET` | `/notifications?unreadOnly=&limit=&cursor=` |
| `GET` | `/notifications/unread-count` |
| `POST` | `/notifications/:id/read` |
| `POST` | `/notifications/read-all` |
| `GET` | `/notifications/stream` (SSE, si se elige ese mecanismo) |

## 8. UI

- **Campanilla** en la cabecera con contador de no leídas.
- Panel desplegable con las últimas y enlace a la vista completa.
- Vista completa con filtro leídas/no leídas y paginación.
- Cada notificación es accionable: toca → va al recurso.

## 9. Criterios de aceptación

- [ ] Un usuario no puede leer ni marcar notificaciones de otro (test de autorización).
- [ ] Ningún endpoint permite a un cliente crear una notificación.
- [x] El recordatorio de descansos genera una sola notificación viva por semana y persona.
      (`dedupeKey` por persona; se retira en cuanto configura sus días. Hoy se evalúa **al
      iniciar sesión**, así que quien no entre en una semana no lo recibe: pasa a proceso
      programado cuando exista uno — [10](./10-descansos.md) §10.)
- [ ] Con la entrega en vivo caída, el sondeo de respaldo sigue actualizando el contador.
- [x] Aprobar unas vacaciones notifica al solicitante en la misma transacción.
- [ ] Un ajuste de nómina notifica al empleado afectado.

## 10. Decisiones abiertas

1. Mecanismo de entrega en vivo: SSE vs. WebSocket vs. sólo sondeo.
2. ¿Push real (FCM) en Android? (§6)
3. Política de retención/purga. (RN-14.6)
4. ¿Preferencias por usuario (silenciar tipos)? Hoy no existen.
5. ¿Correo electrónico para eventos críticos, o sólo in-app?
