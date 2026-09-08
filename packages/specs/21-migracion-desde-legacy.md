# 21 · Migración desde el sistema legacy

> **Origen:** transversal a todo `old-docs.md`; hallazgos H-2 y H-3; puntos 22 (`geofence_config`), 70 (deriva de esquema), 80 (limpieza).
> **Estado:** ⚠️ **la herramienta está construida y probada; el corte no se ha hecho.** Esta spec
> no describe una funcionalidad del producto, sino **el trabajo de traer los datos y las
> decisiones del sistema anterior**, así que "terminada" no la decide el código: la decide un fin
> de semana con el legacy delante.
>
> **Hay:** el migrador en `apps/backend/src/migration/` —`legacy-tables.ts` declara qué se trae y
> qué no, `legacy.ts` lo ejecuta y `cli.ts` es la orden— con **los tres comandos que fija la
> [00](./00-migracion-datos-e-identidad.md) RN-00.23**: `extract` (origen → esquema `legacy`),
> `load` (simulación por defecto, escribe con `--commit`) y `verify`. El procedimiento tecleado
> está en [DEPLOY.md](../../DEPLOY.md) §4.
>
> **Son dos etapas y no una**, y eso no era evidente hasta escribirlo: `extract` es lo único que
> toca el legacy, así que la ventana contra el sistema que se apaga es de minutos —la spec 00 §B.3
> la limita a cuatro horas, y con una sola etapa cada reintento se la come entera— y `load`, que
> es donde viven las transformaciones y por tanto los errores, se repite sobre la copia sin volver
> a leer producción. Con una ventaja que no era el objetivo: **`verify` funciona con el legacy ya
> desconectado**, porque compara contra esa copia cruda, que queda como prueba documental de lo
> que había.
>
> **Y está probado sin el legacy delante**, que era el problema: la prueba de
> `migration/legacy.test.ts` **fabrica el origen** —crea un esquema con la forma que
> `old-docs.md` §3 documenta, incluidas las dos tablas homónimas del otro sistema— lo siembra,
> migra contra la base real y comprueba el resultado. Un migrador que nadie ha ejecutado es una
> hoja de instrucciones, no una herramienta.
>
> **No hay, y no puede haberlo todavía:** el corte, la comparación del reporte de un mes cerrado
> contra el legacy (§9, que exige los dos sistemas vivos) y el procedimiento de vuelta atrás
> probado.
> **Léase junto a [00-migracion-datos-e-identidad](./00-migracion-datos-e-identidad.md)**, que
> fija las decisiones (contenedor de PostgreSQL, Identity Server) y la UX del corte. Aquí está
> el detalle tabla por tabla.

---

## 1. Punto de partida

| | Legacy | Monorepo nuevo |
|---|---|---|
| Frontend | React 18 + Vite (SPA) | TanStack Start (React + SSR) |
| Backend | Supabase: Postgres + Auth + Storage + Edge Functions (Deno) | Hono + Drizzle + **PostgreSQL en contenedor** ([00](./00-migracion-datos-e-identidad.md) §A.1) |
| Autenticación | Supabase Auth | **Identity Server de Elineas** ([00](./00-migracion-datos-e-identidad.md) Parte C) |
| Autorización | RLS en Postgres (autoridad real) + guard de cliente | **Sólo capa de aplicación** salvo que se decida reimplementar RLS |
| Lógica de negocio | Repartida entre hooks de React, funciones SQL, triggers y edge functions | Servicios de dominio en el backend |
| Validación | Ad hoc | Zod compartido (`packages/validations`) |
| Contratos | Ninguno (cliente hablando directo a la base) | `packages/contracts` |
| Móvil | Capacitor sobre la SPA | **No se migra**: se usa desde el navegador del teléfono, con las pantallas de marcaje hechas para eso ([05](./05-shells-y-navegacion.md) §3) |
| Almacenamiento | Buckets de Supabase (`monthly-reports`, `app-releases`) | Volumen privado del contenedor para los reportes; `app-releases` sin destino (la app móvil salió del alcance) |
| Histórico de asistencia | Tablas del legacy | **Se importa con la herramienta de la [19](./19-panel-superadmin.md) §2.4**: hoja de cálculo, informe previo y escritura idempotente marcada `source = import` |

## 2. Los cuatro cambios de fondo

1. **Desaparece RLS como red de seguridad.** En el legacy, aunque el cliente hablara directo
   con la base, Postgres imponía el ámbito. En el monorepo la autorización vive **sólo** en
   los handlers de Hono. Cada endpoint es un agujero potencial.
   → [03-roles-y-autorizacion](./03-roles-y-autorizacion.md) §6, decisión abierta 2.
