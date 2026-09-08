# 14 · Notificaciones

> **Origen:** `old-docs.md` §3.6, puntos 46, 47, 48, 49; hallazgo H-4; punto 76.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con lógica de negocio en el cliente.
> **Estado en el monorepo nuevo:** ✅ implementada. Nació como mínimo viable con la
> [01](./01-organizacion-departamentos.md) y creció spec a spec —**el catálogo de §4 está
> completo**: los doce eventos se emiten—; lo que faltaba era la entrega en vivo, el aviso
> emergente, la vista completa y la retención.
>
> **Entrega por dos caminos, y los dos hacen falta** (RN-14.4): flujo **SSE** en
> `GET /notifications/stream` y sondeo cada 30 s como respaldo. Aviso emergente al llegar una
> nueva (RN-14.5). Purga de leídas por `notification_retention_days`, default 0 = sin purga
> (RN-14.6). Código: `apps/backend/src/services/notifications.ts`,
> `apps/backend/src/lib/live.ts` (el registro de suscriptores y el ámbito por petición),
> `apps/frontend/src/modules/notifications/` y la vista completa en `/notifications`. Pruebas:
> 14 de integración en `apps/backend/src/routes/notifications.test.ts`, incluida la del flujo.
>
> **Lo que no hay:** preferencias por usuario (decisión 4) ni correo electrónico (decisión 5).
> Y las notificaciones del sistema de la §6 quedaron **fuera del alcance** con la retirada de la
> spec de la app móvil.
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
  > **Decisión 1 cerrada: SSE.** El tráfico va en un solo sentido —servidor → cliente—, así que
  > un WebSocket añadiría un canal de vuelta que nunca se usaría y una negociación de protocolo
  > que los intermediarios tratan aparte. `EventSource` reconecta solo, Hono trae `streamSSE` y
  > no hace falta ninguna dependencia nueva. **El sondeo se queda**, como la regla exige.
  >
  > Y dos decisiones de forma que la regla no pedía y que son las que hacen que esto funcione:
  >
  > - **Por el flujo viaja un aviso, no la notificación.** El servidor manda "algo tuyo cambió,
  >   con este contador" y el cliente vuelve a preguntar. Así el aislamiento de RN-14.1 se
  >   comprueba en **un** sitio —`GET /notifications`, que filtra por la sesión— en vez de en
  >   dos; no hay dos fuentes de verdad que reconciliar (el orden, lo leído, lo deduplicado); y
  >   un aviso perdido no se nota, porque el sondeo trae el estado completo de todas formas.
  > - **El aviso se publica cuando la transacción ya escribió, no cuando se llama a `notify()`.**
  >   Una notificación nace dentro de la transacción del hecho que la origina (RN-14.2): si el
  >   aviso saliera ahí, el cliente preguntaría **antes** del `COMMIT`, no vería nada nuevo y se
  >   quedaría con el contador viejo hasta el siguiente sondeo — treinta segundos de "no ha
  >   pasado nada" justo después de que pasara. Los destinatarios se acumulan en un
  >   `AsyncLocalStorage` y se publican al terminar el handler; si falla, no se publica nada. Es
  >   la misma maquinaria que el id de correlación de la [18](./18-auditoria.md) RN-18.8, y por
  >   el mismo motivo de fondo: que ningún servicio de dominio tenga que acordarse de nada.
- **RN-14.5 — Aviso emergente** al llegar una nueva mientras la app está abierta.
  > ✅ **Hecho**, y sólo **cuando el contador sube**. El mismo flujo despierta al marcar una como
  > leída desde otra pestaña, y un aviso emergente por algo que uno mismo acaba de leer es
  > exactamente el ruido que hace que la gente deje de mirar la campana. Se va solo a los ocho
  > segundos y se puede descartar; tocar *Ver* lleva al recurso **sin** marcarla leída: abrir una
  > cosa y dar el aviso por leído son dos actos distintos.
- **RN-14.6 — Retención.** **Decisión abierta:** ¿se purgan las leídas tras N días? Sin purga
  la tabla crece sin límite.
  > **Decisión 3 cerrada: `notification_retention_days` en configuración, default `0` = sin
  > purga** ([06](./06-configuracion-global.md) §3.7). El criterio de siempre: la cifra es del
  > negocio y el default deja la regla inerte.
  >
  > **Sólo alcanza a las leídas.** Una sin leer es trabajo pendiente de alguien, y borrarla
  > porque lleva mucho tiempo ahí es lo contrario de para qué existe; una leída ya cumplió su
  > función. La purga corre una vez al día en el proceso de fondo y **no deja entrada en la
  > bitácora**: es mantenimiento sobre datos derivados, no la decisión de nadie, y una fila
  > diaria de "purgué 12" sólo taparía las de la [18](./18-auditoria.md) §3.

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

## 6. ~~Notificaciones del sistema (móvil)~~ — fuera del alcance

> **Decisión 2 cerrada por alcance: no hay push.** La spec de la app móvil y su distribución se
> retiró, así que no hay runtime nativo al que pedirle permisos ni al que empujarle nada. La
> aplicación se usa desde el navegador, también en el teléfono.
>
> La consecuencia que esta sección advertía **sigue siendo verdad y conviene no perderla de
> vista**: sin push, un jefe no se entera de una solicitud hasta que abre la aplicación. Lo que
> el flujo SSE de RN-14.4 mejora es el caso de la pestaña abierta, que es el del turno de
> oficina; para el resto, la vía sería el correo electrónico (decisión 5, abierta).

## 7. API propuesta

