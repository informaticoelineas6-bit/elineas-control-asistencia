# Specs — Control de Asistencia ELINEAS

Especificaciones funcionales del sistema, una por funcionalidad. Salen de trocear
[`../old-docs.md`](../docs/old-docs.md) — el mapa del sistema legacy (React + Vite + Supabase) —
en unidades que se puedan leer, corregir y construir por separado sobre el monorepo nuevo
(Hono + Drizzle + TanStack Start).

> **`old-docs.md` es la fuente histórica, no la referencia de trabajo.** Estas specs la
> reemplazan. Cuando una spec y el documento viejo digan cosas distintas, manda la spec.

## Qué es cada spec

No son documentación de lo que hay: son **el contrato de lo que debe existir**. Cada una
describe una funcionalidad completa — datos, reglas, permisos, API, UI y criterios de
aceptación — de forma que pueda implementarse sin volver al legacy.

Cada archivo sigue la misma estructura:

| Sección | Para qué |
|---|---|
| Cabecera | Origen en `old-docs.md`, estado en legacy y en el monorepo, de qué depende y qué habilita |
| Objetivo | Qué problema resuelve, en una o dos frases |
| Modelo de datos | Tablas y campos, con notas de diseño |
| Reglas de negocio | Numeradas `RN-<nn>.<n>` para poder citarlas en código y en PRs |
| Flujos | Los recorridos que importan |
| API propuesta | Endpoints con su rol mínimo |
| UI | Pantallas y comportamiento |
| Criterios de aceptación | Casilla por casilla, lo que hay que poder demostrar |
| Decisiones abiertas | Lo que **hay que decidir antes de implementar** |

Convenciones de lectura:

- ✅ implementado en el legacy · ⚠️ implementado con deuda conocida · ❌ no existe.
- **Propuesta** marca lo que no venía del legacy y se añade por criterio.
- ⚠️ dentro del texto marca una trampa heredada que no debe repetirse.
- Las **decisiones abiertas** son deliberadas: donde el legacy no dejaba claro el
  comportamiento, la spec pregunta en vez de inventar.

## Índice

### Spec cero — leerla antes que ninguna otra

| # | Spec | Contenido |
|---|---|---|
| 00 | [Fundación: base de datos propia e identidad federada](./00-migracion-datos-e-identidad.md) | La base sale de Supabase al contenedor de PostgreSQL; usuarios, roles, autenticación y autorización pasan al **Identity Server de Elineas**; y la UX del corte |

Fija dos decisiones que ya no se discuten y que reescriben partes de las specs 02, 03, 04 y 21.

### Cimientos — nada funciona sin esto

Los cimientos están construidos. La columna **monorepo** es lo que hay hoy en el código, no lo
que la spec pide; cada cabecera detalla qué falta y por qué.

| # | Spec | Legacy | Monorepo | Depende de |
|---|---|---|---|---|
| 01 | [Organización: departamentos](./01-organizacion-departamentos.md) | ✅ | ✅ | — |
| 02 | [Usuarios y perfiles](./02-usuarios-y-perfiles.md) | ✅ | ✅ | 01 |
| 03 | [Roles y autorización](./03-roles-y-autorizacion.md) | ✅ | ✅ | 02 |
| 04 | [Autenticación y sesión](./04-autenticacion.md) | ✅ | ✅ | 02, 03 |
| 05 | [Shells de interfaz y navegación](./05-shells-y-navegacion.md) | ✅ | ✅ | 03, 04 |
| 06 | [Configuración global](./06-configuracion-global.md) | ✅ | ✅ | 03 |

**Los cimientos están cerrados.** El último hueco era el **EmployeeShell** de la
[05](./05-shells-y-navegacion.md) §3, y se construyó al final a propósito: la regla de resolución
de shell no tenía entre qué elegir mientras ese shell no existiera, y el shell no tenía qué
enseñar mientras sus cuatro destinos fueran marcadores. Cuando llegó, tres de los cuatro ya
estaban hechos —`/clock-in`, `/incidents` y `/profile`— y el cuarto, *Mi semana*, **reutiliza los
datos de la [09](./09-marcaje-asistencia.md) pero no su diseño**: un calendario de seis semanas y
una tabla de cinco columnas en 375 px es justo lo que ese shell existe para evitar.

Y con la spec móvil retirada, este shell **dejó de ser un lujo**: es la única interfaz que un
operario va a ver, en el navegador de su teléfono.

### Reglas de trabajo — el marco que hace válido un marcaje

| # | Spec | Legacy | Monorepo | Depende de |
|---|---|---|---|---|
| 07 | [Horarios y calendario laboral](./07-horarios-y-calendario.md) | ✅ | ✅ | 01, 06 |
| 08 | [Sedes, geocerca y geolocalización](./08-sedes-y-geocerca.md) | ⚠️ | ✅ | 03, 06 |
| 10 | [Descansos](./10-descansos.md) | ✅ | ✅ | 01, 06 |