2. **La lógica sale de la base de datos.** Triggers y funciones SQL (`validate_attendance_mark`,
   `handle_absence_review_payroll_impact`, `handle_new_user`, `enforce_gm_department`) pasan a
   ser servicios de dominio en TypeScript. Ventaja: testeables y visibles. Riesgo: lo que el
   trigger garantizaba siempre, ahora hay que invocarlo siempre.
3. **Un solo lugar por regla.** El legacy tenía la misma regla escrita tres veces (estado
   diario en un hook, en una función SQL y en una función Deno de exportación). El monorepo
   debe tener una implementación por regla, compartida.
4. **La base deja de ser compartida.** Ver §3.

## 3. Hallazgo H-2: la base de datos legacy está compartida

Los tipos generados del legacy declaran ~15 tablas que **no pertenecen a este sistema** y
conviven en el mismo esquema `public`: `activos`, `guardias`, `requests`, `request_comments`,
`request_feedback`, `request_histories`, `request_trash`, `worklogs`, `knowledge_base`,
`automation_rules`, `automation_logs`, `chat_logs`, `app_users`, `audit_logs`, `incidents`.

Consecuencias para la migración:

- **RN-21.1** — La extracción de datos debe limitar la lista de tablas explícitamente. No se
  copia el esquema entero.
  > ✅ `LEGACY_COPIES` es esa lista, y el orden del array **es el orden de inserción**: respeta
  > las claves ajenas sin que nadie tenga que acordarse.
- **RN-21.2** — Cuidado con los **homónimos**: `audit_logs` (ajeno) vs `audit_log` (propio);
  `incidents` (ajeno) vs `attendance_incidents` (propio). Confundirlos importaría datos de
  otro sistema.
  > ✅ Y con dos redes, porque este error no da ningún aviso —cuadra de tipos y entra—: las
  > quince tablas ajenas están enumeradas (`FOREIGN_TABLES`) y el `plan` **falla** si alguna
  > aparece en la lista blanca, que es lo que atrapa el descuido del día que alguien añada una
  > tabla mirando el nombre de reojo. La prueba siembra filas en `audit_logs` e `incidents` del
  > otro sistema y comprueba que no llegan.
- **RN-21.3** — Confirmar si el otro sistema comparte además la tabla de usuarios de
  autenticación. Si es así, la migración de identidades tiene que discriminar por pertenencia
  a este producto.

## 4. Datos a migrar

| Dominio | Tablas | Notas |
|---|---|---|
| Organización | `departments` | Directo |
| Identidad | `profiles`, `user_department_responsibilities` | Ver §5. **`user_roles` y los usuarios de auth NO se migran**: pasan al Identity Server |
| Reglas | `department_schedules`, `work_calendar`, `user_rest_schedule`, `rest_groups`, `rest_group_members` | Directo; verificar convención de `days_of_week` ([10](./10-descansos.md)) |
| Ubicación | `work_locations` | **`geofence_config` no se migra**: si aún hay datos ahí, se consolidan en `work_locations` en el propio script ([08](./08-sedes-y-geocerca.md)) |
| Asistencia | `attendance_marks` | El volumen mayor. Migrar por lotes |
| Excepciones | `attendance_incidents`, `attendance_absence_reviews`, `vacation_requests` | Conservar decisiones y revisores |
| Reportería | `attendance_daily_facts`, `attendance_rule_versions`, `report_runs` | **Los hechos diarios se recalculan, no se copian** ([16](./16-reporteria-mensual.md) RN-16.10). `report_runs` sólo si se quiere conservar el historial |
| Plataforma | `app_config`, `audit_log`, `notifications`, `payroll_adjustments`, `app_releases` | `notifications` probablemente no valga la pena migrar |
| Almacenamiento | buckets `monthly-reports`, `app-releases` | Decidir si se migran los artefactos o se regeneran |

- **RN-21.4** — La migración de `payroll_adjustments` es **crítica y no negociable**: es
  historial económico. Debe migrarse íntegro, incluidos los revertidos, y verificarse contra
  los totales del sistema anterior.
  > ✅ `verify` compara **el conteo y la suma**, que no son la misma comprobación: mil filas
  > pueden estar todas y una traer el importe mal. La suma se compara como texto, sin pasar
  > dinero por coma flotante (RN-17.12).
  >
  > ⚠️ Y dos columnas que el legacy no tenía: **moneda y periodo**. La moneda entra como `CUP` —la
  > empresa paga en peso cubano salvo excepción, y las excepciones se corrigen a mano— y el
  > periodo se imputa desde `created_at`, que es **la única respuesta disponible** para lo ya
  > escrito: en el legacy los ajustes se filtraban por fecha de creación, que es justamente la
  > fragilidad que la [17](./17-nomina.md) §7 describe. De ahí en adelante sale de la fecha de la
  > ausencia.
