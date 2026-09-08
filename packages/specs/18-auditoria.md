# 18 · Bitácora de auditoría

> **Origen:** `old-docs.md` §3.6, punto 16; punto 76 (hueco de nómina).
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con cobertura parcial.
> **Estado en el monorepo nuevo:** ✅ implementada, **menos la política de retención**
> (decisión 3, que es de negocio). La escritura se adelantó con la
> [01](./01-organizacion-departamentos.md) y creció spec a spec; la lectura llegó al final, que
> es el orden natural: no se construye una pantalla para mirar una tabla vacía.
>
> Escritura: tabla `audit_log` con sus tres índices, la función única `audit(tx, entry)` dentro
> de la transacción de la acción auditada (RN-18.3/18.4) y el catálogo cerrado de **39 acciones**
> (`packages/validations/src/audit.ts`), todas emitidas de verdad — hay una prueba que lo
> comprueba. Correlación (RN-18.8) en `apps/backend/src/lib/correlation.ts`. Lectura:
> `apps/backend/src/services/audit-log.ts` y `routes/audit.ts` (`GET /audit` y
> `GET /audit/resource/:tableName/:id`, sólo `superadmin`). Interfaz: `/logs`
> (`apps/frontend/src/modules/audit/`), con la diferencia campo a campo de la §7. Pruebas: las
> puras en `services/audit-rules.test.ts` y las de integración en `routes/audit.test.ts`.
>
> **Lo que queda:** la retención (RN-18.7) y **cerrar la cobertura de pruebas por acción** — 23
> de las 39 se comprueban hoy en el archivo de pruebas de su dominio; las otras 16 se escriben
> pero nadie lo verifica (ver §8).
> **Depende de:** [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).

---

## 1. Objetivo

Dejar rastro de **quién hizo qué, cuándo y sobre qué**, para las acciones que afectan a
personas, dinero o configuración. Es lo que permite responder "¿por qué a este empleado le
descontaron en marzo?" seis meses después.

## 2. Modelo de datos

### `audit_log`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `actor_id` | uuid, nullable | Quién actuó (`null` si fue el sistema) |
| `action` | text | Verbo canónico, ver §3 |
| `table_name` | text | Recurso afectado |
| `record_id` | uuid/text, nullable | Identificador del registro |
| `old_data` | jsonb, nullable | Estado anterior |
| `new_data` | jsonb, nullable | Estado nuevo |
| `source_ip` | inet/text, nullable | |
| `metadata` | jsonb, nullable | Contexto adicional (motivo, user-agent, id de correlación) |
| `created_at` | timestamptz | |

**Índices:** (`created_at desc`), (`table_name`, `record_id`), (`actor_id`, `created_at desc`).

## 3. Qué se audita

Mínimo obligatorio:

| Dominio | Acciones |
|---|---|
| Usuarios | alta, cambio de rol, cambio de departamento, desactivación, reactivación, reseteo de contraseña, borrado |
| Nómina ⚠️ | creación y reversión de ajustes, cambio de `monthly_salary` — **hueco del legacy, punto 76** |
| Justificación de ausencias | toda decisión, con el valor anterior |
| Configuración global | todo cambio de clave, con valor anterior y nuevo |
| Departamentos | creación, renombrado, pausa/reanudación, eliminación |
| Horarios y calendario | cambios de ventana y de días laborables |
| Sedes | alta, cambio de coordenadas o radio, desactivación |
| Superadmin | ejecución de consultas SQL, importación de histórico, publicación de versión de la app, activación del modo mantenimiento |
| Marcajes | sólo borrados/correcciones administrativas (los marcajes normales **no** se auditan: ya son el registro) |

> ✅ **Las 39 acciones del catálogo se emiten**, y hay una prueba estática que lo comprueba:
> recorre `services/` y `routes/` y falla si alguna está declarada y sin usar. Es el otro lado
> del enum — éste obliga a pasar por el catálogo para **escribir**; aquélla impide que el
> catálogo prometa un rastro que nadie está dejando. Las dos juntas son lo que el legacy no
> tenía (§5).

- **RN-18.1 — Lo que no se audita.** Lecturas y navegación no se registran. El volumen mataría
  la utilidad de la bitácora.
