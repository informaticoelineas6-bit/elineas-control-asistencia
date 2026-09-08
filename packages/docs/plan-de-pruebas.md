# Plan de pruebas manuales — Control de Asistencia ELINEAS

> Cobertura funcional completa, spec por spec (de la [00](../specs/00-migracion-datos-e-identidad.md)
> a la [22](../specs/22-calidad-y-deuda-tecnica.md)), probando cada funcionalidad con **cada uno de
> los cuatro roles** del sistema. Se basa en las reglas de negocio (`RN-xx.x`), los criterios de
> aceptación y las trampas señaladas (⚠️) de `packages/specs/`. Cuando una spec o una regla cambie,
> este documento debe revisarse junto con ella.

## Cómo usar este documento

- Cada caso de prueba es una casilla `- [ ]`. Márcala al ejecutarla; anota fecha, build y evidencia
  (captura, request/response) en el sistema de seguimiento que use el equipo — este archivo es el
  guion, no el registro de ejecución.
- El rol entre paréntesis al inicio de cada caso es **con qué usuario** hay que iniciar sesión para
  probarlo. Cuando un caso dice "(rol) → 403", el objetivo de la prueba es justamente comprobar que
  se **deniega**, no un fallo de la prueba.
- Los casos marcados ⚠️ vienen de una trampa o error ya conocido en el legacy: si reaparecen, es una
  regresión, no un hallazgo nuevo.
- Los casos marcados **[bloqueado]** dependen de una spec que en el momento de escribir esta lista
  aún no estaba construida; revisar el estado real en `packages/specs/README.md` antes de descartar
  el caso.
- "no aplica / sin acceso" en la matriz de un rol significa: probar explícitamente que ese rol
  **no** tiene la capacidad (habitualmente un 403), no que se pueda omitir la prueba.

## Los cuatro roles

| Prioridad | Rol | Alcance en una frase |
|---|---|---|
| 1 | `employee` | Marca su asistencia, ve su propio historial, pide vacaciones, configura sus descansos, crea incidencias. |
| 2 | `department_head` | Todo lo del empleado + gestiona su departamento y los adicionales asignados. |
| 3 | `global_manager` | No marca asistencia. Panel global, configuración, usuarios, departamentos, reportería global, nómina. |
| 4 | `superadmin` | Todo lo anterior + bitácora global, panel de superadmin, importación de histórico, modo mantenimiento, borrado real. |

Para cada prueba conviene tener **una cuenta real por rol** (no simulada con `?ui=`), porque
`?ui=` sólo cambia el envoltorio visual y nunca otorga permisos (spec 05, RN-05.2/05.3).

## Orden de ejecución sugerido

El mismo orden de construcción del índice de specs — cada bloque depende del anterior, así que
probarlo en este orden evita bloqueos falsos por falta de datos previos (departamento sin horario,
usuario sin sede, etc.):

```
00 (fundación)  →  01 → 02 → 03 → 04 → 05 (cimientos)  →  06 (config)
07 → 08 → 10 (marco de validez de un marcaje)  →  09 (núcleo: marcaje)
11 → 12 → 13 (excepciones)  →  15 → 16 (agregación y reportes)
17 (nómina)  →  14 · 18 (transversales)  →  19 (plataforma)
21 · 22 (se leen antes de empezar, pero se verifican al final del ciclo de release)
```

---

## Índice

