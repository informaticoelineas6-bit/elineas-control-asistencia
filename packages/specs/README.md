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
| 05 | [Shells de interfaz y navegación](./05-shells-y-navegacion.md) | ✅ | ⚠️ | 03, 04 |
| 06 | [Configuración global](./06-configuracion-global.md) | ✅ | ✅ | 03 |

Lo único que queda abierto en los cimientos es el **EmployeeShell** de la
[05](./05-shells-y-navegacion.md) §3. Dos de sus cuatro destinos ya existen —`/clock-in` y
`/profile`— y las pantallas de marcaje e historial están hechas en columna estrecha y con el
botón grande, así que montarlas en una barra inferior no obliga a rehacerlas; el tercero,
*Incidencias*, existe desde la [12](./12-incidencias.md) —como `/incidents`, no como el
`/issues` que decía la spec— y falta `/my-week` (reutiliza el historial de la
[09](./09-marcaje-asistencia.md)) y la regla de resolución de shell (§2), que hoy no tiene entre
qué elegir.

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

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 14 | [Notificaciones](./14-notificaciones.md) | ⚠️ | 02, 05 |
| 15 | [Agregación diaria, dashboard y paneles](./15-paneles-y-dashboard.md) | ✅ | 07, 09, 10, 11, 13 — ✅ **en el monorepo** |
| 16 | [Reportería mensual](./16-reporteria-mensual.md) | ⚠️ | 15 |
| 17 | [Nómina: ajustes y descuentos](./17-nomina.md) | ⚠️ | 02, 13 — **parcial en el monorepo**: hecho el descuento automático, falta la administración |
| 18 | [Bitácora de auditoría](./18-auditoria.md) | ⚠️ | 03 |

### Plataforma

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 19 | [Panel de superadmin](./19-panel-superadmin.md) | ✅ | 02, 06, 18 |
| 20 | [App móvil Android y distribución](./20-app-movil-y-distribucion.md) | ⚠️ | 04, 08, 19 |

### Transversales

| # | Spec | Estado | Contenido |
|---|---|---|---|
| 21 | [Migración desde el legacy](./21-migracion-desde-legacy.md) | ❌ | Qué datos se traen, qué se deja atrás, estrategia de corte |
| 22 | [Calidad, pruebas y deuda técnica](./22-calidad-y-deuda-tecnica.md) | ❌ | CI, cobertura mínima obligatoria, principios de arquitectura |

## Orden de construcción sugerido

Por dependencia técnica, no por valor de negocio:

```
00                             base propia + Identity Server: precede a todo
01 → 02 → 03 → 04 → 05        cimientos: sin esto no hay nada
06                             configuración: casi todas las reglas leen de aquí
07 → 08 → 10                   el marco de validez de un marcaje
09                             el núcleo del producto
11 → 12 → 13                   las excepciones
15 → 16                        agregación y reportes (15 ✅)
17                             nómina (depende de 13) — su descuento automático ya está,
                               adelantado por la 13 porque RN-13.4 no se podía construir sin él
14 · 18                        transversales, en paralelo desde temprano
19 → 20                        plataforma
```

**21** y **22** no son una fase final: se leen **antes de empezar**. La 22 fija cómo se
construye todo lo demás y la 21 condiciona el modelo de datos.

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
  segundo plano, que sigue abierto en la [20](./20-app-movil-y-distribucion.md) §7; fingirlo con
  la última marca diría "dentro" de alguien que se fue sin marcar.
- Y **`scope=` desapareció de la API en vez de rechazarse**: el ámbito sale de la sesión y sólo
  se puede *acotar*. El parámetro que puede ensanchar el ámbito es el parámetro por el que se
  escapan los datos.

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
3. **¿Hace falta geolocalización en segundo plano y marcaje sin conexión?**
   → [20](./20-app-movil-y-distribucion.md) §7. Decide la forma de la app móvil; no bloquea
   nada más si el backend queda preparado para autenticar también por cabecera.

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