Las specs [07](./07-horarios-y-calendario.md) y [08](./08-sedes-y-geocerca.md) dejaron construidas
**las dos mitades de la validación de un marcaje** —`validateMarkTime` (¿toca marcar ahora?) y
`validateMarkLocation` (¿desde aquí?)—, más los dos componentes que reutilizan las specs 09, 10 y
11: el **calendario** y el **mapa**. La [09](./09-marcaje-asistencia.md) las compone, y por eso su
núcleo de reglas cabe en unas decenas de líneas en vez de en las seiscientas del hook del legacy.

Este bloque está **completo**. La [10](./10-descansos.md) añadió la tercera pieza reutilizable
—`resolveRestDays`, una sola implementación para el marcaje, la agregación diaria y la
reportería— y cerró sus cuatro decisiones abiertas, incluida la convención de `days_of_week`
(0 = domingo, la de `getDay()` y `extract(dow)`) que la 07 había dejado a propósito sin elegir
recibiendo los descansos por predicado.

### Núcleo

| # | Spec | Legacy | Monorepo | Depende de |
|---|---|---|---|---|
| 09 | [Marcaje de asistencia](./09-marcaje-asistencia.md) | ✅ | ✅ | 07, 08, 10, 11 |

Construida **antes** que las specs 10 y 11, de las que depende, dejando en su lugar dos costuras
probadas: los descansos entran por un predicado y las vacaciones por una bandera. Es el orden que
el índice ya sugería (09 antes de 11) y evita tener el núcleo del producto esperando por dos
specs que no cambian su forma. La apuesta salió: **conectar la [10](./10-descansos.md) y la
[11](./11-vacaciones.md) fue pasar dos argumentos**, sin tocar una línea de las reglas del
marcaje. Ya no queda ninguna costura abierta en el núcleo.

### Excepciones — lo que pasa cuando no se marca

| # | Spec | Legacy | Monorepo | Depende de |
|---|---|---|---|---|
| 11 | [Vacaciones](./11-vacaciones.md) | ✅ | ✅ | 06, 09 |
| 12 | [Incidencias](./12-incidencias.md) | ✅ | ✅ | 03, 09 |
| 13 | [Justificación de ausencias](./13-justificacion-ausencias.md) | ✅ | ✅ | 03, 09 |

La [11](./11-vacaciones.md) cerró **la última costura del núcleo**: la 09 ya no espera por nadie.
Dejó tres decisiones cerradas y **dos abiertas a propósito** — el modelo de acumulación frente a
la normativa cubana (de negocio) y quién aprueba las vacaciones de un jefe, que hoy no se puede
resolver porque el sistema no conoce el rol de un perfil ajeno sin que esa persona se autentique
([11](./11-vacaciones.md) §9, decisión 3). Es el primer sitio donde el corte de la
[00](./00-migracion-datos-e-identidad.md) —los roles viven en el Identity Server— se nota como
una limitación concreta.

La [12](./12-incidencias.md) **usa por fin la materia prima que la 09 venía guardando**: los
intentos de marcaje rechazados, con su motivo tipado y su distancia recalculada, se ofrecen en
el formulario y la incidencia se abre enlazada a uno (RN-12.2), así que el revisor la ve con la
fila delante en vez de con un relato. Cerró tres de sus cuatro decisiones abiertas y dejó la
cuarta —la más importante— esperando por la [13](./13-justificacion-ausencias.md), que la cerró
a continuación. Y trajo dos piezas
que se estrenan aquí y sirven a lo que viene: el **badge de pendientes** del aside
([05](./05-shells-y-navegacion.md) RN-05.8, declarativo — añadir el de vacaciones por aprobar es
una línea) y `additionalHeadsOf` en `services/responsibilities.ts`, la única lista de jefes que
este sistema puede leer, ahora en un solo sitio para las specs 11, 12 y 13.

Y la [13](./13-justificacion-ausencias.md) **cerró la decisión que la 12 había dejado
esperando**: aprobar una incidencia no justifica la ausencia automáticamente —cuatro de los
cinco tipos no implican una ausencia— pero se puede hacer en el mismo acto, con una casilla en
el mismo diálogo y en la misma transacción. Este bloque queda **completo**, y con eso las tres
bandejas de decisión de un jefe viven en `/team`.

Para poder construirla hubo que **adelantar parte de la [17](./17-nomina.md)**, y es la
excepción más grande al orden del índice hasta ahora: la regla crítica de la 13 —RN-13.4, el
descuento automático— no se puede implementar ni comprobar sin la tabla de ajustes, y cuatro de
sus ocho criterios de aceptación se habrían quedado sin marcar. Se construyó su **modelo
entero** y sólo el descuento por ausencia; falta su superficie de administración. La barrera de
privilegios de RN-13.5 —el jefe justifica pero no toca nómina— es hoy la más simple posible:
**no existe ningún endpoint de nómina**, y quien justifica llama a `/absences`.

### Salidas — lo que el sistema produce

