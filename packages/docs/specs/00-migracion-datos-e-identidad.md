# 00 · Fundación: base de datos propia e identidad federada

> **Estado:** ❌ no iniciado. **Es la spec cero: condiciona a todas las demás.**
> **Origen:** decisión de proyecto (no viene de `old-docs.md`).
> **Referencia normativa de identidad:** [identity-server-usage.md](../identity-server-usage.md).
> **Relacionada con:** [21-migracion-desde-legacy](./21-migracion-desde-legacy.md) (el detalle
> tabla por tabla vive allí), [02](./02-usuarios-y-perfiles.md), [03](./03-roles-y-autorizacion.md),
> [04](./04-autenticacion.md).

Dos decisiones ya tomadas que dejan de ser discutibles y pasan a ser requisitos:

1. **La base de datos deja Supabase y pasa al contenedor de PostgreSQL del monorepo.**
2. **Todo lo relativo a usuarios, roles, autenticación y autorización se rige por el
   Identity Server de Elineas** (`elineas auth`), según
   [identity-server-usage.md](../identity-server-usage.md). **better-auth sale del proyecto.**

---

# Parte A — De Supabase al contenedor de PostgreSQL

## A.1 Dónde vive la base ahora

| Entorno | Dónde | Definido en |
|---|---|---|
| Desarrollo | Servicio `postgres` (`postgres:16-alpine`), volumen `pgdata`, publicado en el puerto `5434` del host sólo para herramientas | `docker-compose.yml` |
| Producción | Contenedor de PostgreSQL **compartido de Elineas**, alcanzado por la red externa `elineas-db`; base `elineas_control_asistencia` | `docker-compose.prod.yml` |

El backend habla con él por `DATABASE_URL` y es el **único** que lo toca: el frontend nunca
accede a la base ([architecture.md](../architecture.md)).

> ⚠️ En producción la instancia de PostgreSQL es **compartida con otros sistemas de Elineas**,
> igual que lo era la de Supabase (hallazgo H-2). La diferencia es que ahora la separación es
> por **base de datos**, no por esquema. Verificar que sea así y no volver a compartir `public`.

## A.2 Qué se pierde de Supabase y con qué se reemplaza

| Pieza de Supabase | Reemplazo en el monorepo | Spec |
|---|---|---|
| Postgres gestionado | Contenedor `postgres` / instancia de Elineas | esta |
| **Auth** | **Identity Server de Elineas** | Parte B |
| **RLS** (autoridad real de permisos) | **Nada equivalente**: la autorización pasa a los handlers de Hono | [03](./03-roles-y-autorizacion.md) §6 |
| PostgREST (`supabase.from(...)` desde el cliente) | API HTTP tipada con contratos en `packages/specs` | [api-conventions.md](../api-conventions.md) |
| Funciones SQL y triggers | Servicios de dominio en TypeScript | [21](./21-migracion-desde-legacy.md) §2 |
| Edge Functions (Deno, 8) | Rutas de Hono + procesos programados | [16](./16-reporteria-mensual.md), [19](./19-panel-superadmin.md) |
| Storage (`monthly-reports`, `app-releases`) | **Por decidir** (§A.5) | [16](./16-reporteria-mensual.md), [20](./20-app-movil-y-distribucion.md) |
| Realtime (`postgres_changes`) | SSE, WebSocket o sondeo | [14](./14-notificaciones.md) RN-14.4 |

- **RN-00.1 — La pérdida de RLS es el riesgo número uno de esta migración.** En Supabase, un
  fallo de autorización en el cliente lo atrapaba Postgres. Aquí no hay segunda barrera.
  Ninguna funcionalidad se da por migrada sin su test de autorización
  ([22](./22-calidad-y-deuda-tecnica.md) §3).

## A.3 El esquema no se migra: se redefine

- **RN-00.2** — El esquema destino se define **en Drizzle**, en el repositorio. No se importa
  el DDL de Supabase. Lo que se migra son **datos**, no estructura.
- **RN-00.3** — Todo cambio de esquema pasa por una migración de Drizzle versionada. Sin
  excepciones: el legacy ya sufrió deriva por SQL ejecutado a mano en producción
  ([21](./21-migracion-desde-legacy.md) §8).
- **RN-00.4** — No se replican triggers ni funciones SQL. La lógica que vivía en ellos
  (`validate_attendance_mark`, `handle_absence_review_payroll_impact`, `handle_new_user`,
  `enforce_gm_department`) pasa a servicios de dominio con tests.