- **RN-21.5** — Los identificadores se conservan cuando sea posible, para que las referencias
  cruzadas (`source_id`, `reviewed_by`) sigan resolviendo.
  > ⚠️ **Y aquí está la trampa más cara de esta migración.** El id de un perfil sale de
  > `profiles.user_id`, **no** de `profiles.id`: en el legacy el perfil era 1:1 con `auth.users` y
  > todo el historial cuelga del id de autenticación —`attendance_marks.user_id`, `reviewed_by`,
  > `created_by`, `source_id`—. Conservar el id de la fila de perfil dejaría **todas** esas
  > referencias apuntando al vacío, y sin un solo error: son uuids válidos. La prueba lo fija —
  > siembra un perfil cuyo `id` y `user_id` son distintos y comprueba cuál sobrevive.
  >
  > La consecuencia buena: **la tabla de correspondencia de la §5.3 no hace falta.** Si los
  > identificadores se conservan, no hay nada que correlacionar.
- **RN-21.6** — Verificación obligatoria por dominio: conteo de filas origen vs destino, y
  para asistencia además una comparación del **reporte mensual de un mes cerrado** generado
  por ambos sistemas. Si no coinciden celda a celda, la migración no está terminada.

## 5. Migración de identidades

El punto más delicado, y ya decidido: **las identidades pasan al Identity Server de Elineas**
([00](./00-migracion-datos-e-identidad.md) Parte C). Las contraseñas de Supabase **no se
migran**: no son reutilizables allí.

El trabajo concreto es de **emparejamiento**:

1. Las cuentas se crean (o ya existen) en el IS, con su rol en `control-asistencia` asignado
   — sin rol no pueden entrar ([00](./00-migracion-datos-e-identidad.md) RN-00.33).
   ✅ **El IS admite alta masiva**, así que se cargan todas de una vez desde el listado que
   salga del legacy; no hay que darlas de alta una a una.
2. Cada `profiles` heredado se vincula a su identidad del IS **por correo**, una sola vez,
   guardando el `sub` en `identity_user_id`.
3. El `user_id` de Supabase se conserva en una **tabla de correspondencia** durante la
   migración, porque todo el historial cuelga de él.

- **RN-21.7 — Ningún perfil puede quedar sin emparejar.** Un perfil sin `identity_user_id` es
  un empleado que no podrá entrar el lunes. `verify` debe fallar si queda alguno
  ([00](./00-migracion-datos-e-identidad.md) RN-00.47).
  > ✅ **Y no hay que comprobarlo en `verify`: es imposible de incumplir.**
  > `profiles.identity_user_id` es `not null`, así que un perfil sin identidad **no se puede
  > insertar**. El esquema convierte la regla en una precondición.
  >
  > ⚠️ Lo que eso cambia es el orden que esta §5 describía. El emparejamiento **no es un paso
  > posterior**: las identidades tienen que existir en el Identity Server *antes* de copiar, y el
  > migrador recibe el mapa `correo → identidad` como **entrada** (`IDENTITY_MAP`, CSV o JSON del
  > alta masiva). Sin él no arranca.
- **RN-21.8 — Correos duplicados o ausentes en el legacy** son el fallo probable de este paso:
  detectarlos y resolverlos **antes** del corte, no durante.
  > ✅ Los dos casos los detecta el `plan`, que es el paso que se ejecuta **antes** y tantas veces
  > como haga falta. Un correo sin emparejar o repetido bloquea `run`, con la lista delante.
- **RN-21.9 — Los roles se recrean en el IS a partir de `user_roles`**, que sirve como lista de
  referencia y luego se descarta. Verificar uno a uno: quién era `department_head` y quién
  `global_manager` no puede quedar a criterio de nadie.
- La UX del cambio de contraseña para el empleado está resuelta en
  [00](./00-migracion-datos-e-identidad.md) §B.1.

## 6. Estrategia de corte

**Decisión abierta.** Tres caminos:

- **Corte limpio** — se congela el legacy un fin de semana, se migra y se arranca el nuevo.
  Simple, exige que el sistema nuevo esté completo.