La [15](./15-paneles-y-dashboard.md) llegó con **medio camino hecho**: su función pura la
adelantó la [09](./09-marcaje-asistencia.md) y su carga en lote la [13](./13-justificacion-ausencias.md).
Construirla fue, sobre todo, **sacar esas dos piezas al sitio que su §4 nombra**
(`services/daily-facts.ts`) y comprobar que no hubiera una segunda implementación a medias —
la había: el historial propio componía su propio contexto en paralelo. Ese era el error concreto
del legacy, con la lógica repartida entre un hook, una función SQL y una edge function.

Cerró sus cuatro decisiones abiertas y dejó **medida** la que más costaba demostrar: un panel de
203 personas hace las **mismas 11 consultas** que uno de 5.

La [16](./16-reporteria-mensual.md) cerró la deuda que su §7 llamaba **crítica**: en el legacy,
la exportación a Google Sheets reimplementaba a mano la misma matriz que el XLSX, sin contrato
común ni prueba que detectara una desincronización. Aquí la matriz se construye **una vez** en
`@elineas/validations` y de ahí salen tres consumidores —el XLSX, la matriz que consume Sheets y
la tabla de la pantalla—, con una prueba que escribe el archivo, lo vuelve a leer y lo compara
**celda a celda**. Cerró tres de sus cuatro decisiones y dejó abierta la segunda, que es de
negocio: **si se mantiene Google Sheets**. Lo que falta de ella es el transporte, no la forma.

Y aparecieron dos cosas que la spec no había anticipado: **el resumen de "seis columnas" no puede
cuadrar con seis** —falta la de días no laborables, o un mes con un feriado suma uno de menos—, y
una prueba encontró que `periodRange` construía en UTC y formateaba en local, así que **en La
Habana marzo terminaba el 30**. Es exactamente lo que RN-15.4 y la spec 07 §2 llevan advirtiendo.

La [14](./14-notificaciones.md) llegó al final con **el catálogo de su §4 ya completo**: los
doce eventos los habían ido añadiendo las specs que los originan, así que no quedaba ninguna
regla de generación por escribir. Lo que faltaba era la **entrega**, y con ella su decisión
abierta más antigua: **es SSE**. El tráfico va en un solo sentido, `EventSource` reconecta solo y
Hono lo trae de serie; un WebSocket habría añadido un canal de vuelta que nunca se usaría. El
sondeo cada 30 s **se queda**, porque RN-14.4 lo exige y porque es lo único que hay cuando la
pestaña está en segundo plano.

Dos decisiones que la spec no pedía y que son las que hacen que funcione. **Por el flujo viaja un
aviso, no la notificación**: el servidor dice "algo tuyo cambió" y el cliente vuelve a preguntar,
así que el aislamiento de RN-14.1 se comprueba en un solo sitio y no hay dos fuentes de verdad que
reconciliar. Y **el aviso sale cuando la transacción ya escribió, no cuando se llama a
`notify()`** — si saliera ahí, el cliente preguntaría antes del `COMMIT`, no vería nada y se
quedaría con el contador viejo treinta segundos justo después de que pasara algo. Los
destinatarios se acumulan en un `AsyncLocalStorage` y se publican al terminar el handler: la
misma maquinaria que el id de correlación de la 18, y por el mismo motivo — que ningún servicio de
dominio tenga que acordarse de nada.

Cerró tres de sus cinco decisiones y la retirada de la spec móvil le cerró otra por alcance (no
hay push). Las dos que quedan son de producto, y **la que importa es la del correo**: sin app
nativa y con la pestaña cerrada, un jefe sigue sin enterarse de una solicitud hasta que abre la
aplicación. Es el hueco que el push habría tapado.

Y la [18](./18-auditoria.md) se construyó **al revés que las demás**: su escritura llevaba
funcionando desde la [01](./01-organizacion-departamentos.md) —cada spec añadía sus acciones al
catálogo— y lo que faltaba era **poder leerla**. Hasta ahora la bitácora se consultaba en base,
que es como decir que no se consultaba. Ahora vive en `/logs` con la diferencia campo a campo que
su §7 pedía, y **no** dentro del panel de la [19](./19-panel-superadmin.md): esa spec no está
construida, y hacerla esperar habría dejado la bitácora sin leer un mes más.

Cerró tres de sus cuatro decisiones y dejó **medida su propia deuda**: de las 39 acciones del
catálogo, 23 tienen una prueba que comprueba que dejan su fila. Lo que sí está cerrado es que
ninguna se escribe fuera del catálogo y que ninguna del catálogo se queda sin emitir — hay una
prueba estática para lo segundo, que es el otro lado del enum.

La [17](./17-nomina.md) se terminó **desde el otro extremo**: su modelo y su descuento automático
los había adelantado la [13](./13-justificacion-ausencias.md) —RN-13.4 no se podía construir ni
comprobar sin la tabla de ajustes—, así que lo que quedaba era la superficie de administración.
Con ella, **la barrera de privilegios de RN-13.5 se comprueba de verdad**: hasta ahora un jefe
recibía 404 porque no había nada montado en `/api/payroll`, y "aquí no hay nada" no es lo mismo
que "no tienes permiso". Ahora recibe 403, y el rol se exige **una vez para todo el router** en
vez de endpoint por endpoint, que es la forma de que no se olvide al añadir el séptimo.