## A.4 Procedimiento de extracción y carga

Tres etapas, cada una repetible y verificable por separado:

```
Supabase                 Postgres nuevo                    Postgres nuevo
(origen, sólo lectura)   esquema `legacy` (staging)        esquema `public` (Drizzle)
        │                          │                                │
        │  1. extraer              │  2. transformar                │  3. verificar
        └─────────────────────────►└───────────────────────────────►└──────────────►
           pg_dump --data-only        script TypeScript                informe
           con lista de tablas        idempotente                      de conteos
```

- **RN-00.5 — Lista blanca de tablas.** La extracción enumera explícitamente las tablas del
  producto. La base de Supabase contiene ~15 tablas de **otro sistema** (H-2), con nombres
  peligrosamente parecidos (`audit_logs` vs `audit_log`, `incidents` vs
  `attendance_incidents`). Nunca `pg_dump` completo.
- **RN-00.6 — Staging en el destino.** Los datos crudos se cargan primero en un esquema
  `legacy` dentro del PostgreSQL nuevo. Así la transformación se puede repetir sin volver a
  tocar Supabase, y se puede comparar origen y destino con una sola consulta.
- **RN-00.7 — Transformación idempotente.** Ejecutar el script dos veces produce el mismo
  resultado. Sin esto, un fallo a mitad obliga a empezar de cero.
- **RN-00.8 — Nada se carga sin informe previo.** El script corre en **simulación por
  defecto**: filas leídas, filas que entrarían, filas descartadas y por qué. La escritura es
  un paso explícito.
- **RN-00.9 — El esquema `legacy` se elimina** cuando la verificación pasa, y su eliminación
  queda registrada.
- **RN-00.10 — Los hechos diarios no se copian: se recalculan** desde los marcajes con las
  reglas nuevas. Es la mejor prueba de que las reglas se portaron bien
  ([16](./16-reporteria-mensual.md) RN-16.10).

El detalle de qué tabla va a dónde está en
[21-migracion-desde-legacy](./21-migracion-desde-legacy.md) §4.

## A.5 Almacenamiento de archivos — decisión pendiente

Supabase Storage desaparece y hay dos consumidores: los reportes mensuales (privados, con
enlace firmado) y el APK (público, hasta 200 MB).

| Opción | A favor | En contra |
|---|---|---|
| **(a)** Volumen del contenedor + rutas de descarga en Hono | Cero dependencias nuevas; los enlaces firmados los emite el propio backend | Los archivos viven en el servidor; hay que incluirlos en la copia de seguridad |
| **(b)** MinIO (S3 compatible) en el mismo compose | Enlaces firmados nativos, escala mejor | Un servicio más que operar |
| **(c)** S3/R2 gestionado | Nada que operar | Dependencia externa y coste |

**Recomendación: (a)** para arrancar. Los reportes se regeneran y el APK son unos pocos
archivos; no justifica un servicio de objetos. Reevaluar si el volumen crece.

## A.6 Verificación y vuelta atrás

- **RN-00.11** — La migración no está terminada hasta que **el reporte mensual de un mes
  cerrado sale idéntico celda a celda** en ambos sistemas
  ([21](./21-migracion-desde-legacy.md) RN-21.6).
- **RN-00.12** — Los totales de ajustes de nómina deben coincidir, incluidos los revertidos.
  Es historial económico ([17](./17-nomina.md)).
- **RN-00.13** — El legacy queda en **sólo lectura**, no se apaga, durante un periodo de
  gracia definido. La vuelta atrás es "volver a apuntar a Supabase", y por eso durante ese
  periodo no se escribe nada en el sistema viejo.

---

# Parte B — La UX de la migración: hacerla lo más simple posible

Este es un requisito de producto, no una nota operativa. Una migración técnicamente correcta
que obligue a 60 operarios a hacer trámites es una migración fallida.

Hay **dos usuarios** de esta migración y sus objetivos son distintos.

## B.1 Para la persona que usa el sistema — objetivo: una sola acción

**Meta medible: el empleado hace exactamente una cosa distinta el día del cambio, y una sola vez.**

Lo que **no** debe cambiar:

- **RN-00.14** — Misma dirección web y misma app. Si cambia la URL, se mantiene una
  redirección desde la vieja.
- **RN-00.15** — Mismo correo como identificador. Nadie se "registra de nuevo".
- **RN-00.16** — El historial propio (marcajes, vacaciones, incidencias) está visible desde el
  primer día. Un empleado que no ve su historial no confía en el sistema nuevo.