- **Funcionalidad por funcionalidad** — ambos sistemas conviven contra la misma base.
  **Descartado**: la base cambia de sitio y la autenticación cambia de proveedor
  ([00](./00-migracion-datos-e-identidad.md)); no hay base común sobre la que convivir.
- **Sólo hacia adelante** — el sistema nuevo arranca con los datos maestros (personas,
  departamentos, reglas) y el histórico de asistencia queda consultable en el legacy en modo
  lectura. Rápido, pero deja los reportes partidos en dos.

Recomendación inicial: **corte limpio**, con el legacy en sólo lectura durante un periodo de
gracia.

> **Decisión 1 cerrada: corte limpio.** Ya no es sólo una recomendación, porque las otras dos se
> quedaron sin sitio:
>
> - **Funcionalidad por funcionalidad** la descartaba esta misma sección —no hay base común sobre
>   la que convivir— y sigue igual.
> - **Sólo hacia adelante** era la alternativa razonable *cuando no había forma de traer el
>   histórico*. Ahora la hay dos veces: este migrador y, para lo que venga fuera de la base, la
>   importación de hoja de cálculo de la [19](./19-panel-superadmin.md) §2.4. Dejar los reportes
>   partidos en dos sistemas —uno apagado— para ahorrar un fin de semana ya no se sostiene.
>
> Lo que el corte limpio exige y **está**: que el sistema nuevo esté completo (las veintiuna specs
> anteriores lo están) y que la migración sea **repetible**, para poder ensayarla entera sobre una
> copia antes del día señalado. Lo es por construcción: los identificadores se conservan y todas
> las inserciones llevan `on conflict do nothing`, así que la segunda pasada no escribe nada —hay
> una prueba de eso—.

## 7. Deuda que **no** se migra

Lista explícita de cosas del legacy que deben quedarse atrás:

- `geofence_config` (tabla legacy con fallback y automigración).
- La duplicación de la matriz de reporte entre XLSX y Sheets ([16](./16-reporteria-mensual.md) §7.2).
- La regla de recordatorio de descansos dentro del contexto de notificaciones (H-4).
- Los argumentos invertidos en la comprobación de jefe de departamento (H-1).
- El salario sin barrera de columna (H-3).
- La migración vacía sin explicar y demás residuos (punto 80).
- La consola SQL con lista negra, salvo decisión explícita en contra
  ([19](./19-panel-superadmin.md) §2.3).
- **better-auth**, que quedó en el andamiaje del monorepo y se retira
  ([00](./00-migracion-datos-e-identidad.md) RN-00.26).

## 8. Control de cambios de esquema

> ⚠️ **Punto 70 del legacy:** ya ocurrió una **deriva real** entre la base de producción y el
> historial de migraciones — se ejecutó SQL a mano fuera del control de versiones.
>
> Requisito para el monorepo: **todo cambio de esquema pasa por una migración de Drizzle en el
> repositorio.** Sin excepciones, ni siquiera para "un índice rápido en producción". Debe
> haber una verificación en CI que compare el esquema desplegado con el del repositorio.

> ✅ **La verificación existe**: es el paso 5 del CI de la [22](./22-calidad-y-deuda-tecnica.md)
> §2, `scripts/check-schema-drift.ts`. Si `schema.ts` tiene cambios sin migración, la
> comprobación falla — y se comprobó que detecta la deriva de verdad, no sólo que termina en
> cero.
>
> ⚠️ **Cubre la mitad del punto 70, y conviene no confundirlas.** Lo que compara es el
> **repositorio contra sus propias migraciones**: atrapa el cambio de esquema que nadie escribió
> como migración. Lo que *no* puede ver desde CI es la base **desplegada**, que es donde ocurrió
> la deriva del legacy —SQL ejecutado a mano en producción—. Eso lo garantiza el despliegue: la
> base sólo se toca con `bun run db:migrate`, y sobre eso no hay comprobación automática que
> sustituya a la disciplina.

## 9. Criterios de aceptación de la migración

Estos criterios son de **la migración**, no de la herramienta, así que la mayoría sólo se pueden
marcar el día del corte. Lo que sí se puede decir hoy es cuáles tienen ya su comprobación escrita
y esperando —contra un origen fabricado con la forma del legacy— y cuáles necesitan el legacy
delante.

- [x] Conteo de filas coincide por cada tabla migrada. *(`verify`, RN-21.6. Y con una prueba de
      que **falla** cuando falta una fila: sin eso, `verify` podría ser una función que siempre
      dice que sí.)*