| Método | Path |
|---|---|
| `GET` | `/notifications?unreadOnly=&limit=&cursor=` |
| `GET` | `/notifications/unread-count` |
| `POST` | `/notifications/:id/read` |
| `POST` | `/notifications/read-all` |
| `GET` | `/notifications/stream` (SSE, si se elige ese mecanismo) |

> ✅ **Los cinco existen**, con dos precisiones:
>
> - **`list` devuelve una página, no un array.** La §8 pide paginación, así que la respuesta es
>   `{ notifications, nextCursor }` y el cursor es **el mismo de la bitácora**
>   ([18](./18-auditoria.md) §6): las dos listas crecen por el extremo que se lee y se ordenan
>   igual. Podría haberse añadido un segundo endpoint paginado dejando el primero intacto, pero
>   serían dos formas de leer lo mismo — la campana se queda con la primera página y la vista
>   completa sigue pidiendo.
> - **`stream` no devuelve JSON**: es un `text/event-stream`. Late cada 25 s con un `ping` que
>   **no consulta la base** —con doscientas conexiones abiertas eso serían ocho consultas por
>   segundo para decir "sigo aquí"— y se da de baja del registro al cerrarse, o cada recarga de
>   pestaña dejaría un suscriptor muerto en memoria.
>
> Y lo que **no** existe, que también es contrato: ningún método de escritura sobre
> `/notifications` (RN-14.2). Hay una prueba que comprueba que `POST`, `PUT`, `PATCH` y `DELETE`
> devuelven 404.

## 8. UI

- **Campanilla** en la cabecera con contador de no leídas.
- Panel desplegable con las últimas y enlace a la vista completa.
- Vista completa con filtro leídas/no leídas y paginación.
- Cada notificación es accionable: toca → va al recurso.

> ✅ **Los cuatro.** La vista completa está en `/notifications`, **no en el aside** y **sin
> `RequireRole`**: se llega desde la campana —que ya está siempre visible— y no hay rol que
> comprobar porque no hay ámbito. Cada persona ve las suyas y sólo las suyas, y eso lo garantiza
> el servidor filtrando por la sesión; ni un `superadmin` puede pedir las de otro, así que no
> existe una versión "de más" de la pantalla que haya que esconder
> ([05](./05-shells-y-navegacion.md) §7).
>
> Una diferencia deliberada entre las dos superficies: **el panel de la campana sondea y la vista
> completa no.** Quien está revisando su historial no necesita que la lista se le mueva debajo
> del dedo, y el aviso en vivo ya le dice si llega algo nuevo.

## 9. Criterios de aceptación

- [x] Un usuario no puede leer ni marcar notificaciones de otro (test de autorización). *(Era el
      criterio más importante de esta spec y el único sin prueba. Comprobado en los tres
      caminos: el listado sólo trae las propias —**ni un `superadmin` ve las de otro**—, marcar
      una ajena devuelve el mismo 404 que una inexistente y la deja sin leer, y "marcar todas" no
      alcanza a las de nadie más.)*
- [x] Ningún endpoint permite a un cliente crear una notificación. *(Los cuatro métodos de
      escritura devuelven 404: no existen.)*
- [x] El recordatorio de descansos genera una sola notificación viva por semana y persona.
      (`dedupeKey` por persona; se retira en cuanto configura sus días. Hoy se evalúa **al
      iniciar sesión**, así que quien no entre en una semana no lo recibe: pasa a proceso
      programado cuando exista uno — [10](./10-descansos.md) §10.)
- [x] Con la entrega en vivo caída, el sondeo de respaldo sigue actualizando el contador.
      *(Comprobado en su forma más literal: **sin ninguna conexión abierta**, el contador refleja
      la notificación nueva. Es lo que hace que una entrega caída no se note más de treinta
      segundos.)*
- [x] Aprobar unas vacaciones notifica al solicitante en la misma transacción.
- [x] Un ajuste de nómina notifica al empleado afectado. *(Los de ausencia con
      `absence.reviewed` —es un solo hecho para quien lo recibe— y los manuales de la
      [17](./17-nomina.md) con su propio tipo, `payroll_adjustment.applied` / `.reverted`: no
      nacen de una clasificación. **Con el importe dentro**, que es lo que necesita para
      reclamar.)*

## 10. Decisiones abiertas

1. ~~Mecanismo de entrega en vivo.~~ **Cerrada: SSE**, con el sondeo de respaldo intacto. Ver
   RN-14.4.
2. ~~¿Push real (FCM) en Android?~~ **Cerrada por alcance: no.** No hay runtime nativo desde que
   se retiró la spec de la app móvil. Ver §6.
3. ~~Política de retención/purga.~~ **Cerrada: `notification_retention_days`, default 0**, y sólo
   sobre las leídas. Ver RN-14.6.
4. **⚠️ Sigue abierta — ¿preferencias por usuario (silenciar tipos)?** Hoy no existen, y el
   catálogo de §4 está completo: doce tipos, todos emitiéndose. Es la pregunta que aparece cuando
   alguien empieza a recibir avisos que no le sirven, y hasta entonces cualquier respuesta sería
   inventada. El modelo no se opone: sería una tabla de preferencias que `notify` consultara antes
   de escribir.
5. **⚠️ Sigue abierta — ¿correo electrónico para eventos críticos?** Y es la que más importa de
   las dos, porque **cubre el caso que el push habría cubierto**: sin app nativa y con la pestaña
   cerrada, un jefe no se entera de una solicitud hasta que abre la aplicación. Es una decisión
   con infraestructura detrás —hace falta un servidor de correo saliente, y la empresa opera en
   Cuba ([06](./06-configuracion-global.md) §8)— así que no la decide el código.