- **RN-00.17** — Los saldos de vacaciones se conservan exactos. Es la primera pantalla que
  todos van a revisar.

Lo que **sí** cambia inevitablemente:

> **La contraseña.** La identidad pasa al Identity Server (Parte B del documento, §C) y las
> contraseñas de Supabase no son reutilizables allí. No hay forma de evitarlo.

Opciones para que ese único cambio sea lo más barato posible:

| Opción | Qué hace el empleado | Requisito |
|---|---|---|
| **(a)** El admin crea las cuentas en el IS con una contraseña temporal, comunicada por el canal interno; el sistema obliga a cambiarla al primer ingreso | Iniciar sesión y elegir contraseña | Que el IS soporte "forzar cambio al primer ingreso" |
| **(b)** Enlace de establecimiento de contraseña enviado por correo | Abrir un correo y elegir contraseña | Que el IS envíe ese correo y que **todos** tengan correo operativo |
| **(c)** Contraseña inicial derivada de un dato conocido (documento de identidad) | Iniciar sesión | ❌ **No recomendado**: es una contraseña adivinable para toda la plantilla |

**Recomendación: (a).** En una operación de planta no todo el mundo revisa su correo, pero sí
recibe una indicación de su jefe. La (b) queda como alternativa para el personal
administrativo.

✅ **El IS permite alta masiva de usuarios.** Confirmado. Las cuentas de toda la plantilla se
crean en un solo paso a partir del listado que salga del legacy, así que el emparejamiento
por correo (§C.6, [21](./21-migracion-desde-legacy.md) §5) es un trámite, no un cuello de
botella. Esto abarata la opción (a): la contraseña temporal se genera y se entrega junto con
la carga masiva.

> ⚠️ **Dos preguntas todavía por confirmar con el equipo del Identity Server**, de las que
> depende cuál de las tres opciones es viable:
> 1. ¿Soporta forzar cambio de contraseña en el primer ingreso? *(Necesario para (a).)*
> 2. ¿Tiene recuperación de contraseña autoservicio? *(Necesario para (b), y para el día a día
>    después de la migración — en planta se olvidan contraseñas todas las semanas.)*
>
> La documentación de integración no cubre ninguno de los dos puntos. Si la respuesta a (1) es
> no, la contraseña temporal queda vigente hasta que cada quien la cambie por su cuenta:
> aceptable a corto plazo, pero hay que saberlo antes del corte.

Acompañamiento:

- **RN-00.18** — Aviso dentro del sistema legacy los días previos, con la fecha del cambio.
- **RN-00.19** — Instructivo de **una página** con capturas: cómo entrar la primera vez.
- **RN-00.20** — Corte en día no laborable, para que nadie se encuentre el cambio a mitad de
  turno con la fila de fichaje esperando.
- **RN-00.21** — El primer inicio de sesión muestra una pantalla breve de bienvenida que
  explica qué cambió y confirma que el historial sigue ahí.

## B.2 Para quien ejecuta la migración — objetivo: tres comandos

- **RN-00.22** — La migración es un **script del repositorio**, no una secuencia de pasos en
  `psql`. Lo que se hace a mano no se puede repetir ni auditar.
- **RN-00.23** — Interfaz mínima:

  ```
  bun run migrate:legacy extract    # Supabase → esquema `legacy` (sólo lectura en origen)
  bun run migrate:legacy load       # `legacy` → `public`; simulación por defecto, --commit para escribir
  bun run migrate:legacy verify     # informe de conteos y comparación de reportes
  ```

- **RN-00.24** — `verify` es la única fuente de verdad sobre si la migración terminó. Su
  salida es legible por una persona, no un volcado de registros.
- **RN-00.25** — El script se ejecuta primero contra una copia, en un entorno de prueba, y ese
  ensayo es obligatorio antes del corte real.

## B.3 Definición de "simple" — criterios medibles

| Criterio | Objetivo |
|---|---|
| Acciones distintas que hace un empleado | **1** (elegir contraseña al primer ingreso) |
| Empleados que necesitan soporte para entrar | < 10 % |
| Comandos que ejecuta el operador | ≤ 3 |
| Duración de la ventana de corte | ≤ 4 h |
| Datos históricos perdidos | **0** |
| Pasos manuales en base de datos | **0** |

---

# Parte C — Identidad: Identity Server de Elineas