| # | Spec | # | Spec |
|---|---|---|---|
| [00](#00--fundación-base-de-datos-propia-e-identidad-federada) | Fundación: identidad federada | [12](#12--incidencias-de-asistencia) | Incidencias de asistencia |
| [01](#01--organización-departamentos) | Organización: departamentos | [13](#13--justificación-de-ausencias) | Justificación de ausencias |
| [02](#02--usuarios-y-perfiles) | Usuarios y perfiles | [14](#14--notificaciones) | Notificaciones |
| [03](#03--roles-y-autorización) | Roles y autorización | [15](#15--agregación-diaria-dashboard-y-paneles-de-gestión) | Agregación, dashboard y paneles |
| [04](#04--autenticación-y-sesión) | Autenticación y sesión | [16](#16--reportería-mensual) | Reportería mensual |
| [05](#05--shells-de-interfaz-y-navegación) | Shells de interfaz y navegación | [17](#17--nómina-ajustes-y-descuentos) | Nómina: ajustes y descuentos |
| [06](#06--configuración-global) | Configuración global | [18](#18--bitácora-de-auditoría) | Bitácora de auditoría |
| [07](#07--horarios-por-departamento-y-calendario-laboral) | Horarios y calendario laboral | [19](#19--panel-de-superadmin) | Panel de superadmin |
| [08](#08--sedes-geocerca-y-geolocalización) | Sedes, geocerca y geolocalización | [21](#21--migración-desde-el-sistema-legacy-transversal) | Migración desde el legacy |
| [09](#09--marcaje-de-asistencia-núcleo-del-producto) | Marcaje de asistencia (núcleo) | [22](#22--calidad-pruebas-y-deuda-técnica-transversal) | Calidad, pruebas y deuda técnica |
| [10](#10--descansos) | Descansos | | |
| [11](#11--vacaciones) | Vacaciones | | |

> La spec 20 (app móvil Android) se retiró — ver `packages/specs/README.md`. No tiene bloque propio.

---

## 00 · Fundación: base de datos propia e identidad federada

Spec fundacional/infraestructura — se prueba a nivel de sistema, no por rol.

- [ ] La aplicación funciona por completo contra el PostgreSQL propio, sin ninguna llamada residual
      a Supabase ni a `better-auth` (revisar red y variables de entorno).
- [ ] Ciclo completo de login → sesión → renovación → logout contra el Identity Server (IS): cookies
      httpOnly, JWT verificado contra el JWKS del IS, roles obtenidos siempre de
      `GET /api/user-roles/me` (nunca leídos del JWT).
- [ ] Un perfil desactivado no obtiene sesión aquí aunque el IS valide sus credenciales, y ese
      rechazo revoca los tokens ya emitidos en el IS.
- [ ] El proceso de migración (`extract` / `load` / `verify`) es repetible, `load` simula por
      defecto, y produce paridad exacta de datos, saldos de vacaciones, historial y reportes
      mensuales cerrados frente al legacy.
- [ ] ⚠️ Ninguna tabla ajena al sistema (homónima incluida) entra en la migración, y ningún perfil
      queda sin `identity_user_id` (detalle ampliado en la [spec 21](#21--migración-desde-el-sistema-legacy-transversal)).

---

## 01 · Organización: departamentos

Gestionar el departamento como ancla organizativa, incluida la posibilidad de pausar el marcaje de
todos sus miembros.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Ver lista de departamentos | ✅ | ✅ | ✅ | ✅ |
| Ver detalle / miembros | ❌ (403) | ✅ sólo su ámbito | ✅ todos | ✅ todos |
| Crear / renombrar / eliminar | ❌ | ❌ | ✅ | ✅ |
| Pausar / reanudar | ❌ | ❌ | ✅ | ✅ |
| Activar `rest_groups_enabled` | ❌ | ❌ | ✅ | ✅ |

### Casos de prueba

- [ ] **01.1** (employee) `GET /departments` → lista; `GET /departments/:id` o `/members` de un
      departamento ajeno → 403.
- [ ] **01.2** (department_head) `GET /departments/:id/members` de su propio departamento → 200; de
      uno fuera de ámbito → 403.
- [ ] **01.3** (global_manager) Crear departamento con nombre duplicado (aunque cambie mayúsculas,
      ej. "Transporte" vs "transporte") → rechazado.
- [ ] **01.4** (global_manager) Crear departamento con `name` vacío → rechazado.
- [ ] **01.5** (global_manager) Eliminar un departamento con al menos un perfil asociado (activo o
      inactivo) → 409, no borra en cascada.
- [ ] **01.6** (global_manager) Eliminar un departamento con horario configurado → 409; usar antes
      `DELETE /departments/:id/schedule`.
- [ ] **01.7** (global_manager) Eliminar un departamento con grupos de descanso asociados → 409, sin
      cascada.
- [ ] **01.8** (global_manager) Eliminar el departamento configurado como `global_manager_department_id`
      → bloqueado mientras la configuración apunte a él.
- [ ] **01.9** (global_manager) Eliminar un departamento sin miembros/horario/grupos/responsabilidades
      pendientes → éxito; sus filas de calendario laboral sí se eliminan en cascada.
- [ ] **01.10** (global_manager) Pausar un departamento sin `reason` → rechazado (motivo obligatorio).
- [ ] **01.11** (global_manager) Pausar con motivo → `is_paused=true`, `pause_reason` y `paused_at`
      quedan seteados; se audita con actor, motivo y estado anterior; se notifica a los miembros
      activos.
- [ ] **01.12** **[bloqueado por spec 09]** (employee del depto pausado) Intentar marcar → rechazado
      con el motivo de la pausa.
- [ ] **01.13** La pausa NO afecta vacaciones, incidencias ni consulta de historial.
- [ ] **01.14** (global_manager) Reanudar un departamento → `is_paused=false`, campos limpios, no
      recupera retroactivamente los marcajes bloqueados; se notifica a miembros.
- [ ] **01.15** **[bloqueado por spec 09]** (employee) Tras reanudación, puede marcar de inmediato.
- [ ] **01.16** Cambiar `rest_groups_enabled` de `true` a `false` → los grupos existentes NO se
      borran, sólo dejan de usarse; la UI debe advertirlo.
- [ ] **01.17** El listado de departamentos muestra un badge "En pausa" + motivo en los pausados.
- [ ] **01.18** Ningún endpoint de esta spec (lista, detalle, miembros) devuelve `monthly_salary`, ni
      siquiera al consumirlo un `department_head`.
- [ ] **01.19** ⚠️ No debe existir semilla de departamentos del legacy: un sistema recién instalado
      está vacío y la UI lo dice explícitamente.
- [ ] **01.20** ⚠️ El departamento de gestores globales se identifica por `global_manager_department_id`
      (id), no por el nombre "Administración"; renombrarlo no debe romper nada.

---

## 02 · Usuarios y perfiles

Gestionar el perfil de negocio (departamento, contacto, estado operativo) separado de la identidad
del IS, y su ciclo de vida (incompleto / activo / desactivado / contrato cancelado).

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Ver/editar su propio perfil (contacto) | ✅ | ✅ | ✅ | ✅ |
| Ver perfiles ajenos | ❌ | ✅ su ámbito | ✅ todos | ✅ todos |
| Cambiar depto de otro / desactivar / reactivar | ❌ | ❌ | ✅ | ✅ |
| Ver / editar `monthly_salary` | ❌ | ❌ | ✅ | ✅ |
| Crear usuario / resetear contraseña | ❌ (se hace en el IS) | ❌ | ❌ | ❌ |
| Borrado real del perfil | ❌ | ❌ | ❌ | ✅ |

### Casos de prueba

- [ ] **02.1** Primer ingreso de una identidad nueva del IS → crea exactamente un perfil, incompleto
      (sin `department_id`).
- [ ] **02.2** Un perfil incompleto no puede marcar asistencia y ve "cuenta pendiente de configurar".
- [ ] **02.3** (global_manager) `GET /users/incomplete` lista perfiles sin departamento; aparece
      notificación a los gestores cuando surge uno nuevo.
- [ ] **02.4** Crear un segundo perfil con el mismo `identity_user_id` → rechazado (único).
- [ ] **02.5** (employee) `PATCH /me` con datos de contacto → éxito; intentar cambiar su propio
      departamento o salario vía `/me` → rechazado/ignorado.
- [ ] **02.6** (department_head) `GET /users` → sólo perfiles de sus departamentos gestionados,
      filtrado en la consulta; pedir explícitamente otro departamento → 403, no lista vacía.
- [ ] **02.7** (employee) `GET /users` o `/users/:id` de otro → 403.
- [ ] **02.8** (global_manager) Desactivar un perfil sin `deactivation_reason` → rechazado.
- [ ] **02.9** (global_manager) Desactivar con motivo → `is_active=false`, `deactivated_at/by`
      seteados; la sesión activa de esa persona se corta en su siguiente request.
- [ ] **02.10** Un perfil desactivado no puede iniciar sesión aunque el IS valide credenciales; su
      historial sigue visible a quien tenga ámbito.
- [ ] **02.11** (global_manager) Reactivar un perfil → limpia los campos de desactivación, el acceso
      se recupera sin tocar el IS.
- [ ] **02.12** `contract_cancelled_at` se puede fijar independientemente de `is_active` (probar las
      cuatro combinaciones).
- [ ] **02.13** `last_connection_at` no se escribe más de una vez cada 5 minutos por sesión — hacer
      varios requests seguidos y verificar el throttle.
- [ ] **02.14** (superadmin) Borrar un perfil con `is_active=true` → rechazado (debe estar desactivado
      primero).
- [ ] **02.15** (superadmin) Borrar un perfil desactivado → éxito, sin romper integridad referencial.
- [ ] **02.16** (global_manager/superadmin) `PATCH /users/:id` cambia departamento; los marcajes y
      reportes pasados conservan el departamento vigente en su momento.
- [ ] **02.17** Ningún endpoint accesible a `employee` o `department_head` (listado, detalle,
      `GET /me`) devuelve `monthly_salary` en el cuerpo crudo.
- [ ] **02.18** `PATCH /users/:id` NO acepta ni devuelve el sueldo; éste sólo viaja por
      `GET`/`PUT /users/:id/compensation`.
- [ ] **02.19** (global_manager) `PUT /users/:id/compensation` sin moneda → rechazado; probar
      monedas válidas (CUP, USD, EUR, MLC, TRO, CLA) y una inválida.
- [ ] **02.20** Cambio de compensación queda en bitácora con valor anterior, nuevo y moneda.
- [ ] **02.21** ⚠️ No existe `POST /users` ni reset de contraseña en esta app — la UI explica que el
      alta se hace en el IS, sin un botón que falle en silencio.
- [ ] **02.22** Asignar departamento a un perfil incompleto notifica a la persona (alta cerrada).

---

## 03 · Roles y autorización

Definir el rol efectivo y el ámbito de cada usuario, con el servidor como única autoridad de
autorización.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Ámbito | propios recursos | su depto + adicionales | global (salvo marcaje) | global total |
| Gestionar responsabilidades de departamento | ❌ | ❌ (sólo las recibe) | ✅ | ✅ |

### Casos de prueba

- [ ] **03.1** Usuario con roles `employee` + `department_head` en el IS → el rol efectivo resuelto
      es `department_head`.
- [ ] **03.2** `department_head` con un departamento adicional en `user_department_responsibilities`
      → ve datos de ambos departamentos.
- [ ] **03.3** (employee) Llamar a un endpoint de ámbito departamental → 403, aunque la UI nunca lo
      hubiera ofrecido.
- [ ] **03.4** **[verificar con spec 09]** (global_manager) Intentar registrar un marcaje → rechazado
      con `ROLE_CANNOT_MARK`.
- [ ] **03.5** Usuario del IS sin ningún rol asignado en `control-asistencia` → login rechazado con
      403.
- [ ] **03.6** (global_manager) Al resolver sesión, si `global_manager_department_id` está
      configurado, el perfil se fuerza a ese departamento; si no, la regla queda desactivada; el
      cambio se audita con actor `null`.
- [ ] **03.7** (global_manager) `PUT /users/:id/department-responsibilities` con la lista completa →
      reemplaza el conjunto entero (no añade); una sola entrada de auditoría con antes/después.
- [ ] **03.8** Enviar en ese `PUT` el departamento propio del usuario → se descarta en silencio.
- [ ] **03.9** (department_head/employee) Llamar a `PUT /users/:id/department-responsibilities` →
      403.
- [ ] **03.10** Ningún endpoint de autorización lee `payload.role` del JWT — auditar que los roles
      siempre salen de `/api/user-roles/me` con el session token.
- [ ] **03.11** Cambiar el rol de un usuario en la consola del IS → se refleja aquí como máximo tras
      el TTL de la caché de roles; probar antes y después del TTL.
- [ ] **03.12** Verificar explícitamente que existen tests de autorización también en `/config`,
      `/me` y `/notifications` (gap señalado por la propia spec como pendiente).
- [ ] **03.13** ⚠️ La comprobación de ámbito usa una única función tipada reutilizada en todos los
      endpoints, no repetida por endpoint (evitar el bug histórico de argumentos invertidos, H-1).
- [ ] **03.14** Verificar la matriz de ámbito por recurso completa (marcajes/incidencias/vacaciones/
      descansos: propios → ámbito → todos; reportes: nada → ámbito → global; config y nómina: sólo
      global_manager+; bitácora: sólo superadmin).

---

## 04 · Autenticación y sesión

Inicio, renovación y cierre de sesión contra el Identity Server, con cookies httpOnly.

### Qué puede hacer cada rol

Mismo flujo para los cuatro roles; sólo cambia la redirección post-login (según shell/rol) y si se
fuerza selección de sede (todos excepto `global_manager`, que no marca).

### Casos de prueba

- [ ] **04.1** Login con credenciales válidas y rol asignado → 200, cookies `session` (httpOnly,
      larga duración) y `jwt` (~15 min) con `Secure; SameSite=None`.
- [ ] **04.2** Login con credenciales inválidas → 401 "credenciales inválidas".
- [ ] **04.3** Login de usuario autenticado en el IS pero SIN rol en este sistema → 403 con mensaje
      específico ("pide a tu administrador que te asigne un rol"), nunca "credenciales inválidas".
- [ ] **04.4** Login de usuario con perfil `is_active=false` → rechazado antes de fijar cookies,
      "cuenta desactivada"; se revocan en el IS los tokens ya emitidos.
- [ ] **04.5** Login de identidad nueva sin perfil → la sesión se abre pero no puede marcar hasta que
      se le asigne departamento.
- [ ] **04.6** El navegador nunca llama directo al IS — todas las llamadas pasan por el backend
      propio.
- [ ] **04.7** El JWT expira (~15 min) → la siguiente petición lo renueva automáticamente, sin
      mostrar login de nuevo.
- [ ] **04.8** Logout → llama a sign-out en el IS con el session token Y limpia las cookies locales.
- [ ] **04.9** Logout limpia también el estado local: sede seleccionada, caché de queries,
      preferencias de shell.
- [ ] **04.10** Desactivar a alguien con sesión abierta lo expulsa en su siguiente request (403 +
      limpieza de cookies), sin esperar a un nuevo login.
- [ ] **04.11** Las cookies de sesión y JWT son httpOnly — el JavaScript del navegador no puede
      leerlas (inspeccionar en devtools).
- [ ] **04.12** "Recordar credenciales" NO se ofrece en navegador, sólo estaría disponible en un
      runtime nativo.
- [ ] **04.13** Provocar un error del IS y verificar que el mensaje se traduce al español antes de
      mostrarse, nunca texto crudo en inglés.
- [ ] **04.14** `last_connection_at` se actualiza throttlado (máx. 1 vez/5 min por sesión) al
      autenticarse.
- [ ] **04.15** Recargar la página estando autenticado → no hay parpadeo de redirección al login.
- [ ] **04.16** **[verificar con spec 09]** (global_manager) Navegar a `/clock-in` → redirigido, no
      pantalla vacía.
- [ ] **04.17** Guard de rutas: `allowedRoles` y `excludedRoles` combinados — `/clock-in` excluye a
      `global_manager` aunque tenga mayor prioridad.
- [ ] **04.18** ⚠️ El guard NO se resuelve en `beforeLoad` de SSR (las cookies no son visibles ahí)
      sino en cliente — no debe haber un falso "no autenticado" en el primer render de servidor.
- [ ] **04.19** No hay ninguna referencia residual a `better-auth` en el proyecto (código, env vars).
- [ ] **04.20** Un usuario sin departamento asignado ve, tras el login, una pantalla que explica por
      qué su cuenta está pendiente.

---

## 05 · Shells de interfaz y navegación

Resolver qué envoltura de navegación (EmployeeShell vs AdminShell) se muestra según viewport y rol,
sin afectar los permisos reales.

### Qué puede hacer cada rol

| Rol | Móvil (&lt;768px) | Escritorio |
|---|---|---|
| employee | EmployeeShell | AdminShell |
| department_head | EmployeeShell (también marca) | AdminShell + grupo "Gestión" |
| global_manager | AdminShell + barra inferior de respaldo | AdminShell |
| superadmin | AdminShell + barra inferior de respaldo, + ítem "Logs" | AdminShell |

### Casos de prueba

- [ ] **05.1** (employee) Viewport &lt;768px → EmployeeShell (barra inferior de 4 destinos); mismo
      usuario en escritorio → AdminShell con barra lateral.
- [ ] **05.2** (department_head) Viewport &lt;768px → EmployeeShell; en escritorio → AdminShell.
- [ ] **05.3** (global_manager) Viewport &lt;768px → AdminShell con barra inferior de respaldo (no
      EmployeeShell, es rol administrativo).
- [ ] **05.4** (superadmin) Viewport &lt;768px → AdminShell con barra inferior de respaldo.
- [ ] **05.5** Redimensionar/rotar → el shell cambia reactivamente sin recargar.
- [ ] **05.6** (employee) Forzar `?ui=admin` → ve el armazón de AdminShell, pero cada ruta protegida
      sigue redirigiendo/rechazando según su rol real — el override no otorga permisos.
- [ ] **05.7** El override `?ui=` se recuerda en `sessionStorage` de la pestaña, no en cookie; no
      persiste entre pestañas ni sesiones. `?ui=auto` revierte al comportamiento automático.
- [ ] **05.8** Destino por defecto tras login: employee/department_head en móvil → `/clock-in`; en
      AdminShell → `/dashboard`.
- [ ] **05.9** Badges de la barra inferior (incidencias, notificaciones) se actualizan sin recargar
      tras una mutación.
- [ ] **05.10** ⚠️ El aside/menú del AdminShell filtra con `canAccess` (misma función que el guard) —
      no debe ofrecer "Marcar"/"Mi asistencia" a `global_manager` (bug histórico corregido, RN-05.7).
- [ ] **05.11** (department_head) Ve el grupo "Gestión" (Asistencia del día, Mi equipo, Descansos,
      Reportes); (employee) NO lo ve.
- [ ] **05.12** (global_manager/superadmin) Ven el grupo "Administración" (Usuarios, Departamentos,
      Nómina, Configuración); roles inferiores NO.
- [ ] **05.13** Sólo `superadmin` ve el ítem "Logs".
- [ ] **05.14** "Diagnóstico GPS" es visible para cualquier rol, incluido `global_manager`.
- [ ] **05.15** Ítems sin acceso NO se muestran deshabilitados — simplemente no aparecen.
- [ ] **05.16** Los grupos con pendientes muestran badge con conteo correcto.
- [ ] **05.17** Un error de render dentro de una página no deja la app en blanco (frontera de error).
- [ ] **05.18** Ruta inexistente → 404 con enlace al destino por defecto del rol.
- [ ] **05.19** Ningún mensaje de error del backend llega al usuario en inglés.
- [ ] **05.20** Las vistas tabulares muestran esqueletos de carga, no spinners a pantalla completa.
- [ ] **05.21** `/notifications` es accesible sin `RequireRole` y no aparece en el aside, sólo desde
      la campana.
- [ ] **05.22** Spot-check de rutas protegidas: `/users`, `/departments`, `/payroll`, `/settings`,
      `/logs`, `/admin` con los cuatro roles.

---

## 06 · Configuración global

Centralizar en `app_config` los parámetros que controlan el comportamiento del sistema.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| `GET /config` (completo) | ❌ | ❌ | ✅ | ✅ |
| `PATCH /config` | ❌ | ❌ | ✅ | ✅ |
| `GET /config/public` | ✅ | ✅ | ✅ | ✅ |

### Casos de prueba

- [ ] **06.1** (employee) `GET /config` → 403.
- [ ] **06.2** (department_head) `GET /config` → 403.
- [ ] **06.3** (global_manager) `GET /config` → 200, catálogo completo.
- [ ] **06.4** (global_manager) `PATCH /config` con `attendance_checkout_mode=schedule` sin
      `attendance_auto_checkout_time` → falla la validación.
- [ ] **06.5** (global_manager) `PATCH /config` con `attendance_checkout_mode=geofence_exit` sin (o
      con ≤0) `attendance_geofence_exit_minutes` → falla.
- [ ] **06.6** La validación cruzada evalúa el resultado efectivo, no el parche: fijar la hora hoy y
      cambiar el modo mañana debe seguir siendo coherente al guardar.
- [ ] **06.7** Clave ausente en base → la API devuelve el default de código, no error.
- [ ] **06.8** Insertar un valor con tipo inválido a mano en `value` → la app no rompe, cae al
      default.
- [ ] **06.9** (global_manager) Guardar `rest_days_min_per_week` &gt; `rest_days_max_per_week` →
      rechazado.
- [ ] **06.10** (global_manager) `global_manager_department_id` con un uuid inexistente → rechazado.
- [ ] **06.11** (global_manager) `rest_days_min_separation_departments` con un id inexistente →
      rechazado.
- [ ] **06.12** Eliminar un departamento referenciado por `global_manager_department_id` → bloqueado
      (vínculo con spec 01).
- [ ] **06.13** Cada `PATCH /config` exitoso genera entrada de auditoría con valor anterior y nuevo.
- [ ] **06.14** **[verificar con spec 09]** Cambiar `late_tolerance_minutes` hoy no reclasifica
      marcajes de ayer.
- [ ] **06.15** (cualquier autenticado) `GET /config/public` → sólo la lista blanca (zona horaria,
      tolerancia, modo de salida y sus 3 claves, plazo de incidencias); verificar EXPLÍCITAMENTE que
      NO aparecen claves como `payroll_daily_divisor` o `global_manager_department_id`.
- [ ] **06.16** Una clave nueva en el catálogo NO aparece en `/config/public` salvo que se añada
      explícitamente a la lista blanca (es allowlist, no "todo menos X").
- [ ] **06.17** Escribir configuración invalida la caché de inmediato en instancia única.
- [ ] **06.18** ⚠️ `payroll_daily_divisor` y `vacation_days_per_worked_day` son claves distintas — no
      se confunden ni se reutilizan (trampa explícita del legacy).
- [ ] **06.19** Verificar los defaults "inertes" de cada clave (`late_tolerance_minutes=0`,
      `rest_days_min_separation=0`, `incident_report_window_days=0`,
      `vacation_days_per_worked_day=0`), salvo `payroll_daily_divisor=30`.
- [ ] **06.20** `maintenance_mode` y `maintenance_message` llegan también por `/config/public`.

---

## 07 · Horarios por departamento y calendario laboral

Definir la ventana horaria diaria y el calendario laboral que determinan cuándo se puede marcar.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Ver su propio horario (`/me/schedule`) | ✅ | ✅ | — | — |
| Ver horario/calendario de un departamento | ❌ | ✅ su ámbito | ✅ todos | ✅ todos |
| Crear/editar/borrar horario y calendario | ❌ | ❌ | ✅ | ✅ |

### Casos de prueba

- [ ] **07.1** (department_head) `GET /departments/:id/schedule` de su ámbito sin horario configurado
      → `null`, no error.
- [ ] **07.2** (employee) `GET /departments/:id/schedule` directo → 403.
- [ ] **07.3** (global_manager) `PUT /departments/:id/schedule` con datos válidos → crea/actualiza el
      horario único del departamento.
- [ ] **07.4** Marcaje 1 minuto después de `checkin_end_time` (sin `allow_early_checkin`) → rechazado
      con motivo legible.
- [ ] **07.5** Con `allow_early_checkin=true`, marcaje 30 min antes de `checkin_start_time` →
      aceptado, no cuenta como tardanza.
- [ ] **07.6** Marcaje dentro de ventana pero pasada la tolerancia → aceptado y marcado como tarde
      (`is_late=true`, minutos correctos).
- [ ] **07.7** Jornada nocturna (`checkout_end_time &lt; checkin_start_time`): el marcaje de salida en
      la madrugada pertenece al `work_date` del día laboral anterior — probar el minuto exacto del
      límite.
- [ ] **07.8** Al guardar un horario, rechazar una entrada que cruce medianoche con jornada &gt;24h.
- [ ] **07.9** Día con `work_calendar.is_workday=false` → `NO_LABORABLE`; intento de marcaje →
      `NOT_WORKDAY`.
- [ ] **07.10** Fecha sin fila en `work_calendar` → laborable por defecto, salvo que sea día de
      descanso.
- [ ] **07.11** Precedencia de tolerancia: la del calendario por fecha gana sobre la global.
- [ ] **07.12** Departamento en pausa bloquea el marcaje independientemente del horario (vínculo
      spec 01).
- [ ] **07.13** (global_manager) Modificar el horario de un departamento genera una notificación por
      cada miembro activo, en la misma transacción; guardar un horario **idéntico** al existente NO
      debe notificar.
- [ ] **07.14** Corregir una hora dos veces seguidas actualiza el mismo aviso (mismo `dedupe_key`),
      no apila duplicados.
- [ ] **07.15** Cambiar el horario hoy no reclasifica días pasados.
- [ ] **07.16** (global_manager) `DELETE /departments/:id/schedule` de un departamento con horario →
      éxito, avisa a miembros, permite luego eliminar el departamento.
- [ ] **07.17** (global_manager) `PUT .../calendar` con `clearDates` → vuelve esas fechas a "sin
      fila", distinto de marcarlas `is_workday=true` explícitamente.
- [ ] **07.18** Marcar 52 domingos de un año en un solo `PUT` de calendario → una transacción, una
      sola entrada de bitácora.
- [ ] **07.19** (employee) `GET /me/schedule` también devuelve el calendario de su departamento en el
      rango pedido.
- [ ] **07.20** Cálculo correcto con una zona horaria del departamento distinta a la del servidor.
- [ ] **07.21** Omitir `timezone` al crear un horario → toma la zona global; omitirla al actualizar →
      conserva la que tenía.
- [ ] **07.22** `allow_early_checkin`/`allow_late_checkout`: probar los límites reales exactos (medianoche
      del día laboral / final del día natural en que termina la jornada).
- [ ] **07.23** `global_manager` no se ve afectado por el horario de Administración para marcar (no
      marca), pero sí afecta la reportería de los demás miembros de ese departamento.

---

## 08 · Sedes, geocerca y geolocalización

Definir dónde se puede marcar (sedes con geocerca circular y umbral de precisión).

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Elegir su sede de trabajo | ✅ | ✅ | — (no marca) | ✅ |
| Diagnóstico GPS | ✅ | ✅ | ✅ | ✅ |
| CRUD de sedes (crear/editar/(des)activar) | ❌ | ❌ | ✅ | ✅ |
| Ver sedes inactivas (`?includeInactive=true`) | ❌ | ❌ | ✅ | ✅ |

### Casos de prueba

- [ ] **08.1** (global_manager) Crear sede con lat/lng, `radius_meters`, `accuracy_threshold` →
      `block_on_poor_accuracy=false` por defecto.
- [ ] **08.2** (global_manager) Crear sede con nombre duplicado (sin distinguir mayúsculas) →
      rechazado.
- [ ] **08.3** Marcaje a `radius_meters + 1` metros del centro → rechazado (fuera de geocerca).
- [ ] **08.4** Cliente que envía `inside_geofence: true` manipulado con coordenadas fuera → rechazado
      igual; el campo ni siquiera existe en el esquema de entrada.
- [ ] **08.5** Cliente que envía una `distance_to_center` falsa → ignorada, el servidor recalcula.
- [ ] **08.6** `accuracy` peor que el umbral y `block_on_poor_accuracy=true` → rechazado.
- [ ] **08.7** `accuracy` peor que el umbral y `block_on_poor_accuracy=false` → aceptado, pero la
      precisión queda registrada.
- [ ] **08.8** ⚠️ Verificar el orden real de evaluación (precisión antes que geocerca) — el mensaje de
      rechazo debe ser coherente cuando ambas fallan.
- [ ] **08.9** Usuario con sede A seleccionada intenta marcar dentro de la geocerca de otra sede B
      (activa) pero no de A → rechazado igual; el mensaje debe nombrar la sede B y la distancia.
- [ ] **08.10** (global_manager) Desactivar la sede que un usuario tiene seleccionada → su selección
      deja de ser válida, se le vuelve a pedir, y recibe notificación.
- [ ] **08.11** La selección de sede persiste por usuario, no por dispositivo (dos usuarios en el
      mismo terminal no comparten selección).
- [ ] **08.12** Todo rol que marca debe elegir sede antes de operar; `global_manager` está exento —
      verificar consistencia en menú, validación y `GET /me/work-location`.
- [ ] **08.13** Denegar el permiso de ubicación → la UI explica cómo reactivarlo por plataforma, no
      un error genérico.
- [ ] **08.14** (global_manager) No debe existir `DELETE` de sede, sólo `deactivate`/`reactivate`.
- [ ] **08.15** (global_manager) Reactivar una sede desactivada → vuelve a estar disponible.
- [ ] **08.16** (employee/department_head) `GET /work-locations` → sólo sedes activas;
      `?includeInactive=true` → 403.
- [ ] **08.17** `POST /me/location-check` con lat/lng/precisión → veredicto calculado en servidor, no
      escribe ningún registro.
- [ ] **08.18** Pantalla `/gps` accesible a cualquier rol, incluido `global_manager`; muestra permiso,
      coordenadas, sede seleccionada, distancia, veredicto y lista de sedes activas por distancia.
- [ ] **08.19** Botón "copiar diagnóstico" genera texto plano copiable.
- [ ] **08.20** Múltiples sedes activas con geocercas solapadas → el mapa de administración muestra
      el solape.

---

## 09 · Marcaje de asistencia (núcleo del producto)

Registrar entrada/salida validando rol, departamento, horario, calendario, descanso, vacaciones y
geocerca.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Marcar entrada/salida propia | ✅ | ✅ | ❌ `ROLE_CANNOT_MARK` | ✅ (si actúa como empleado) |
| Ver su propio historial/estado | ✅ | ✅ | — | ✅ |
| Ver o marcar por otra persona | ❌ | ❌ | ❌ | ❌ |

### Casos de prueba

- [ ] **09.1** (employee) `POST /attendance/marks` con IN válido, dentro de ventana y geocerca → 201.
- [ ] **09.2** (global_manager) `POST /attendance/marks` → rechazado con `ROLE_CANNOT_MARK`.
- [ ] **09.3** Provocar y verificar cada uno de los 12 motivos de rechazo tipados: `INACTIVE_ACCOUNT`,
      `ON_VACATION`, `ROLE_CANNOT_MARK`, `DEPARTMENT_PAUSED`, `NO_SCHEDULE`, `NOT_WORKDAY`,
      `REST_DAY`, `OUTSIDE_TIME_WINDOW`, `INVALID_LOCATION`, `OUTSIDE_GEOFENCE`,
      `POOR_GPS_ACCURACY`, `DUPLICATE_MARK`, `INVALID_SEQUENCE` — todos con `accepted:false` y
      HTTP 200, no 4xx.
- [ ] **09.4** Sin sesión → 401.
- [ ] **09.5** Enviar `markedAt` manipulado con el reloj adelantado 2h → se ignora, el servidor usa su
      propio instante.
- [ ] **09.6** Enviar `distance_to_center`/`inside_geofence` falsos → ignorados, no existen en el
      esquema de entrada.
- [ ] **09.7** Doble toque simultáneo en "marcar" (dos peticiones concurrentes) → una sola marca; la
      segunda responde `duplicate: true` con la marca existente, sin error.
- [ ] **09.8** El antirrebote se mide sólo contra marcas ACEPTADAS: un intento rechazado a las
      08:00:10 no debe bloquear un marcaje bueno a las 08:00:40.
- [ ] **09.9** Empleado con vacaciones aprobadas vigentes hoy → rechazado `ON_VACATION`.
- [ ] **09.10** Empleado de departamento pausado → rechazado, motivo de pausa visible.
- [ ] **09.11** Marcar 3 min tarde con tolerancia 5 → sin tardanza; a los 6 min → tardanza con los
      minutos reales de retraso.
- [ ] **09.12** Secuencia IN → IN (sin OUT intermedio) → `INVALID_SEQUENCE`; IN → OUT → IN → OUT
      (almuerzo) → todos aceptados.
- [ ] **09.13** OUT sin IN previo en la jornada → `INVALID_SEQUENCE`.
- [ ] **09.14** En jornada nocturna, la secuencia se compara contra `work_date`, no el día natural —
      no debe romperse a medianoche.
- [ ] **09.15** Intentar marcar en día de descanso propio → `REST_DAY`.
- [ ] **09.16** Intentar marcar en día `NOT_WORKDAY` del calendario → rechazado.
- [ ] **09.17** `GET /attendance/status` refleja `can_check_in`/`can_check_out`/`blocked` sin
      necesidad de fallar un `POST`; incluye descansos y vacaciones como gate.
- [ ] **09.18** El historial propio (`GET /attendance/me`) nunca devuelve marcas de otro usuario —
      probar explícitamente intentando pasar un id ajeno.
- [ ] **09.19** Un intento rechazado (`blocked=true`) queda registrado con `block_reason` y, si se
      pudo calcular, lat/lng/accuracy.
- [ ] **09.20** Un marcaje válido no puede editarse ni borrarse desde la app — verificar ausencia de
      `PATCH`/`DELETE` sobre `attendance_marks` desde rutas de usuario.
- [ ] **09.21** Reintentar la misma petición de marcaje (ej. tras fallo de red) es idempotente, no
      duplica.
- [ ] **09.22** ⚠️ El antirrebote se evalúa ANTES que la ventana horaria: un segundo toque a las
      08:16 debe decir "ya registrado", no "fuera de ventana".

---

## 10 · Descansos

Definir qué días no trabaja cada persona (individual o por grupos), para no contarlos como ausencia
y bloquear el marcaje esos días.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Elegir sus propios descansos (modo individual) | ✅ | ✅ | — (no marca) | — |
| Ver/editar descansos de su ámbito | ❌ | ✅ | ✅ todos | ✅ todos |
| Crear/editar/eliminar grupos de descanso | ❌ | ❌ | ✅ | ✅ |
| Asignar personas a un grupo | ❌ | ✅ su ámbito | ✅ cualquiera | ✅ cualquiera |
| Cambio retroactivo de `effective_from` | ❌ | ❌ | ✅ (auditado) | ✅ (auditado) |

### Casos de prueba

- [ ] **10.1** (employee) `PUT /me/rest-schedule` con `days_of_week` válidos en modo individual →
      éxito.
- [ ] **10.2** (employee) `PUT /me/rest-schedule` con el departamento en modo grupos
      (`rest_groups_enabled=true`) → 409, sin borrar lo previamente guardado.
- [ ] **10.3** Cambiar `effective_from` a futuro no altera el reporte del mes pasado.
- [ ] **10.4** Resolver descansos de una fecha D con varias filas de `effective_from` → se toma la más
      reciente con `effective_from ≤ D`.
- [ ] **10.5** (employee/department_head) `effective_from` anterior a hoy → rechazado; (rol
      administrativo/superadmin) permitido y queda en bitácora.
- [ ] **10.6** Departamento en modo grupos: la config individual se ignora pero no se borra; al
      volver a modo individual, reaparece intacta.
- [ ] **10.7** Usuario sin ninguna fila vigente → todos los días laborables se le exigen, dispara
      recordatorio automático.
- [ ] **10.8** Marcar como descanso una fecha en la que ya existe un marcaje real → rechazado, en
      servidor y UI.
- [ ] **10.9** Con `rest_days_min_separation &gt; 0`: elegir dos días de descanso al límite del
      mínimo (medido en ciclo semanal circular, ej. sábado-domingo = 1 día) → rechazado en servidor.
- [ ] **10.10** `rest_days_min_separation_departments` vacío → la regla aplica a TODOS los
      departamentos.
- [ ] **10.11** `rest_days_min_separation_departments` con lista específica → sólo aplica a esos
      departamentos.
- [ ] **10.12** Configurar `rest_days_min_per_week &gt; rest_days_max_per_week` → rechazado al
      guardar (vínculo spec 06).
- [ ] **10.13** Elegir un número de días de descanso fuera del rango [min, max] configurado →
      rechazado.
- [ ] **10.14** (global_manager) Crear grupo con nombre duplicado en el mismo departamento (sin
      distinguir mayúsculas) → rechazado.
- [ ] **10.15** (global_manager) `DELETE /rest-groups/:id` de un grupo sin historial de miembros →
      éxito.
- [ ] **10.16** (global_manager) `DELETE /rest-groups/:id` de un grupo con historial de asignaciones
      (aunque hoy sin miembros vigentes) → rechazado, usar `is_active=false`.
- [ ] **10.17** (global_manager) `DELETE /rest-groups/:id` con miembros vigentes → rechazado, primero
      reasignar.
- [ ] **10.18** (department_head) `PUT /rest-groups/:id/members` de un grupo fuera de su ámbito
      (validado contra el departamento leído de la base) → 403.
- [ ] **10.19** Asignar a alguien `group_id=null` desde una fecha → se resuelve como "sin grupo" desde
      esa fecha en adelante.
- [ ] **10.20** Único por `(user_id, effective_from)` en `rest_group_members`: dos asignaciones con
      la misma fecha efectiva → rechazado.
- [ ] **10.21** Intento de marcaje en día de descanso (individual o grupo) → `REST_DAY`; el día
      clasifica `DESCANSO` en reportería, nunca `AUSENTE`.
- [ ] **10.22** Un intento de marcaje rechazado en una fecha no debe impedir configurar esa fecha
      como descanso después.
- [ ] **10.23** Usuario sin descansos configurados en la semana → recibe una única notificación
      recordatoria; al configurarlos, se retira sola.
- [ ] **10.24** El recordatorio NO se envía a `global_manager` ni a quien no tiene departamento.
- [ ] **10.25** El recordatorio dirige a `/profile` en modo individual, y al jefe (no a la persona) en
      modo grupos.
- [ ] **10.26** (department_head) `/rest-days` lista correctamente quién de su ámbito no tiene
      descansos vigentes.
- [ ] **10.27** ⚠️ Cambiar los días de un grupo existente SÍ afecta retroactivamente a fechas ya
      reportadas de sus miembros (sin `effective_from`) — la UI debe advertirlo antes de guardar si
      el grupo tiene gente dentro.
- [ ] **10.28** Verificar la convención `days_of_week` (0=domingo…6=sábado) consistente en backend y
      frontend, aunque la UI pinte la semana empezando en lunes.

---

## 11 · Vacaciones

Solicitar días libres pagados con saldo acumulado por días trabajados; el jefe aprueba/rechaza y
bloquea el marcaje en el periodo aprobado.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Ver su saldo / solicitar / cancelar propia | ✅ | ✅ | — (no acumula, no marca) | — |
| Revisar (aprobar/rechazar) su ámbito | ❌ | ✅ | ✅ global | no documentado explícito |
| Ver saldo de otro usuario | ❌ | ✅ su ámbito | ✅ todos | — |

### Casos de prueba

- [ ] **11.1** (employee) Solicitar un rango dentro de su saldo disponible → `pending`, descuenta
      `available`.
- [ ] **11.2** (employee) Solicitar más días de los disponibles → rechazado antes de crearse.
- [ ] **11.3** (employee) Solicitar un rango solapado con otra `pending`/`approved` propia → falla.
- [ ] **11.4** (employee) Solicitar un rango cuyos días son todos no laborables o descanso →
      rechazado (0 días).
- [ ] **11.5** (employee) `start_date` anterior a hoy → rechazado, sin excepción de rol.
- [ ] **11.6** `requested_days` se calcula excluyendo descansos/no laborables y queda congelado
      aunque luego cambie el calendario.
- [ ] **11.7** (employee) Cancelar su propia solicitud `pending` → éxito, libera saldo.
- [ ] **11.8** (employee) Cancelar su propia solicitud `approved` aún no iniciada → éxito, libera
      saldo.
- [ ] **11.9** (employee) Cancelar su propia solicitud `approved` en curso o pasada → 403 (sólo rol
      administrativo puede).
- [ ] **11.10** (employee) Cancelar una solicitud ya `rejected`/`cancelled` → 409.
- [ ] **11.11** **[verificar con spec 09]** (employee) Con vacaciones aprobadas vigentes, intentar
      marcar → `ON_VACATION`; `GET /attendance/status` debe reflejarlo antes de ofrecer el botón.
- [ ] **11.12** (employee) Pedir `scope=managed` en `GET /vacations/requests` → sólo trae las propias,
      sin fuga de datos ajenos.
- [ ] **11.13** Confirmar que no existe forma de pedir vacaciones en nombre de otro (sin campo de
      persona en el body).
- [ ] **11.14** (department_head) Ver bandeja `scope=managed` con pendientes de todo su ámbito.
- [ ] **11.15** (department_head) Aprobar una solicitud de su ámbito → notifica al solicitante, el día
      pasa a `VACACIONES` en reportería.
- [ ] **11.16** (department_head) Rechazar sin comentario → error (comentario obligatorio).
- [ ] **11.17** (department_head) Rechazar con comentario → éxito, notifica al solicitante.
- [ ] **11.18** (department_head) Intentar aprobar su propia solicitud → rechazado.
- [ ] **11.19** (department_head) Intentar revisar una solicitud fuera de su ámbito → 403.
- [ ] **11.20** Aprobar vacaciones NO crea ningún ajuste de nómina.
- [ ] **11.21** (global_manager) Aprobar/rechazar cualquier solicitud sin restricción de departamento.
- [ ] **11.22** Concurrencia: dos solicitudes simultáneas del mismo usuario que juntas exceden el
      saldo → sólo una pasa.
- [ ] **11.23** Día de vacaciones que además es descanso → se presenta como `VACACIONES` pero NO
      consume saldo.
- [ ] **11.24** ⚠️ La notificación al jefe "propio" de un departamento (no responsabilidad adicional)
      NO llega directamente — sólo se entera vía bandeja `/team` (comportamiento esperado, no bug).
- [ ] **11.25** `requested_days` es siempre entero (no se aceptan medios días).

---

## 12 · Incidencias de asistencia

Vía para reportar problemas de marcaje y bandeja para revisarlos, sin efecto automático en nómina
ni en marcajes.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Crear incidencia propia | ✅ | ✅ | ✅ (autenticado, sin rol mínimo) | ✅ |
| Revisar (aprobar/rechazar) su ámbito | ❌ | ✅ | ✅ global | no aplica / sin acceso |

### Casos de prueba

- [ ] **12.1** (employee) Crear incidencia crítica (`forgot_to_mark`, `late_arrival`,
      `early_departure`) sin `reason` → error.
- [ ] **12.2** (employee) Crear incidencia técnica (`gps_issue`, `geofence_issue`) sin `reason` →
      éxito (opcional).
- [ ] **12.3** Confirmar que no hay forma de crear una incidencia "a nombre de otro".
- [ ] **12.4** (employee) Crear dos incidencias iguales (mismo user/fecha/tipo) mientras la primera
      está `pending` → la segunda falla.
- [ ] **12.5** (employee) Crear una del mismo tipo/fecha después de revisada la primera → permitido.
- [ ] **12.6** (employee) Crear incidencia fuera del plazo configurado
      (`incident_report_window_days ≠ 0`) → rechazada.
- [ ] **12.7** Con `incident_report_window_days=0` (default) → sin límite de plazo.
- [ ] **12.8** (employee) Al elegir una fecha con intentos de marcaje rechazados, se ofrecen para
      enlazar con hora, motivo y distancia.
- [ ] **12.9** El badge de pendientes en el aside refleja el conteo correcto.
- [ ] **12.10** (department_head) Ve sólo las incidencias de su ámbito (incluidos adicionales).
- [ ] **12.11** (department_head) Revisar una incidencia fuera de su ámbito → 403.
- [ ] **12.12** (department_head) Aprobar/rechazar su propia incidencia → bloqueado.
- [ ] **12.13** (department_head) Rechazar sin `manager_notes` → error.
- [ ] **12.14** (department_head) Revisar una incidencia ya revisada → 409.
- [ ] **12.15** (department_head) Aprobar una incidencia → verificar que NO crea ni edita ningún
      `attendance_mark`.
- [ ] **12.16** (department_head) Aprobar con `justifyAbsence=true` sobre `forgot_to_mark` en día
      ausente → justifica el día en la misma transacción.
- [ ] **12.17** (department_head) Aprobar con `justifyAbsence=true` sobre una tardanza (día presente)
      → no toca nada de ausencia.
- [ ] **12.18** (department_head) Aprobar SIN pedir justificación explícita → NO justifica
      automáticamente la ausencia.
- [ ] **12.19** La bandeja ordena pendientes primero, luego por fecha descendente.
- [ ] **12.20** Búsqueda por empleado/correo/departamento en un mismo campo de texto libre.
- [ ] **12.21** Crear incidencia → notifica al jefe (⚠️ limitación conocida: sólo llega a jefes con
      responsabilidad adicional, no al jefe "propio" del departamento).
- [ ] **12.22** Revisar incidencia → notifica al empleado.
- [ ] **12.23** (global_manager) Revisar incidencias de cualquier departamento sin restricción.
- [ ] **12.24** `POST /incidents` no exige rol específico más allá de autenticado.
- [ ] **12.25** Si falla la consulta del badge, no debe romper el resto del shell.

---

## 13 · Justificación de ausencias

El jefe decide si una ausencia está justificada, con efecto en reportería (AJ/ANJ) y nómina
(descuento automático).

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Ver su propio código AJ/ANJ e importe (en notificación) | ✅ (sólo lectura) | — | — | — |
| Justificar / no justificar su ámbito | ❌ | ✅ (sin ver importe) | ✅ global (ve importe) | no aplica de forma explícita |
| Acceso a `/payroll/*` desde este flujo | ❌ | ❌ (403) | ✅ | — |

### Casos de prueba

- [ ] **13.1** (department_head) Justificar (`is_justified=true`) un día `AUSENTE` → éxito, `notes`
      obligatorias.
- [ ] **13.2** (department_head) Justificar sin `notes` → error.
- [ ] **13.3** (department_head) Marcar `is_justified=false` → `notes` opcionales, éxito.
- [ ] **13.4** (department_head/global_manager) Justificar un día `PRESENTE`, `DESCANSO`,
      `NO_LABORABLE` o `VACACIONES` → error (sólo revisable si es `AUSENTE`).
- [ ] **13.5** Justificar una jornada aún en curso (`pending`) → error, no se clasifica antes de
      tiempo.
- [ ] **13.6** (department_head) Justificar su propia ausencia → bloqueado.
- [ ] **13.7** (department_head) Justificar una ausencia fuera de su ámbito → 403.
- [ ] **13.8** Marcar `is_justified=false` → crea exactamente un ajuste de nómina con
      `amount = -(monthly_salary/divisor)`.
- [ ] **13.9** Reclasificar a `is_justified=true` → revierte el ajuste (`reverted`, no se borra).
- [ ] **13.10** Volver a `is_justified=false` → crea un ajuste NUEVO, no resucita el anterior.
- [ ] **13.11** Repetir la misma decisión dos veces seguidas → no duplica ajustes.
- [ ] **13.12** Concurrencia: dos revisiones simultáneas del mismo día → sólo un ajuste `active`
      resultante.
- [ ] **13.13** (department_head) Tras el descuento, NO ve el importe del ajuste (sólo "se aplicó un
      descuento de un día de salario"); (global_manager) sí ve la cifra.
- [ ] **13.14** (department_head) Acceder a cualquier endpoint de `/payroll/*` → 403 real (no 404).
- [ ] **13.15** Empleado sin sueldo configurado: marcar no justificada → no crea ajuste, respuesta
      trae `effect: "skipped_no_salary"`, la revisión no falla.
- [ ] **13.16** Toda decisión (justificar/no justificar) queda en bitácora con el valor anterior.
- [ ] **13.17** El empleado recibe notificación de la clasificación y, si aplica, del descuento con
      el importe.
- [ ] **13.18** El día aparece como `AJ` o `ANJ` coincidiendo entre reporte mensual e historial
      propio.
- [ ] **13.19** Un día ausente SIN fila de revisión sale `ANJ` en el reporte pero NO genera descuento;
      la UI distingue "sin revisar" de "decidido".
- [ ] **13.20** La bandeja de pendientes sólo trae ausencias sin fila de revisión.
- [ ] **13.21** El badge en `/team` suma incidencias por revisar + ausencias sin clasificar.
- [ ] **13.22** Aprobar una incidencia sobre un día ausente ofrece casilla "justificar" marcada por
      defecto, pero no automática: sin marcarla, la ausencia sigue sin justificar.
- [ ] **13.23** El empleado SÍ recibe notificación de la clasificación (a diferencia del legacy, que
      no lo hacía) — verificar que no reaparece ese hueco.

---

## 14 · Notificaciones

Avisar en la aplicación de hechos que requieren atención, con entrega en vivo (SSE) y respaldo por
sondeo, aisladas estrictamente por usuario.

### Qué puede hacer cada rol

Los cuatro roles tienen el mismo comportamiento: sólo leen y marcan como leídas sus **propias**
notificaciones, sin excepción por jerarquía de rol.

### Casos de prueba

- [ ] **14.1** Cualquier rol: leer o marcar como leída una notificación de otro usuario → falla como
      si no existiera (404), sin revelar su existencia.
- [ ] **14.2** (superadmin) Confirmar explícitamente que NO puede ver notificaciones de otro usuario
      pese a su rol máximo.
- [ ] **14.3** "Marcar todas como leídas" no alcanza a las de ningún otro usuario.
- [ ] **14.4** Cualquier rol: `POST`/`PUT`/`PATCH`/`DELETE` sobre `/notifications` → 404 (sólo el
      servidor crea).
- [ ] **14.5** Con SSE conectado, al llegar una notificación sube el contador y aparece un aviso
      emergente.
- [ ] **14.6** El aviso emergente se autodescarta a los 8 segundos; "Ver" lleva al recurso sin
      marcarla leída.
- [ ] **14.7** Con la entrega en vivo caída, el sondeo de respaldo (cada 30s) sigue actualizando el
      contador.
- [ ] **14.8** El recordatorio de descansos no se duplica por semana/persona y se retira al
      configurar los días.
- [ ] **14.9** Aprobar vacaciones notifica al solicitante en la misma transacción del hecho.
- [ ] **14.10** Un ajuste de nómina (automático o manual) notifica al empleado afectado con el
      importe.
- [ ] **14.11** Verificar que el catálogo completo de eventos (12 tipos) se emite correctamente.
- [ ] **14.12** `/notifications` completa: filtro leídas/no leídas y paginación funcionan; NO hace
      sondeo automático (sólo el panel de campana sondea).
- [ ] **14.13** Paginación con cursor tipo keyset consistente (mismo mecanismo que auditoría).
- [ ] **14.14** Sólo se purgan notificaciones leídas tras `notification_retention_days`; las no
      leídas nunca se purgan.
- [ ] **14.15** `/notifications` no requiere `RequireRole`: cualquier rol autenticado accede sin
      comprobación de ámbito adicional.

---

## 15 · Agregación diaria, dashboard y paneles de gestión

Convertir marcajes crudos en el estado de un día para una persona, presentado en dashboard, panel
de departamento y panel global según el rol.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Dashboard personal | ✅ | ✅ | — | — |
| Panel de equipo (`/daily`, resumen de departamento) | ❌ | ✅ su ámbito | ✅ global | ✅ global |
| Resumen ejecutivo / tendencia / alertas | ❌ | ❌ | ✅ | ✅ |

### Casos de prueba

- [ ] **15.1** Verificar los 5 estados diarios base (`PRESENTE`, `TARDE`, `AUSENTE`, `DESCANSO`,
      `NO_LABORABLE`), cada uno con su condición exacta.
- [ ] **15.2** Verificar el orden de precedencia exacto: `NO_LABORABLE` &gt; `VACACIONES` &gt;
      `DESCANSO` &gt; `PRESENTE`/`TARDE` &gt; `AUSENTE` → `AJ`/`ANJ`.
- [ ] **15.3** Un día de vacaciones aprobado nunca sale como `AUSENTE`.
- [ ] **15.4** Un día de descanso nunca sale como `AUSENTE`.
- [ ] **15.5** Día de vacaciones que además es descanso → se presenta `VACACIONES`, no consume saldo.
- [ ] **15.6** ⚠️ (sólo vía importación histórica) Marcaje existente en día de descanso/no
      laborable/vacaciones aprobadas → gana `PRESENTE` sobre cualquier otro estado; probar las tres
      ramas.
- [ ] **15.7** Consecuencia del caso anterior: si se importa un marcaje sobre un día antes justificado
      (AJ), la superposición desaparece.
- [ ] **15.8** Jornada sin salida → `worked_minutes = null`, marcada "incompleta", visible al jefe.
- [ ] **15.9** El día se delimita en la zona horaria del departamento, no UTC ni la del servidor —
      probar con un departamento en una zona muy alejada de UTC.
- [ ] **15.10** Un `AUSENTE` de una jornada que aún puede completarse se marca `pending` (bandera), no
      se pinta en rojo a media mañana.
- [ ] **15.11** Rendimiento: el conteo de consultas del panel se mantiene constante entre 5 y 200+
      personas (no hay N+1).
- [ ] **15.12** (department_head) Pedir `?scope=global` u otro parámetro que intente ensanchar el
      ámbito → no cambia nada, sigue recibiendo sólo su ámbito.
- [ ] **15.13** (department_head) Pedir datos de un `departmentId` fuera de su ámbito → 403 o vacío,
      nunca fuga.
- [ ] **15.14** (employee) `/dashboard/summary` → resumen personal con `scope: null` (único endpoint
      sin exigir rol de gestión).
- [ ] **15.15** (employee) `/dashboard/trend`, `/dashboard/alerts`, `/attendance/daily`,
      `/attendance/daily-range` de otro usuario o del equipo → 403.
- [ ] **15.16** ⚠️ Verificar que el ámbito lo decide el rol y NO si `managedDepartmentIds` está vacía
      (bug real del legacy: esa lista incluye el departamento propio de cualquiera, lo que habría
      dado a un `employee` el resumen de sus compañeros).
- [ ] **15.17** El selector de departamento en `/daily` sólo aparece si el usuario gestiona más de
      uno.
- [ ] **15.18** Desde `/daily` sólo se ve, no se decide (justificar ausencias vive en `/team`, spec
      13).
- [ ] **15.19** "Estado en vivo" muestra `open` (jornada abierta), no "dentro de la geocerca" (fuera
      de alcance).
- [ ] **15.20** Verificar que las secciones que ve cada rol coinciden exactamente con la tabla de
      dashboard fijo por rol (no configurable por el usuario).

---

## 16 · Reportería mensual

Producir el reporte mensual de asistencia (matriz empleado × día + resumen), reproducible,
trazable y capaz de generarse sobre miles de filas sin bloquear.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Generar/consultar/descargar reporte | ❌ (403) | ✅ su ámbito | ✅ cualquier ámbito o global | — (no diferenciado) |
| `/reports/kpis` | ❌ | ❌ | ✅ | — |
| `/attendance/facts/refresh` (recálculo manual) | ❌ | ❌ | ✅ | — |

### Casos de prueba

- [ ] **16.1** La matriz XLSX y la que alimentaría Sheets salen del mismo módulo — comparar celda a
      celda entre ambas salidas.
- [ ] **16.2** Los totales del resumen (P, D, T, AJ, ANJ, V + NL) suman los días del periodo para
      todo empleado.
- [ ] **16.3** Reintentar una corrida fallida crea una fila NUEVA en `report_runs`, conserva la
      anterior.
- [ ] **16.4** Dos solicitudes del mismo reporte (mismo scope+periodo+departamento) en paralelo →
      encolan una sola corrida.
- [ ] **16.5** Una corrida `running` que supere el tiempo límite pasa a `failed` con motivo, y puede
      volver a encolarse.
- [ ] **16.6** Recalcular los hechos diarios de un mes cerrado no cambia ningún valor salvo
      `computed_at`.
- [ ] **16.7** Justificar una ausencia de un mes ya calculado invalida y actualiza el hecho diario
      afectado.
- [ ] **16.8** Aprobar/revisar vacaciones con efecto retroactivo invalida el rango entero de la
      solicitud.
- [ ] **16.9** Cambiar días de un grupo de descanso con efecto retroactivo, o importar histórico, NO
      disparan invalidación automática — requieren `POST /attendance/facts/refresh`.
- [ ] **16.10** (department_head) Sólo puede encolar y descargar reportes de su propio ámbito;
      intentar el reporte global o un `departmentId` ajeno → 403.
- [ ] **16.11** El enlace de descarga caduca y no es adivinable: token manipulado → 403; caducidad
      cambiada → 403.
- [ ] **16.12** El endpoint del archivo firmado NO exige sesión — sólo la firma autoriza.
- [ ] **16.13** (global_manager) `/reports/kpis` → tasa de error, disponibilidad, p95 de la
      reportería.
- [ ] **16.14** (department_head) `/reports/kpis` → 403.
- [ ] **16.15** Los KPIs se calculan sólo sobre corridas terminadas; sin muestra → `null`, no `0`.
- [ ] **16.16** Verificar que hoy el reporte global incluye a todos, incluidos jefes (limitación
      conocida, no configurable de verdad todavía).
- [ ] **16.17** `POST /reports/runs` con `departmentId` a la vez que ámbito global implícito →
      rechazado.
- [ ] **16.18** ⚠️ Los ajustes de nómina del periodo NO aparecen en este XLSX/reporte — un
      `department_head` no puede ver importes de nómina desde ningún reporte de esta spec.
- [ ] **16.19** Cambiar una clave de cálculo relevante crea una nueva versión de reglas
      (`attendance_rule_versions`) al usarse; cambiar una clave no relevante no la crea.
- [ ] **16.20** Cada corrida y cada hecho diario guardan su `rule_version_id`.

---

## 17 · Nómina: ajustes y descuentos

Registrar ajustes económicos (descuentos automáticos por ausencia injustificada y ajustes
manuales), con barrera estricta de privilegios.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Cualquier endpoint de `/payroll/*` | ❌ (403) | ❌ (403) | ✅ | ✅ |
| Recibir notificación de su propio ajuste | ✅ | — | — | — |

### Casos de prueba

- [ ] **17.1** (department_head) 403 en los seis endpoints de `/payroll/*` (no 404).
- [ ] **17.2** (employee) 403 en los mismos endpoints.
- [ ] **17.3** (global_manager) Crear un ajuste manual con motivo obligatorio y cualquier signo →
      éxito, sin `source_type`/`source_id`.
- [ ] **17.4** El signo se elige con dos botones (descuento/bonificación); el importe se teclea
      siempre positivo — no existe un campo firmado que permita error de signo por descuido.
- [ ] **17.5** (global_manager) Revertir un ajuste exige `revert_reason` obligatorio, marca
      `reverted`, nunca borra.
- [ ] **17.6** (global_manager) Revertir un ajuste ya revertido → 409.
- [ ] **17.7** Revertir a mano un descuento automático NO reclasifica la ausencia; volver a marcarla
      injustificada crea un ajuste NUEVO.
- [ ] **17.8** Concurrencia: dos escrituras simultáneas sobre la misma revisión de ausencia → no crean
      dos ajustes `active` para el mismo `source_id`.
- [ ] **17.9** Dos ajustes manuales del mismo mes para la misma persona coexisten sin competir.
- [ ] **17.10** Empleado sin sueldo configurado: marcar ausencia injustificada → no rompe el flujo,
      no crea ajuste, aviso `skipped_no_salary` visible al revisor.
- [ ] **17.11** (global_manager) Pestaña "Sueldos" lista quiénes no tienen sueldo registrado.
- [ ] **17.12** (global_manager) Editar `monthly_salary` → mismo endpoint que spec 02, misma entrada
      de bitácora.
- [ ] **17.13** El descuento se calcula en PostgreSQL con `numeric` y redondeo correcto, nunca en
      JavaScript/`double`.
- [ ] **17.14** La moneda del ajuste se copia del sueldo al crearse; los totales se agrupan por
      moneda, nunca se suman monedas distintas.
- [ ] **17.15** Cambiar `payroll_daily_divisor` afecta a nuevos cálculos; el mínimo 1 impide romper el
      cálculo con 0.
- [ ] **17.16** ⚠️ No se reutiliza `vacation_days_per_worked_day` para el divisor de nómina.
- [ ] **17.17** Toda creación/reversión de ajuste y todo cambio de `monthly_salary` aparecen en la
      bitácora.
- [ ] **17.18** El empleado recibe notificación con el importe al aplicarse y al revertirse un
      ajuste.
- [ ] **17.19** `GET /payroll/adjustments/export` devuelve el XLSX directamente, sin guardarlo en
      ningún volumen; un `department_head` no puede acceder.
- [ ] **17.20** ⚠️ El reporte mensual (spec 16) NO contiene importes de ajustes.
- [ ] **17.21** Los totales por departamento y moneda cuadran con la suma de ajustes `active` (un
      revertido no cuenta).

---

## 18 · Bitácora de auditoría

Rastro inmutable de quién hizo qué, cuándo y sobre qué; lectura exclusiva de `superadmin`.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Leer la bitácora (`/audit`) | ❌ | ❌ | ❌ | ✅ único |
| Escribir/modificar/borrar una entrada | ❌ | ❌ | ❌ | ❌ (nadie, ni por API) |

### Casos de prueba

- [ ] **18.1** (superadmin) `GET /audit` con filtros (`actor`, `table`, `recordId`, `from`, `to`,
      `domain`, `correlationId`, `cursor`) → funciona.
- [ ] **18.2** (global_manager) `GET /audit` → 403.
- [ ] **18.3** (department_head) `GET /audit` → 403.
- [ ] **18.4** (employee) `GET /audit` → 403; sin sesión → 401.
- [ ] **18.5** Cualquier rol: `POST`/`PUT`/`PATCH`/`DELETE` sobre `/audit` → 404 (rutas inexistentes).
- [ ] **18.6** Verificar que las acciones del catálogo se auditan realmente — priorizar
      `department.created`, `profile.updated`, `vacation.cancelled`, `report_run.*`,
      `attendance_facts.refreshed`.
- [ ] **18.7** Un cambio de configuración global repetido dos veces seguidas: la segunda entrada trae
      el valor anterior correcto.
- [ ] **18.8** Una acción en cascada (ej. clasificar ausencia → ajuste → notificación) comparte el
      mismo `correlationId` entre sus entradas.
- [ ] **18.9** Dos peticiones distintas NO comparten `correlationId`.
- [ ] **18.10** Ninguna entrada contiene credenciales (`password`, `token`, `secret`, `cookie`,
      `authorization`) en `old_data`/`new_data`/`metadata`.
- [ ] **18.11** Diferencia visual campo a campo en `/logs`, incluidos casos borde (alta sin estado
      anterior, baja sin estado nuevo).
- [ ] **18.12** Actor nulo sin id = "el sistema"; actor nulo con id = "perfil eliminado" (la bitácora
      sobrevive al borrado del perfil).
- [ ] **18.13** Paginación keyset: insertar una entrada mientras se pagina no repite ni salta filas,
      incluidas entradas del mismo microsegundo.
- [ ] **18.14** Filtro por rango de fechas resuelto con la zona horaria configurada, no comparación de
      cadenas UTC.
- [ ] **18.15** Un ajuste de nómina y un cambio de sueldo aparecen en la bitácora
      (`payroll_adjustment.created/.reverted`, `compensation.updated`).
- [ ] **18.16** Filtrar por `table`+`recordId` desde un recurso concreto (ej. una revisión de
      ausencia) sin teclear un UUID a mano.
- [ ] **18.17** La IP de origen se registra y sólo la ve `superadmin`.
- [ ] **18.18** Si la escritura de bitácora falla dentro de una transacción de dominio, TODA la
      acción se aborta.
- [ ] **18.19** No hay purga automática de la bitácora — las entradas antiguas persisten
      indefinidamente.

---

## 19 · Panel de superadmin

Herramientas reservadas a `superadmin`: estadísticas globales, importación de histórico y modo de
mantenimiento; sin consola SQL.

### Qué puede hacer cada rol

| Acción | employee | department_head | global_manager | superadmin |
|---|---|---|---|---|
| Cualquier endpoint de `/admin/*` | ❌ | ❌ | ❌ (¡incluso este rol!) | ✅ único |
| Efecto del modo mantenimiento | sujeto | sujeto | sujeto (no exento) | exento |

### Casos de prueba

- [ ] **19.1** (global_manager) Acceder a cualquier endpoint de `/admin/*` → 403 — caso explícito: es
      el rol "casi todopoderoso" que debe fallar aquí.
- [ ] **19.2** (department_head / employee) Acceder a `/admin/*` → 403.
- [ ] **19.3** (superadmin) `GET /admin/stats` → usuarios por ESTADO (no por rol; la UI explica por
      qué falta ese dato).
- [ ] **19.4** (superadmin) Los contadores de pendientes en `/admin/stats` coinciden exactamente con
      los badges de un jefe (mismas funciones, ámbito "all").
- [ ] **19.5** (superadmin) `POST /admin/sql` (consola SQL) → NO existe, 404.
- [ ] **19.6** (superadmin) Importar histórico, paso 1 `POST /admin/import/attendance/validate` con
      filas válidas e inválidas → informe previo detallado, SIN escribir ninguna fila.
- [ ] **19.7** (superadmin) Paso 2 `POST /admin/import/attendance/commit` tras validar → escribe los
      marcajes válidos con `source="import"`.
- [ ] **19.8** Reimportar el mismo archivo → inserta 0 filas nuevas (idempotencia por clave natural),
      el informe lo indica antes de intentar.
- [ ] **19.9** Los marcajes importados quedan sin coordenadas válidas (nulos, no `0,0`).
- [ ] **19.10** Tras importar, se recalculan los hechos diarios del rango afectado y el reporte del
      periodo refleja los datos nuevos.
- [ ] **19.11** ⚠️ Importar un XLSX real: verificar la correcta conversión de fechas seriales de
      Excel y horas como fracción de día — priorizar en pruebas manuales con un archivo real.
- [ ] **19.12** La hora del archivo importado se interpreta como hora de pared en la zona
      configurada, no UTC.
- [ ] **19.13** La importación queda registrada en bitácora con nombre del archivo, rango de fechas y
      número de filas.
- [ ] **19.14** (superadmin) Activar modo mantenimiento con motivo obligatorio → cualquier escritura
      de rol inferior (incluido `global_manager`) recibe 503 con el motivo dentro.
- [ ] **19.15** Durante mantenimiento, las lecturas siguen funcionando y el login sigue permitido
      para todos los roles.
- [ ] **19.16** Durante mantenimiento, `superadmin` está exento y puede seguir escribiendo.
- [ ] **19.17** Durante mantenimiento no se cierran sesiones activas.
- [ ] **19.18** El aviso de mantenimiento llega a todos los usuarios conectados vía
      `GET /config/public` — probar con un `employee`.
- [ ] **19.19** Desactivar el modo mantenimiento → las escrituras vuelven a funcionar con normalidad.
- [ ] **19.20** Quién y cuándo activó/desactivó el mantenimiento sale de la bitácora.
- [ ] **19.21** Las acciones destructivas (borrado de cuenta, importación, mantenimiento) exigen
      escribir el nombre del recurso, no un simple "¿Está seguro?".
- [ ] **19.22** `DELETE /users/:id` exige desactivación previa; sólo accesible a `superadmin`.
- [ ] **19.23** Otorgar rol `superadmin` y resetear contraseñas NO están en este panel — la interfaz
      sólo enlaza a la consola del IS.

---

## 21 · Migración desde el sistema legacy (transversal)

Se prueba a nivel de sistema, con la copia fabricada del legacy, antes/durante el corte real —no es
un flujo con roles de la aplicación.

- [ ] Ejecutar `extract` → `load` (simulación) → `load --commit` → `verify` contra el origen
      fabricado, en ese orden y sin saltarse pasos.
- [ ] Ninguna tabla ajena al sistema (homónima incluida, ej. `audit_logs` vs `audit_log`) se importa.
- [ ] El id de perfil migrado sale de `profiles.user_id`, no de `profiles.id`, y todas las
      referencias cruzadas (`reviewed_by`, `source_id`) resuelven correctamente.
- [ ] `verify` compara conteo Y suma de `payroll_adjustments` (incluidos revertidos) y falla de
      verdad si falta una fila.
- [ ] Ningún perfil queda sin `identity_user_id`; correos duplicados o ausentes bloquean el `plan`
      antes de escribir.
- [ ] Reimportar (`load` repetido) no duplica nada (`on conflict do nothing`).
- [ ] Pendiente para el corte real (no en QA de producto): comparar el reporte mensual de un mes
      cerrado, celda a celda, contra el legacy; y ensayar el procedimiento de vuelta atrás.

---

## 22 · Calidad, pruebas y deuda técnica (transversal)

Se prueba a nivel de sistema/proceso, no por rol de la aplicación.

- [ ] El pipeline de CI (`lint`, `typecheck`, `test`, `build`, verificación de deriva de esquema) se
      ejecuta en cada PR.
- [ ] Confirmar en la configuración de GitHub si la protección de rama exige realmente estos cinco
      pasos para poder fusionar (la spec señala que hoy sólo "declaran", no bloquean, si el
      interruptor no está activado).
- [ ] El presupuesto de tamaño de bundle y el conteo de consultas (paneles y reporte) siguen dentro
      de los límites medidos tras cambios de UI o de agregación.
- [ ] **Pasada de smoke test de autorización** con usuarios reales de cada rol (no mocks) sobre
      cada router con ámbito: `users`, `departments`, `reports`, `rest`, `vacations`, `absences`,
      `incidents`, `schedules`, `dashboard`, `locations`, `config`, `payroll`, `admin`, `audit` —
      confirmando el 403 esperado en cada uno según la matriz de esta spec.
- [ ] Registrar como deuda conocida (no resolver en este ciclo): contraste de color no medido y
      navegación por teclado del backoffice no auditada.

---

## Anexo — Recorridos guiados por rol (de punta a punta)

Además de probar spec por spec, conviene ejecutar una vez por release estos cuatro recorridos
completos, en el orden en que un usuario real los viviría. Cada paso referencia el caso de arriba.

### Recorrido `employee`

1. Login con rol asignado (**04.1**) → ve pantalla de cuenta pendiente si no tiene departamento
   (**02.2**, **04.20**).
2. Con departamento asignado: elige su sede (**08.1–08.9**) y sus descansos (**10.1**).
3. Marca entrada dentro de horario y geocerca (**09.1**); prueba al menos 3 motivos de rechazo
   tipados (**09.3**).
4. Marca salida; revisa su historial y estado del día (**09.17–09.18**, **15.1–15.10**).
5. Pide vacaciones (**11.1**) y las cancela si aún no empezaron (**11.7**).
6. Crea una incidencia sobre un marcaje rechazado (**12.1–12.8**).
7. Revisa notificaciones propias y confirma que no ve las de nadie más (**14.1–14.3**).
8. Intenta, y falla, acceder a: `/departments/:id/members` (**01.1**), `/users` (**02.7**),
   `/config` (**06.1**), `/reports/*` (**16**), `/payroll/*` (**17.2**), `/audit` (**18.4**),
   `/admin/*` (**19.2**).

### Recorrido `department_head`

1. Todo el recorrido de `employee` para sí mismo (marca, vacaciones, descansos, incidencias).
2. Ve y gestiona su departamento y los adicionales (**01.2**, **02.6**, **03.2**).
3. Configura horario/calendario — debería fallar, es rol sólo lectura aquí (**07.1–07.2**); revisa
   los de su ámbito.
4. Revisa la bandeja de `/team`: incidencias (**12.10–12.20**), ausencias sin justificar
   (**13.1–13.7**, **13.13**), vacaciones pendientes (**11.14–11.19**).
5. Consulta el panel `/daily` y el dashboard de equipo, confirmando que nunca ve otro departamento
   (**15.12–15.18**).
6. Genera y descarga el reporte de su ámbito (**16.10**); confirma que no ve KPIs (**16.14**) ni
   nómina (**13.14**, **17.1**).
7. Intenta, y falla, acceder a: crear/eliminar departamentos (**01.3–01.9**), `/config` (**06.2**),
   `/payroll/*` (**17.1**), `/audit` (**18.3**), `/admin/*` (**19.2**).

### Recorrido `global_manager`

1. Login — nunca ve opción de marcar asistencia en el menú (**05.10**) y, si lo intenta por API,
   recibe `ROLE_CANNOT_MARK` (**09.2**, **03.4**).
2. Administra departamentos completos: crear, pausar, eliminar con sus restricciones (**01.3–01.20**).
3. Administra usuarios: perfiles incompletos, desactivación, sueldos (**02.3**, **02.8–02.20**).
4. Configura el sistema completo: `/config`, horarios, sedes, grupos de descanso
   (**06.3–06.20**, **07.3**, **08.1–08.15**, **10.14–10.20**).
5. Revisa incidencias/ausencias/vacaciones sin límite de ámbito (**11.21**, **12.23**, **13** con
   visión de importe).
6. Genera reportes globales y consulta KPIs (**16.13**, **16.16**).
7. Gestiona nómina: ajustes manuales, reversiones, sueldos (**17.3–17.21**).
8. Intenta, y falla, acceder a: `/audit` (**18.2**) y a **cualquier** endpoint de `/admin/*`
   (**19.1**, el caso más importante de este recorrido).

### Recorrido `superadmin`

1. Todo lo de `global_manager`.
2. Accede a la bitácora completa y confirma que sigue sin ver "su ámbito" de nada, porque no
   aplica (**18.1**, **18.6–18.19**).
3. Usa el panel de superadmin: estadísticas, importación de histórico con archivo real
   (**19.3–19.13**), modo mantenimiento activado desde su propia cuenta (**19.14–19.20**).
4. Borra realmente un perfil ya desactivado (**02.14–02.15**, **19.22**).
5. Confirma que sigue sin ver notificaciones ajenas pese al rol máximo (**14.2**) y que no existe
   consola SQL en ningún punto de la interfaz (**19.5**).