- **RN-18.2 — Datos sensibles.** `old_data`/`new_data` no deben incluir contraseñas ni tokens.
  El salario **sí** se registra (es el punto de la auditoría) pero la bitácora completa sólo la
  ve `superadmin` (RN-18.5).

## 4. Reglas de negocio

- **RN-18.3 — Escritura desde el servidor.** Ningún cliente escribe en la bitácora. Se genera
  en la capa de dominio del backend.
- **RN-18.4 — Misma transacción.** La entrada se escribe en la transacción de la acción
  auditada: si la acción se revierte, su rastro también. Si la escritura de bitácora falla,
  **la acción falla** — para las acciones de §3. *(Decidir si esto aplica a todas o sólo a
  nómina y usuarios.)*
  > **Decisión 2 cerrada: a todas, y no hizo falta decidirlo — ya era así.** `audit()` recibe la
  > transacción y escribe dentro; un fallo la aborta. Hacer la excepción costaría más que
  > mantenerla: habría que capturar el error, decidir qué dominios son "críticos" y mantener esa
  > lista. Y el caso que la duda imaginaba —perder una acción buena por un fallo de bitácora— es
  > un `insert` sin condiciones en la misma transacción que ya está escribiendo: si eso falla, la
  > acción no iba a completarse de todas formas.
- **RN-18.5 — Lectura.** La bitácora completa es exclusiva de `superadmin`
  ([19-panel-superadmin](./19-panel-superadmin.md)). **Decisión abierta:** ¿un
  `global_manager` debería ver la de su ámbito (usuarios, nómina)?
  > **Decisión 1 cerrada: no, y no por prudencia — porque no se puede calcular.** Una entrada de
  > bitácora no tiene departamento: tiene actor, tabla y registro. "Lo de mi ámbito" exigiría
  > etiquetar cada fila con un departamento al escribirla, decidir cuál le toca a un cambio de
  > configuración global —ninguno— y rellenar hacia atrás las que ya existen. Y media utilidad de
  > la bitácora es justamente cruzar dominios.
  >
  > Lo que un gestor necesita de verdad ya lo tiene en su propia pantalla, con el nombre y la
  > fecha dentro del propio registro: quién revisó una ausencia está en la revisión, quién creó
  > un ajuste está en el ajuste, y quién cambió un sueldo, en la compensación. La bitácora no era
  > la respuesta a esa pregunta, sólo la más cómoda de escribir.
- **RN-18.6 — Inmutable.** No hay actualización ni borrado de entradas por la aplicación.
- **RN-18.7 — Retención.** **Decisión abierta:** ¿cuánto se conserva? Una bitácora de nómina
  probablemente deba conservarse años. Propuesta: sin purga automática; archivado manual si
  crece.
  > ⚠️ **Sigue abierta, y es la única de esta spec.** Hoy no hay purga —que es la propuesta— y
  > por tanto tampoco hay nada que deshacer cuando se decida. Lo que sí quedó preparado para
  > cuando toque: el índice por `created_at desc` y la paginación por *keyset*, que hacen que
  > recorrer o recortar por fecha no dependa del tamaño de la tabla.
- **RN-18.8 — Correlación.** Una acción que dispara efectos en cascada (justificar una
  ausencia → ajuste de nómina → notificación) debe compartir un identificador de correlación
  en `metadata`, para poder leer la cadena completa.
  > ✅ **Hecho, y sin tocar un solo servicio de dominio.** Lo difícil de esta regla no es generar
  > el identificador: es **hacerlo llegar** a las tres escrituras. Pasarlo como argumento sería
  > repetir el error que la §5 diagnostica en el legacy —cada llamada nueva tendría que acordarse
  > de propagarlo, y la que se olvidara rompería la cadena sin fallar ni avisar—, así que vive en
  > un `AsyncLocalStorage` (`lib/correlation.ts`): un middleware abre un ámbito por petición y
  > `audit()` lo lee sola. Los procesos de fondo de la [16](./16-reporteria-mensual.md) abren el
  > suyo en cada vuelta, así que las entradas de una corrida comparten identificador y las de dos
  > corridas no se confunden.
  >
  > Y **la cadena se puede leer**, que es lo que la regla pide de verdad: `GET /audit` acepta
  > `correlationId`, y el detalle de una entrada ofrece "ver la cadena completa". Guardar el
  > identificador sin poder consultarlo habría cumplido la letra de la regla y ninguna de sus
  > consecuencias.