Y trajo el primer **choque entre dos reglas ya escritas**, no una decisión pendiente: RN-17.11
pedía los ajustes del periodo dentro del XLSX del reporte mensual, y la decisión 4 de la
[16](./16-reporteria-mensual.md) dice que ese archivo lo descarga cualquiera con ámbito sobre él —o
sea también un jefe de departamento—. Como el importe de un descuento es el sueldo dividido por el
divisor, meterlo ahí enseñaría el sueldo a quien RN-17.1 excluye, y ninguna comprobación al
descargar lo arregla: el archivo ya existiría con los importes dentro. Los ajustes salen por su
cuenta desde `/payroll`, con la **misma** maquinaria de cuadrícula y serializador, y de ahí queda
una regla anotada en las dos specs: *una hoja nueva en el libro del reporte hereda a todos sus
lectores*.

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 14 | [Notificaciones](./14-notificaciones.md) | ⚠️ | 02, 05 — ✅ **en el monorepo**, menos preferencias por usuario y correo |
| 15 | [Agregación diaria, dashboard y paneles](./15-paneles-y-dashboard.md) | ✅ | 07, 09, 10, 11, 13 — ✅ **en el monorepo** |
| 16 | [Reportería mensual](./16-reporteria-mensual.md) | ⚠️ | 15 — ✅ **en el monorepo**, menos el transporte a Google Sheets |
| 17 | [Nómina: ajustes y descuentos](./17-nomina.md) | ⚠️ | 02, 13 — ✅ **en el monorepo**, menos el cierre de periodo (su decisión 2) |
| 18 | [Bitácora de auditoría](./18-auditoria.md) | ⚠️ | 03 — ✅ **en el monorepo**, menos su política de retención |

### Plataforma

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 19 | [Panel de superadmin](./19-panel-superadmin.md) | ✅ | 02, 06, 18 — ✅ **en el monorepo**, sin consola SQL (decidido) |

La [19](./19-panel-superadmin.md) cierra el bloque, y su decisión más importante fue **no
construir algo**: la consola SQL. Su §6.1 la llamaba "la decisión de seguridad más importante del
proyecto" y ofrecía tres alternativas; se toma la que ella misma recomendaba. La lista negra del
legacy —bloquear `BEGIN`/`COMMIT`— no impide un `DELETE FROM profiles` y esquivarla es cuestión de
un comentario o un salto de línea; la variante de sólo lectura exige un rol de base de datos con
credencial propia, y sin ella el endpoint correría como el dueño del esquema. Y la necesidad
legítima ya estaba cubierta por `db:studio`, con credenciales que no se alcanzan desde un
navegador. **Hay una prueba de que el endpoint no existe**, para que volver a añadirlo sea un acto
deliberado.

Lo demás sí se construyó, y dos cosas merecen quedar dichas. **El mantenimiento quedó definido**
—bloquea escrituras, no cierra sesiones, deja leer y entrar, exime al `superadmin`— y su bloqueo
vive en `requireAuth`, el único sitio donde ya se conoce el rol; el aviso llega a todo el mundo
por el subconjunto público de la configuración, sin un canal nuevo. Y **la importación de
histórico funcionó gracias a tres piezas que ya estaban puestas**: la columna `source` que la 09
añadió "para cuando exista la importación", el índice único por minuto que creó para el
antirrebote —y que aquí es la idempotencia de RN-19.3 sin escribir una línea— y el recálculo de
hechos diarios de la 16.

Su §2.1 se quedó sin poder responder lo primero que pedía —"usuarios por rol"—, y es la **quinta
aparición** de la decisión 3 de la [11](./11-vacaciones.md) §9: los roles viven en el Identity
Server y este sistema no los conoce hasta que la persona entra. Es la primera vez que no hay
salida parcial: simplemente no hay número, y la pantalla lo dice.

⚠️ **Y un hallazgo que decide si la importación sirve con archivos reales**: Excel no guarda las
fechas como texto, guarda **números de serie**, y las horas como fracción de día. Sin convertirlos,
un histórico exportado daría cero filas válidas y el informe diría "fecha no válida" sobre algo que
en la pantalla se ve perfectamente.

> **La 20 —app móvil Android y distribución— se retiró, y por eso el índice salta de la 19 a la
> 21.** La aplicación se usa desde el navegador, también en el teléfono, y las pantallas de
> marcaje están hechas para eso ([05](./05-shells-y-navegacion.md) §3). Lo que esa spec cargaba
> tiene ahora un solo sitio cada cosa: la **geolocalización en segundo plano** —con el modo
> `geofence_exit` y el cierre automático de jornada— en [08](./08-sedes-y-geocerca.md) §4, y la
> **custodia de tokens en un cliente nativo** en [04](./04-autenticacion.md) §7. Las dos dejan
> de ser pendientes y pasan a ser hipótesis: no hay nada que construir mientras no exista un
> cliente nativo. Del **marcaje sin conexión** se cerró la decisión en la
> [09](./09-marcaje-asistencia.md) §9.5 —no—, y la publicación del APK desapareció del CI de la
> [22](./22-calidad-y-deuda-tecnica.md) §2 y de la §2.7 de la [19](./19-panel-superadmin.md).