> **Fuente normativa:** [identity-server-usage.md](../identity-server-usage.md).
> Esta sección fija cómo se aplica a este producto; ante cualquier diferencia, manda el
> documento de integración.

## C.1 La decisión

**Todo lo relativo a usuarios, roles, autenticación y autorización se rige por el Identity
Server (IS) de Elineas.** Consecuencias inmediatas:

- **RN-00.26** — **better-auth se retira del proyecto.** Se elimina `apps/backend/src/lib/auth.ts`
  y las variables `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET`.
- **RN-00.27** — **Este sistema no almacena contraseñas** ni las verifica. Tampoco emite ni
  restablece credenciales.
- **RN-00.28** — **No existe auto-registro.** El alta de usuarios no es autoservicio: sólo un
  administrador crea cuentas, en la consola del IS. Esto **anula** el registro público del
  legacy ([04](./04-autenticacion.md) RN-04.1 y RN-04.2).
- **RN-00.29** — **La tabla `user_roles` desaparece de nuestra base.** Los roles viven en el
  IS, por sistema.

## C.2 Reparto de responsabilidades

| Vive en el Identity Server | Vive en nuestra base |
|---|---|
| Identidad (usuario, correo, nombre, contraseña) | Perfil de negocio: departamento, teléfono, sueldo, estado de la cuenta |
| Sesiones y tokens | `user_department_responsibilities` (multi-departamento) |
| **Roles del usuario en este sistema** | Mapeo rol → permisos y ámbito ([03](./03-roles-y-autorizacion.md)) |
| Alta, baja y reseteo de credenciales | Desactivación **operativa** del perfil (`is_active`) |

- **RN-00.30 — Un perfil desactivado no entra.** La desactivación del perfil **corta el acceso
  a este sistema**: aunque el IS autentique correctamente, el backend no abre sesión aquí. Ver
  el flujo en [04](./04-autenticacion.md) §4.1 y RN-04.4.
  Aun así **son dos bajas distintas y ambas deben existir**: desactivar el perfil saca a la
  persona *de este sistema* y conserva su historial; quitarle el rol o deshabilitar la cuenta
  en el IS la saca *de todos los sistemas de Elineas*. La UI de gestión debe dejar claro cuál
  está haciendo el administrador.

## C.3 Registro del sistema en el IS

- **RN-00.31 — `systemSlug` propuesto: `control-asistencia`.** Se fija en configuración
  (`SYSTEM_SLUG`), nunca escrito a mano en varios sitios.
- **RN-00.32 — Roles a crear en la consola del IS**, con los mismos nombres que usa
  [03-roles-y-autorizacion](./03-roles-y-autorizacion.md):
  `employee` · `department_head` · `global_manager` · `superadmin`.
  La **prioridad** entre ellos sigue siendo lógica nuestra (RN-03.1): el IS entrega una lista,
  no una jerarquía.
- **RN-00.33 — Sin rol asignado, el login se rechaza con 403.** Consecuencia operativa: un
  empleado nuevo **no puede entrar** hasta que un administrador le asigne un rol en el IS.
  El alta pasa a ser de **dos pasos** (cuenta+rol en el IS, perfil en este sistema) y eso hay
  que resolverlo en la UX de gestión de usuarios — ver §C.7.
- **RN-00.34 — CORS:** los orígenes del frontend (desarrollo y producción) deben añadirse a
  `ALLOWED_ORIGIN` en el IS o el navegador bloqueará las peticiones.

## C.4 Flujo de autenticación

```
navegador ──► NUESTRO backend (Hono) ──► Identity Server
              guarda cookies httpOnly    POST /api/auth/sign-in
              session + jwt              { email, password, systemSlug }
```

- **RN-00.35 — El navegador nunca llama directo al IS.** Siempre a través de nuestro backend,
  que es quien recibe y custodia los tokens.
- **RN-00.36 — Dos tokens con roles distintos:**
  - **session token** — larga duración (días), llega en la cabecera `set-auth-token` de la
    respuesta de login. **Trátalo como una contraseña**: sólo en cookie `httpOnly`, jamás
    accesible al JavaScript del navegador.
  - **JWT** — ~15 minutos, prueba identidad. Se verifica **localmente** contra el JWKS
    (`GET /api/auth/jwks`) con `jose`, sin llamar al IS en cada petición.
- **RN-00.37 — Renovación.** JWT expirado se renueva con `GET /api/auth/token` usando el
  session token. Debe ser transparente: el usuario no vuelve a ver el login cada 15 minutos.