- [ ] El reporte mensual de un mes cerrado es idéntico celda a celda en ambos sistemas.
      ⚠️ **Es el criterio que ninguna herramienta puede cerrar**: exige generar el reporte del
      legacy, y el legacy es el que se está apagando. Se hace a mano, con los dos sistemas vivos,
      antes del corte. Lo que el migrador hace para que sea posible es rellenar `work_date` —el
      legacy no la tenía, y sin ella la agregación diaria no encuentra los marcajes y el mes
      migrado saldría vacío—.
- [x] Los totales de ajustes de nómina coinciden, incluidos los revertidos. *(`verify` compara la
      **suma**, no sólo el conteo, RN-21.4.)*
- [x] Ningún dato de las tablas ajenas (§3) entró en el sistema nuevo. *(La prueba siembra filas
      en `audit_logs` e `incidents` del otro sistema y comprueba que no llegan.)*
- [ ] Todos los usuarios pueden iniciar sesión tras el corte, con rol asignado en el IS.
      *(Depende del Identity Server, no de aquí. Lo que este lado garantiza es que ningún perfil
      entra sin identidad.)*
- [x] Ningún perfil quedó sin `identity_user_id` (RN-21.7). *(**Imposible de incumplir**: la
      columna es `not null`. Y el `plan` lo detecta antes de escribir, con la lista de correos
      delante.)*
- [ ] Los roles recreados en el IS coinciden uno a uno con los del legacy (RN-21.9). *(`user_roles`
      se lee como lista de referencia y no se migra; la comparación es en la consola del IS.)*
- [x] Las referencias cruzadas (revisores, orígenes de ajustes) resuelven correctamente. *(Es
      RN-21.5 y la prueba lo fija: un ajuste migrado sigue apuntando a la revisión que lo originó,
      y un perfil cuyo `id` y `user_id` eran distintos aparece con el que hace resolver todo lo
      demás.)*
- [ ] Existe un procedimiento de vuelta atrás documentado y probado. ⚠️ **Pendiente**, y es lo que
      más se echaría en falta a las tres de la mañana. Lo que sí está: la migración es repetible,
      así que se puede ensayar entera sobre una copia — que es la mitad de un plan de vuelta
      atrás; la otra mitad es un `pg_dump` antes de empezar y saber quién decide restaurarlo.

## 10. Decisiones abiertas

1. ~~Estrategia de corte.~~ **Cerrada: corte limpio**, con el legacy en sólo lectura un periodo de
   gracia. Las otras dos se quedaron sin sitio; ver §6.
2. **⚠️ Sigue abierta — ¿se reimplementa RLS en Postgres?** Es el riesgo número uno de la
   migración ([00](./00-migracion-datos-e-identidad.md) RN-00.1) y **la única decisión abierta que
   afecta a todo lo construido**. Lo que ha cambiado desde que se escribió: la mitigación que esa
   regla pedía —"ninguna funcionalidad se da por migrada sin su test de autorización"— está
   cumplida y **verificada fila por fila** en la [22](./22-calidad-y-deuda-tecnica.md) §3: cada
   endpoint con ámbito tiene su 403 comprobado con usuarios reales de cada rol. Eso no sustituye a
   una segunda barrera en la base, pero cambia la pregunta: ya no es "¿cómo compensamos la pérdida
   de RLS?" sino "¿hace falta además de esto?".
3. ~~¿Se migran los artefactos de reportes históricos o se regeneran?~~ **Cerrada: se regeneran.**
   Un XLSX del legacy trae **la matriz del legacy**, con sus columnas y sus códigos, así que
   conservarlo sería guardar un documento que ya no se puede reproducir. Los datos de los que sale
   sí se migran, y con ellos el reporte se vuelve a generar cuando haga falta
   ([16](./16-reporteria-mensual.md) RN-16.10).
4. **⚠️ Sigue abierta — ¿qué pasa con el otro sistema que comparte la base?** No la decide este
   proyecto: son sus tablas y su equipo. Lo que a esta migración le importa está resuelto — **de
   aquí no se lee ni una de ellas**— y lo que queda es una conversación: cuando este sistema deje
   de usar esa base, alguien tiene que decidir si el otro se queda solo en ella o también se muda.
5. **⚠️ Sigue abierta — ¿cómo se entregan las contraseñas temporales?**
   ([00](./00-migracion-datos-e-identidad.md) §B.1) Es de operación y de personas, no de código, y
   depende de una de las dos preguntas al equipo del Identity Server que la spec cero dejó
   pendientes: si el IS fuerza el cambio de contraseña al primer ingreso, la entrega puede ser en
   papel; si no, hace falta otra vía.