### Transversales

| # | Spec | Estado | Contenido |
|---|---|---|---|
| 21 | [Migración desde el legacy](./21-migracion-desde-legacy.md) | ❌ | Qué datos se traen, qué se deja atrás, estrategia de corte |
| 22 | [Calidad, pruebas y deuda técnica](./22-calidad-y-deuda-tecnica.md) | ✅ **en el monorepo** | CI, cobertura mínima obligatoria, principios de arquitectura |

## Orden de construcción sugerido

Por dependencia técnica, no por valor de negocio:

```
00                             base propia + Identity Server: precede a todo
01 → 02 → 03 → 04 → 05        cimientos: ✅ — la 05 se cerró al final, porque su regla de
                               resolución de shell no tenía entre qué elegir hasta que los
                               cuatro destinos del EmployeeShell existieran
06                             configuración: casi todas las reglas leen de aquí
07 → 08 → 10                   el marco de validez de un marcaje
09                             el núcleo del producto
11 → 12 → 13                   las excepciones
15 → 16                        agregación y reportes (✅ las dos)
17                             nómina (depende de 13) — ✅, y su descuento automático llegó
                               antes, adelantado por la 13 porque RN-13.4 no se podía construir
                               sin él; sólo queda su cierre de periodo
14 · 18                        transversales, ✅ las dos — y las dos crecieron spec a spec
                               con lo que las demás necesitaban, así que lo último que se
                               construyó de cada una fue su superficie de lectura
19                             plataforma: ✅, y su decisión más importante fue **no**
                               construir la consola SQL
```

**21** y **22** no son una fase final: se leen **antes de empezar**. La 22 fija cómo se
construye todo lo demás y la 21 condiciona el modelo de datos.

La **[22](./22-calidad-y-deuda-tecnica.md)** se construyó al final aunque se leyera al principio,
y tiene su ironía: **el flujo de CI que exige que nada se fusione roto llegó después de diez
specs**. Lo que la salva es que sus reglas se venían aplicando desde la primera —dominio puro,
pruebas de autorización con usuarios reales, una regla una implementación— así que escribir el CI
no fue arreglar el proyecto, fue automatizar lo que ya se hacía a mano.

Y aun así **encontró tres cosas**, que es exactamente para lo que sirve: el paso de lint no
pasaba —tres errores en componentes de shadcn y el `$schema` de Biome desfasado—,
`packages/contracts` no compilaba por su cuenta, y **RQ-22.5 estaba medio cumplida**: había
conteo de consultas en el panel y no en el reporte. El del reporte, al escribirlo, enseñó que
**el reporte sí crece** —34 consultas con 5 personas, 45 con 205— y que el crecimiento no es un
N+1 sino el `insert` de hechos diarios en trozos de 500 filas, que es el límite del protocolo de
PostgreSQL.

⚠️ **Lo que el repositorio no puede cerrar solo**: RQ-22.1 dice que ningún cambio se fusiona sin
que los cinco pasos pasen, y el flujo sólo *declara* las comprobaciones. Bloquear la fusión es
marcar el trabajo como obligatorio en la configuración de la rama en GitHub. Sin ese
interruptor, los cinco pasos son un informe y no una barrera.

## Ya decidido

- **La base de datos deja Supabase** y pasa al contenedor de PostgreSQL del monorepo.
- **Usuarios, roles, autenticación y autorización se rigen por el Identity Server de Elineas**
  ([identity-server-usage.md](../docs/identity-server-usage.md)); **better-auth se retira**.
- **El alta de usuarios se hace en el Identity Server**, no en esta aplicación — ni siquiera
  llamando a su API. Aquí sólo se completa el perfil de negocio.
- **Un perfil desactivado no puede autenticarse aquí**: el login se rechaza aunque las
  credenciales del IS sean correctas. Es una baja de este sistema, no de Elineas.
- **El IS admite alta masiva**, lo que simplifica el corte: las cuentas de toda la plantilla se
  crean de una vez.

Todas en [00](./00-migracion-datos-e-identidad.md).

De la [10](./10-descansos.md), que cerró sus cuatro decisiones abiertas:

- **`days_of_week` es 0 = domingo … 6 = sábado**, la convención de `Date.getDay()` y de
  `extract(dow from …)`. Cualquier otra obliga a convertir en cada frontera.
- **La lista vacía de `rest_days_min_separation_departments` significa "a todos"**: el
  interruptor de la regla es el número, la lista sólo la acota.
- **El mínimo y el máximo de descansos semanales son configuración**, con defaults que dejan la
  regla inerte: la cifra es laboral y la pone el negocio.
- **El empleado elige sus descansos**, no los propone; las validaciones de servidor son el freno.

Y una consecuencia del modelo que conviene saber antes de tocar los grupos: **cambiar los días de
un grupo alcanza al pasado de sus miembros** ([10](./10-descansos.md) §9, decisión 5). Rotar
turnos se hace creando otro grupo y reasignando.

De la [11](./11-vacaciones.md):