- **RN-00.38 — Cierre de sesión.** `POST /api/auth/sign-out` con el session token **y** limpieza
  de nuestras cookies. Sin lo primero, la sesión sigue viva en el IS.
  Lo mismo aplica cuando **rechazamos** un login por perfil desactivado (RN-00.30): si el IS ya
  emitió tokens, hay que revocarlos antes de responder el error. No dejar sesiones huérfanas
  vivas en el IS por cada intento de alguien desactivado.
- **RN-00.39 — El JWT prueba identidad, no permisos.** **Nunca** autorizar con un
  `payload.role`: no está garantizado.

## C.5 Autorización

- **RN-00.40** — Los permisos se obtienen de `GET /api/user-roles/me?systemSlug=control-asistencia`
  con el **session token** como Bearer (no con el JWT).
- **RN-00.41 — Caché por sesión.** Consultar el IS en cada petición añade un viaje de red a
  todo. Los roles se cachean por sesión con TTL corto (propuesta: 5 min) y se invalidan al
  cerrar sesión. **Decisión abierta:** el TTL define cuánto tarda en aplicarse un cambio de
  rol hecho en la consola del IS.
- **RN-00.42 — Degradación si el IS no responde.** Sin IS no hay logins nuevos. Las sesiones
  con JWT válido siguen ~15 min. **Decisión abierta:** ¿se sirven los roles cacheados
  mientras el IS esté caído (la gente sigue fichando) o se bloquea todo (más seguro)?
  Para un sistema de fichaje en planta, inclinarse por lo primero con un límite de tiempo.
- **RN-00.43 — El ámbito sigue siendo nuestro.** El IS dice *qué rol* tiene alguien; qué
  departamentos gestiona y qué puede ver dentro de ellos lo resuelve
  [03-roles-y-autorizacion](./03-roles-y-autorizacion.md) §5 con nuestros datos.

## C.6 Vínculo entre la identidad del IS y nuestro perfil

- **RN-00.44** — `profiles.identity_user_id` guarda el `sub` del JWT (id de usuario en el IS),
  único y no nulo. **Sustituye a `user_id`** de la spec [02](./02-usuarios-y-perfiles.md).
- **RN-00.45** — El correo se guarda como dato de contacto y para la migración, pero **la
  clave de vínculo es el `sub`**, no el correo: un correo puede cambiar.
- **RN-00.46 — Provisión del perfil al primer ingreso.** Si un usuario autenticado en el IS no
  tiene perfil aquí, se crea uno en el primer acceso, **incompleto** (sin departamento), y el
  sistema lo dirige a una pantalla de "cuenta pendiente de configurar" mientras un
  administrador le asigna departamento. No se le deja marcar hasta entonces.
  *Alternativa: prohibir el acceso hasta que exista el perfil. Más estricto, peor UX.*
  **Decisión abierta.**
- **RN-00.47 — En la migración, el vínculo se resuelve por correo**, una sola vez, y se
  verifica que **todos** los perfiles queden emparejados. Un perfil sin `identity_user_id`
  es un empleado que no podrá entrar: la migración no termina con ninguno pendiente.

## C.7 Impacto en la gestión de usuarios

> ✅ **Decidido: el alta de usuarios se hace en el Identity Server.** Esta aplicación **no**
> crea cuentas, ni por consola propia ni llamando a la API del IS. No es una limitación
> temporal a la espera de una API: es el reparto de responsabilidades.

La pantalla de gestión de usuarios ([02](./02-usuarios-y-perfiles.md) §7) **cambia de
naturaleza**: deja de crear cuentas y pasa a completar perfiles.

| Antes (legacy) | Ahora |
|---|---|
| Crear usuario con correo y contraseña | El admin crea la cuenta y asigna rol **en la consola del IS** |
| Asignar rol desde la app | El rol se asigna en el IS; la app sólo lo lee |
| Resetear contraseña desde la app | Se hace en el IS |
| Editar departamento, teléfono, sueldo | **Sigue aquí** |
| Desactivar/reactivar a alguien en este sistema | **Sigue aquí** (RN-00.30) |

- **RN-00.48** — La app debe **decirlo, no fallar en silencio**: donde antes había un botón de
  "crear usuario", ahora va una explicación y un enlace a la consola del IS.
- **RN-00.49** — Debe existir una vista de **perfiles incompletos** (usuarios que entraron sin
  departamento asignado), porque es la consecuencia directa del alta en dos pasos y sin ella
  se pierden personas por el camino.