## 5. Implementación propuesta

En el legacy la bitácora se escribía **desde los puntos de uso** (gestión de usuarios,
principalmente), lo que explica su cobertura parcial: lo que nadie recordó instrumentar, no
se auditó.

**Propuesta para el monorepo:** una función única `audit(ctx, { action, resource, before,
after, metadata })` invocada dentro de los servicios de dominio, más un test por cada acción
de §3 que verifique que la entrada se escribe. Instrumentar por convención, no por memoria.

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/audit?actor=&table=&recordId=&from=&to=&cursor=` | superadmin |
| `GET` | `/audit/resource/:table/:id` | superadmin — historial de un registro concreto |

> ✅ **Construidos, y sólo estos dos.** Que no haya `POST` ni `DELETE` es RN-18.6, no un hueco:
> el router no importa nada que escriba y el servicio de lectura sólo tiene `select`. Una prueba
> comprueba que los cuatro métodos de escritura devuelven 404.
>
> Tres cosas que la tabla no decía y que hubo que decidir:
>
> - **Dos filtros más:** `domain` —todas las acciones de un dominio, que es como se busca de
>   verdad: "algo de nómina", no una acción concreta— y `correlationId`, sin el cual RN-18.8
>   guardaría un identificador que nadie puede consultar.
> - **El cursor va por *keyset*, no por `offset`,** y lleva el instante **y** el id de la última
>   entrada leída. Por `offset`, una entrada nueva durante la lectura desplaza la página
>   siguiente y repite una fila — y esta tabla crece justo por el extremo que se está leyendo.
>   El id hace falta porque dos entradas de la misma cascada comparten milisegundo más veces de
>   lo que parece: van en la misma transacción.
> - **El rango de fechas se resuelve en PostgreSQL con la zona configurada** (RN-06.6), no
>   comparando cadenas: decide si una acción de las 21:00 en La Habana cae en el día que se está
>   mirando o en el siguiente. Es el error que una prueba encontró en `periodRange` de la
>   [16](./16-reporteria-mensual.md).

## 7. UI

Dentro del panel de superadmin ([19](./19-panel-superadmin.md)):

- Tabla paginada, orden descendente por fecha.
- Filtros por actor, acción, recurso y rango de fechas.
- Vista de detalle con **diferencia visual** entre `old_data` y `new_data` — leer dos bloques
  de JSON crudo no sirve.
- Acceso desde cada recurso a "ver su historial".

> ✅ **Construida en `/logs`**, que ya existía como marcador de `superadmin`, y **no dentro del
> panel de la [19](./19-panel-superadmin.md)**: esa spec no está construida y hacer depender esta
> pantalla de ella habría dejado la bitácora sin leer un mes más. Cuando la 19 llegue, la absorbe
> como pestaña o enlaza aquí; no hay nada que rehacer.
>
> La diferencia campo a campo la calcula `auditDiff`, en `@elineas/validations` y con sus pruebas
> puras: es una función con casos de borde —el alta sin estado anterior, la baja sin estado
> nuevo, la lista que hay que comparar por su forma serializada— y ponerla en el componente
> habría dejado esos casos sin comprobar.
>
> Dos filtros **no tienen control propio** y se llegan desde el detalle de una entrada, porque
> nadie teclea un uuid a mano: el del registro ("¿qué más le ha pasado a esto?") y el de la
> cadena ("¿qué más pasó en esta misma acción?", RN-18.8). Aparecen como una etiqueta que se
> quita.
>
> Y una distinción que la pantalla hace explícita porque en la base son la misma columna vacía:
> **actor nulo sin id es "el sistema"; actor nulo con id es "perfil eliminado"**. La bitácora
> sobrevive a quien la generó —no hay clave ajena a `profiles`, y es deliberado (RN-18.6)—, así
> que borrar a alguien no borra su rastro. Hay una prueba de eso.

## 8. Criterios de aceptación

- [ ] Cada acción listada en §3 tiene un test que verifica que se registra. ⚠️ **23 de las 39.**
      Lo que sí está cerrado es que ninguna se escribe fuera del catálogo (el enum) y que ninguna
      del catálogo se queda sin emitir (prueba estática, §3). Lo que falta es la aserción por
      acción en el archivo de pruebas de su dominio: `department.created`, `department.renamed`,
      `profile.updated`, `profile.deactivated`, `profile.reactivated`, los cuatro de
      `rest_group.*`, `work_location.created`, `work_location.reactivated`,
      `vacation.cancelled`, los tres de `report_run.*` y `attendance_facts.refreshed`. Todas se
      ejecutan en las pruebas que ya existen; nadie comprueba todavía que dejen su fila.
- [x] Un ajuste de nómina y un cambio de sueldo aparecen en la bitácora (hueco cerrado).
      *(`payroll_adjustment.created` / `.reverted` —automáticos y manuales, creación y
      reversión— y `compensation.updated` con el importe anterior y el nuevo. Era el punto 76,
      el hueco que esta spec nombra en su origen.)*
- [x] Las entradas registran el estado anterior, no sólo el nuevo. *(Comprobado con dos cambios
      seguidos de la misma clave de configuración: la segunda entrada trae el valor de la
      primera.)*
- [x] Ningún endpoint permite modificar ni borrar entradas. *(Los cuatro métodos de escritura
      devuelven 404: no existen.)*
- [x] Un `global_manager` recibe 403 al consultar la bitácora completa. *(Y un jefe y un
      empleado también; sin sesión, 401.)*
- [x] Una acción en cascada comparte identificador de correlación entre sus entradas.
      *(Comprobado con la cascada que RN-18.8 nombra —clasificar una ausencia escribe la revisión
      y el ajuste de nómina—, y comprobado además que **dos peticiones distintas no lo
      comparten**, que es la mitad que hace útil al identificador.)*
- [x] Ninguna entrada contiene credenciales. *(La prueba recorre `old_data`, `new_data` y
      `metadata` de la página entera buscando `password`, `token`, `secret`, `cookie` y
      `authorization`. Es una red, no una demostración: lo que la sostiene es que ningún servicio
      pasa esos campos.)*

## 9. Decisiones abiertas

1. ~~¿`global_manager` puede leer parte de la bitácora?~~ **Cerrada: no.** No es una entrada con
   departamento, así que "su ámbito" no se puede calcular sin cambiar el modelo. Ver RN-18.5.
2. ~~¿El fallo de escritura de bitácora aborta la acción siempre o sólo en dominios críticos?~~
   **Cerrada: siempre**, y ya lo era. Ver RN-18.4.
3. **⚠️ Sigue abierta — política de retención.** (RN-18.7) Es la única de esta spec, y es de
   negocio con un componente legal: una bitácora de nómina probablemente deba conservarse años.
   Hoy no hay purga, que es la propuesta, así que decidir más tarde no obliga a deshacer nada.
4. ~~¿Se registra la IP de origen?~~ **Cerrada: sí, y ya se registraba.** `source_ip` se rellena
   con `clientIp()` —el primer salto de `x-forwarded-for`, o nulo si no hay forma de saberlo— y
   sólo la ve un `superadmin` (RN-18.5). El tratamiento de dato personal que la pregunta señalaba
   se reduce a eso: un campo de contexto, en una tabla que no sale de la empresa y que una sola
   persona puede leer.

Y una que la implementación cerró sin estar en esta lista:

- **El verbo se lee como texto, no como el enum del catálogo.** La columna es `text`, el catálogo
  es el contrato de **escritura**, y una fila escrita por una versión anterior sigue ahí después
  de revertirla (RN-18.6). Validarla contra el enum al leer obligaría a esconder esa fila o a
  tumbar la página entera, y una bitácora que esconde una fila porque su verbo ya no está en el
  catálogo deja de ser una bitácora. La interfaz rotula con `auditActionLabel`, que cae al valor
  crudo.