- **Sólo los días laborables que no son descanso consumen saldo.** Un día libre dentro del rango
  no se cobra: no iba a trabajarse de todas formas.
- **No hay medios días ni caducidad del saldo.** Las dos entrarían, si acaso, con la decisión de
  cumplimiento normativo, que sigue abierta.
- **Las vacaciones sólo se piden a futuro, sin excepción de rol** — al contrario que los
  descansos (RN-10.7): una regularización hacia atrás es una incidencia, no una fecha movida.

De la [12](./12-incidencias.md), que cerró tres de sus cuatro decisiones abiertas:

- **El plazo para reportar una incidencia es configuración, y `0` significa "sin plazo"**
  (`incident_report_window_days`, default 0). Mismo criterio que los límites de descansos: la
  cifra es laboral y la pone el negocio; el default deja la regla inerte.
- **Aprobar una incidencia no crea ni corrige ningún marcaje** (RN-12.9), y "olvidé marcar"
  tampoco: la incidencia no captura una hora declarada, así que no hay de dónde sacar el
  instante de la marca. Cambiarlo es un cambio de modelo, no un cambio de la aprobación.
- **No hay adjuntos.** Este sistema no almacena archivos, y el caso técnico ya trae su prueba
  dentro: el marcaje bloqueado con su motivo.

Y una de forma, que corrige una regla que se cumplía a medias: **el aside filtra los enlaces con
`canAccess`**, la misma función que el guard de página ([05](./05-shells-y-navegacion.md)
RN-05.7). Con la comprobación escrita dos veces se había perdido la lista de exclusión, y a un
`global_manager` se le ofrecían *Marcar* y *Mi asistencia* para que el guard lo echara a
continuación.

De la [13](./13-justificacion-ausencias.md), que cerró tres de sus cinco decisiones abiertas y
una de la [17](./17-nomina.md):

- **Aprobar una incidencia no justifica la ausencia automáticamente**, pero se puede hacer en el
  mismo acto. Cierra también la decisión 1 de la [12](./12-incidencias.md).
- **Una ausencia sin revisar es ANJ en la presentación y no genera descuento.** Las dos mitades
  tienen el mismo motivo: el descuento exige que alguien lo decida, y el reporte no debe
  esconder una ausencia que nadie explicó. Un campo `reviewed` hace que convivan.
- **Notas obligatorias al justificar, opcionales al marcar injustificada.** Es la asimetría
  inversa a las de las specs 11 y 12, y el criterio es el mismo: se pide la razón de la decisión
  discrecional — allí, negar algo; aquí, perdonar un descuento.
- **El descuento diario se calcula en PostgreSQL**, `round(sueldo / divisor, 2)` sobre
  `numeric`, y el divisor es configuración ([17](./17-nomina.md) RN-17.3 y RN-17.12). Un dato de
  dinero no pasa por coma flotante.

Y una consecuencia de la barrera de privilegios que la spec no anticipaba: **el jefe que
clasifica una ausencia no ve el importe del descuento que causa**, porque el importe es el sueldo
dividido por el divisor y enseñárselo le enseña el sueldo (hallazgo H-3). Ve el hecho; la cifra
sólo llega a un rol administrativo — y al propio empleado, en su notificación.

De la [15](./15-paneles-y-dashboard.md), que cerró sus cuatro:

- **El marcaje en un día no laborable o de descanso gana `PRESENTE`** (RN-15.2). Esconder
  trabajo que existió es peor que contradecir un orden de presentación, y en vivo no puede pasar.
- **El dashboard es fijo por rol, no configurable.** Las tres filas de su §5.1 son acumulativas:
  es una pantalla cuyas secciones aparecen según lo que manda el servidor.
- **"Estado en vivo" se responde a medias, con la mitad que se puede construir**: quién tiene la
  jornada abierta, no quién está dentro de la geocerca. Lo segundo exige geolocalización en
  segundo plano, que un navegador no da y que quedó **fuera del alcance**
  ([08](./08-sedes-y-geocerca.md) §4); fingirlo con la última marca diría "dentro" de alguien que
  se fue sin marcar.
- Y **`scope=` desapareció de la API en vez de rechazarse**: el ámbito sale de la sesión y sólo
  se puede *acotar*. El parámetro que puede ensanchar el ámbito es el parámetro por el que se
  escapan los datos.

De la [16](./16-reporteria-mensual.md), que cerró tres de sus cuatro:

- **Los códigos de la matriz son los de su §2** (`P`/`T`/`D`/`NL`/`V`/`AJ`/`ANJ`). El legacy sólo
  documentaba `AJ`/`ANJ` y los nombres de las seis columnas, y los dos coinciden.
- **El periodo es el mes natural.** Un periodo del 26 al 25 arrastraría a la 17, cuyo cierre de
  periodo sigue siendo su propia decisión abierta.
- **Un reporte lo descarga cualquiera con ámbito sobre él**, sin mirar su fecha de alta: el
  reporte es de un departamento y un periodo, no de una persona.