> ⚠️ **Consecuencia a tener presente:** el alta queda **repartida entre dos herramientas y
> posiblemente dos personas**. Quien administra el IS puede no ser quien gestiona la
> asistencia. Si el administrador del IS crea la cuenta y nadie completa el perfil aquí, la
> persona entra y no puede marcar. La vista de RN-00.49 es lo que evita que eso pase
> inadvertido, y conviene que además notifique a los gestores cuando aparece un perfil nuevo
> sin departamento.

## C.8 Configuración

| Variable | Dónde | Valor |
|---|---|---|
| `AUTH_API_URL` | backend | URL base del IS (p. ej. `https://auth.elineas.com`) |
| `SYSTEM_SLUG` | backend | `control-asistencia` |
| ~~`BETTER_AUTH_URL`~~ | — | **eliminar** |
| ~~`BETTER_AUTH_SECRET`~~ | — | **eliminar** |

## C.9 Decisiones abiertas de identidad

1. **¿Quién habla con el IS: el backend de Hono o las funciones de servidor de TanStack
   Start?** La documentación trae ejemplos de ambos. Coherente con
   [architecture.md](../architecture.md) (el backend es dueño de la autenticación) →
   **recomendación: Hono**. Pero implica cookies cross-origin entre `:3004` y `:3001`, que ya
   obligaron a `sameSite: "none"`.
2. **Cookies httpOnly y app móvil.** En un WebView o cliente nativo el patrón de cookies no
   aplica igual. **Esta decisión está atada a [20-app-movil-y-distribucion](./20-app-movil-y-distribucion.md) §2**
   y hay que resolverlas juntas.
3. TTL de la caché de roles (RN-00.41) y comportamiento con el IS caído (RN-00.42).
4. Provisión del perfil al primer ingreso (RN-00.46).
5. ¿Se exige segundo factor para `superadmin`? Depende de lo que ofrezca el IS.
6. ¿Cómo se entera un gestor de asistencia de que se dio de alta a alguien en el IS? (§C.7)

**Ya resueltas:** el alta es exclusivamente por el IS (§C.7) · un perfil desactivado no puede
autenticarse aquí (RN-00.30) · el IS permite alta masiva (§B.1).

---

## Criterios de aceptación de esta spec

**Base de datos**

- [ ] El sistema arranca contra el contenedor de PostgreSQL sin ninguna dependencia de Supabase.
- [ ] No queda ninguna referencia a Supabase en código, configuración ni variables de entorno.
- [ ] El esquema completo está descrito por migraciones de Drizzle en el repositorio.
- [ ] `migrate:legacy verify` pasa: conteos iguales y reporte mensual idéntico celda a celda.
- [ ] Ninguna tabla del otro sistema (H-2) entró en la base nueva.
- [ ] Los totales de nómina coinciden con el sistema anterior.

**UX de la migración**

- [ ] Un empleado sólo tiene que elegir contraseña la primera vez; nada más.
- [ ] El historial y el saldo de vacaciones están visibles desde el primer ingreso.
- [ ] El ensayo completo de la migración se ejecutó sobre una copia antes del corte real.
- [ ] La migración se ejecuta con los tres comandos de §B.2, sin pasos manuales.

**Identidad**

- [ ] No existe better-auth en el proyecto ni tabla de contraseñas.
- [ ] El login funciona contra el IS con `systemSlug = control-asistencia`.
- [ ] Un usuario sin rol en el sistema recibe el rechazo del IS con un mensaje comprensible,
      no un error genérico.
- [ ] El JWT se verifica localmente contra el JWKS, sin llamar al IS en cada petición.
- [ ] El JWT caducado se renueva solo, sin que el usuario vuelva a autenticarse.
- [ ] La autorización usa los roles de `/api/user-roles/me`, nunca un campo del JWT.
- [ ] El cierre de sesión revoca en el IS **y** limpia las cookies locales.
- [ ] **Un usuario con el perfil desactivado no obtiene sesión aquí**, aunque sus credenciales
      del IS sean correctas, y ve "cuenta desactivada" (RN-00.30).
- [ ] Ese rechazo **revoca en el IS** los tokens que se hubieran emitido (RN-00.38).
- [ ] Reactivar el perfil devuelve el acceso sin ninguna intervención en el IS.
- [ ] Ningún perfil queda sin `identity_user_id` tras la migración.
- [ ] El session token nunca es accesible desde el JavaScript del navegador.
- [ ] La aplicación no expone ninguna forma de crear cuentas (§C.7).