- Y una que la spec daba por hecha y no lo era: **el resumen necesita una séptima columna**, la
  de días no laborables, o RN-16.1 —"la suma de las columnas = días del mes"— es imposible de
  cumplir. Las seis del entregable siguen siendo seis; la séptima va aparte.

**Para el XLSX se usa `hucre`**: cero dependencias, ESM y TypeScript nativos, y un formato de
escritura por filas que es exactamente la forma que ya tenía la cuadrícula compartida.

De la [05](./05-shells-y-navegacion.md), que cerró sus dos decisiones pendientes:

- **El override `?ui=` se queda en producción**, y se recuerda en la pestaña. No puede otorgar
  permisos —el filtrado y el guard salen de `canAccess`, no del shell— y es la única forma de
  reproducir en un escritorio lo que ve un operario que llama diciendo "no me deja marcar".
- **Un jefe de departamento ya tenía acceso rápido a marcar**: está en el grupo *Personal* de su
  aside desde el principio. La pregunta se respondía mirando el menú.
- Y una de forma: **el destino por defecto depende del shell, no sólo del rol** (RN-05.4). La
  misma persona quiere cosas distintas según desde dónde entre — un jefe en el teléfono va a
  marcar, el mismo jefe en su escritorio va a mirar a su equipo.

**Y esta spec trae la primera prueba del frontend del repositorio**: la regla de resolución de
shell es pura, tiene cuatro casos y un override que los pisa, y comprobarla desde un componente
exigiría abrir un navegador y redimensionar una ventana. `bun run test` corre ya los dos
workspaces.

De la [19](./19-panel-superadmin.md), que cerró tres de sus cuatro:

- **No hay consola SQL, y no la va a haber por descuido.** Una lista negra sobre texto SQL no se
  puede arreglar, y la necesidad legítima vive fuera de la aplicación (`db:studio`).
- **El mantenimiento bloquea escrituras, no sesiones.** Cerrar sesiones sólo obligaría a toda la
  plantilla a volver a autenticarse contra un sistema que no está en mantenimiento.
- **La importación se queda en el panel**, no en la spec 21: el corte del legacy no es su único
  caso, y RN-19.10 tolera exactamente esto — algo que se hace casi nunca.
- Y una de modelo: **un marcaje importado no tiene coordenadas.** Las tres columnas admiten nulo
  para poder decir "no se midió" en vez de un `0, 0` que señalaría a un punto real. Es lo que
  hace verificable RN-19.5.

De la [14](./14-notificaciones.md), que cerró tres de sus cinco (más una por alcance):

- **La entrega en vivo es SSE, y el sondeo se queda.** No es "o uno u otro": la regla exige el
  respaldo, y una campana quieta no se distingue de una bandeja vacía.
- **Por el flujo viaja un aviso, no la notificación.** El contenido sale siempre del endpoint que
  filtra por la sesión, así que el aislamiento se comprueba en un sitio y no en dos.
- **Las notificaciones leídas se purgan por configuración**, `notification_retention_days` con
  default 0; las **no leídas no se purgan nunca**, por viejas que sean: son trabajo pendiente de
  alguien.
- Y una de forma, hermana de la anterior: **`/notifications` no está en el aside y no lleva
  `RequireRole`.** No hay rol que comprobar porque no hay ámbito — cada persona ve las suyas y
  sólo las suyas—, así que no existe una versión "de más" de esa pantalla.

De la [18](./18-auditoria.md), que cerró tres de sus cuatro decisiones:

- **Un `global_manager` no lee la bitácora, ni "la parte de su ámbito".** No es prudencia: una
  entrada no tiene departamento, así que ese recorte no se puede calcular sin etiquetar cada fila
  al escribirla y rellenar hacia atrás las que ya existen. Y lo que un gestor necesita ya está en
  el propio registro: quién revisó una ausencia está en la revisión.
- **Un fallo de bitácora aborta la acción, siempre.** Ya lo era —`audit()` escribe dentro de la
  transacción— y hacer la excepción costaría más que mantenerla: habría que mantener una lista de
  dominios "críticos".
- **La IP se registra**, y sólo la ve un `superadmin`.
- Y una de forma que vale para cualquier catálogo cerrado de este repositorio: **el verbo se
  escribe contra el enum y se lee como texto.** El enum es el contrato de escritura; al leer, una
  fila de una versión anterior sigue ahí (RN-18.6) y validarla obligaría a esconderla.

⚠️ **Y un fallo que conviene conocer antes de escribir el siguiente cursor**, porque no da
ningún síntoma: `timestamptz` guarda **microsegundos** y el `Date` de JavaScript sólo llega a
**milisegundos**, así que un cursor construido desde el valor de JS deja fuera todas las filas de
ese mismo microsegundo — las hermanas escritas en la misma transacción. Una fila **desaparece al
pasar de página** y nada falla. Lo encontró la prueba de paginación de la 18 y afectaba igual a la
lista de notificaciones, que comparte el cursor; ahora el instante lo formatea PostgreSQL y no
pasa por JavaScript (`lib/keyset.ts`).

**El identificador de correlación de RN-18.8 no se pasa como argumento**, y es la decisión
técnica de esta spec: vive en un `AsyncLocalStorage` que el middleware abre por petición, así que
una cascada comparte identificador sin que ningún servicio de dominio se entere. Pasarlo a mano
sería repetir el error que la spec 18 §5 diagnostica en el legacy — la llamada que se olvidara de
propagarlo rompería la cadena sin fallar ni avisar.

De la [17](./17-nomina.md), que dejó su cierre de periodo abierto y cerró todo lo demás:

- **Un importe nunca va sin su moneda, y un total tampoco.** No hay una cifra por departamento:
  hay una por departamento **y moneda**. En la misma plantilla se cobra en varias (spec 02 §6a) y
  sumarlas da un número que no significa nada.
- **Los ajustes del periodo no caben en el reporte mensual.** No es preferencia: ese XLSX lo
  descarga cualquiera con ámbito sobre él y el importe de un descuento revela el sueldo
  (RN-17.1, hallazgo H-3). Van en su propio archivo, desde `/payroll`.
- **Un ajuste manual se distingue por no tener origen**, no por su categoría. Las tres categorías
  se pueden usar a mano; lo que no se puede falsificar es un `source_id`. De ahí que el índice
  único de RN-17.5 sea parcial: dos manuales del mismo mes son legítimos.
- **Editar un sueldo sigue siendo `PUT /users/:id/compensation`.** La §6 pedía un segundo
  endpoint en `/payroll` para lo mismo, con el mismo rol y la misma entrada de bitácora; serían
  dos sitios donde arreglar la misma regla. Lo que faltaba era **verlos todos**, y eso sí se
  añadió.

Y una de interfaz que vale dinero: **el signo de un ajuste se elige, no se teclea.** Con un campo
firmado, olvidar un carácter convierte un descuento de 250 en una bonificación de 250.

Y dos de forma:

- **El código se escribe en inglés; la interfaz, en español.** Rutas incluidas: *Mi asistencia*
  vive en `/attendance`. Los comentarios y estas specs siguen en español, porque el código
  las cita por número de regla. Tabla completa en
  [contributing.md §idioma](../docs/contributing.md) y
  [05 §7](./05-shells-y-navegacion.md).
- **El departamento de los `global_manager` se configura por id**, no por el nombre
  "Administración" del trigger del legacy ([03](./03-roles-y-autorizacion.md) RN-03.6).

## Antes de implementar

Lo que sigue abierto y bloquea a varias specs a la vez:

1. **¿Se reimplementa RLS en Postgres, o la autorización vive sólo en Hono?**
   → [03](./03-roles-y-autorizacion.md) §6. Con Supabase fuera, la red de seguridad
   desaparece: es el riesgo número uno de la migración
   ([00](./00-migracion-datos-e-identidad.md) RN-00.1).
2. **Dos preguntas al equipo del Identity Server**, de las que depende la UX del corte y el
   soporte del día a día: ¿fuerza cambio de contraseña al primer ingreso?, ¿tiene recuperación
   autoservicio? → [00](./00-migracion-datos-e-identidad.md) §B.1.
3. ~~**¿Hace falta geolocalización en segundo plano y marcaje sin conexión?**~~ **Cerrado por
   alcance:** no, mientras la aplicación se use desde el navegador. Lo segundo se decidió en la
   [09](./09-marcaje-asistencia.md) §9.5 —una cola local obliga a aceptar la hora del teléfono,
   que es justo lo que RN-09.11 evita— y lo primero queda anotado en
   [08](./08-sedes-y-geocerca.md) §4 como lo que haría falta **si** algún día hubiera cliente
   nativo. Ninguna de las dos bloquea nada hoy.

4. **¿Cómo se sabe quién es jefe de un departamento sin que esté autenticado?**
   → [11](./11-vacaciones.md) §9, decisión 3. Los roles viven en el Identity Server y sólo se
   conocen por *session token* (RN-00.43); en nuestra base sólo queda el ámbito **adicional** de
   un jefe (spec 03 §3), nunca su departamento propio. Eso deja dos cosas a medias hoy: a quién
   se notifica una solicitud de vacaciones y qué regla protege las vacaciones de un jefe. Pide
   una de dos decisiones de arquitectura — consultar al IS los roles de un usuario cualquiera, o
   registrar localmente qué perfil es jefe de qué departamento.
   **Ya reapareció en la [12](./12-incidencias.md)** (RN-12.10: el aviso de una incidencia nueva
   sólo llega a los responsables adicionales) y va a reaparecer en la 13. La consulta está ahora
   en una sola función —`additionalHeadsOf`, en `services/responsibilities.ts`— para que
   cerrar la decisión sea un cambio en un sitio y no en tres.

Y una de negocio, no técnica, que puede reescribir una spec entera:

5. **¿El modelo de vacaciones debe cumplir la normativa laboral cubana?**
   → [11](./11-vacaciones.md) §2. *(Decía "peruana": la empresa opera en Cuba, ver
   [06](./06-configuracion-global.md) §8.)* Lo construido es el modelo simple del legacy; si la
   respuesta es "sí", esa spec cambia por completo.
