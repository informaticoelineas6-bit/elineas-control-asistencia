# 03 · Roles y autorización

> **Origen:** `old-docs.md` Parte 2, §3.1, §3.8, puntos 5, 8, 9, 10, 18, 45.
> **Estado en el sistema legacy:** ✅ implementado (RLS en Postgres como autoridad real).
> **Estado en el monorepo nuevo:** ✅ implementado en su parte de servidor y de UI. Middleware
> de sesión, rol efectivo, ámbito y helpers (`requireRole`, `requireScope`, `canManage`) en
> `apps/backend/src/middleware/auth.ts`; RN-03.6 en `apps/backend/src/services/profiles.ts`;
> filtrado del aside y guard de página en `apps/frontend/src/modules/auth/`. Los dos endpoints
> de §7 sobre responsabilidades de departamento están en
> `apps/backend/src/services/responsibilities.ts`, con su diálogo "Departamentos a cargo" en la
> pantalla de usuarios. Cada endpoint de las specs 01 y 02 tiene su prueba de autorización.
> Sigue abierta la decisión 2 (RLS).
> **Depende de:** [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md).
> **Habilita:** todo. Ninguna otra spec puede implementarse sin ésta.

---

## 1. Objetivo

Definir quién puede hacer qué. Es la spec transversal: cada funcionalidad posterior declara
sus permisos en términos de los cuatro roles definidos aquí y del **ámbito** (propio /
departamento / global) que le corresponde.

## 2. Los cuatro roles

Enum `app_role`, ordenados por prioridad ascendente. Un usuario puede tener **varias filas**
de rol; el efectivo es el de mayor prioridad.

| Prioridad | Rol | Alcance |
|---|---|---|
| 1 | `employee` | Marca asistencia, ve su historial, pide vacaciones, configura sus descansos, crea incidencias. |
| 2 | `department_head` | Todo lo del empleado **+** ve y gestiona su departamento y los adicionales asignados; revisa incidencias, justifica ausencias, aprueba vacaciones de su departamento, exporta su reporte. |
| 3 | `global_manager` | **No marca asistencia.** Panel global, configuración del sistema, gestión de usuarios y departamentos, reportería global, ajustes de nómina. |
| 4 | `superadmin` | Todo lo anterior **+** consola SQL, bitácora global, borrado real de cuentas, publicación de la APK, modo mantenimiento. |

## 3. De dónde salen los roles

> ⚠️ **Cambio respecto al legacy:** la tabla `user_roles` **desaparece de nuestra base**.
> Los roles los otorga y almacena el **Identity Server de Elineas**, por sistema
> ([00-migracion-datos-e-identidad](./00-migracion-datos-e-identidad.md) Parte C).

- Se consultan con `GET /api/user-roles/me?systemSlug=control-asistencia`, usando el
  **session token** como Bearer — **nunca** leyendo un campo del JWT
  ([00](./00-migracion-datos-e-identidad.md) RN-00.39/40).
- Los cuatro roles de §2 deben existir creados en la consola del IS con esos mismos nombres
  ([00](./00-migracion-datos-e-identidad.md) RN-00.32).
- El IS devuelve **una lista de roles**, sin jerarquía. La prioridad (RN-03.1) sigue siendo
  lógica de este sistema.
- Un usuario sin ningún rol en el sistema **no puede ni autenticarse**: el IS rechaza el login
  con 403 ([00](./00-migracion-datos-e-identidad.md) RN-00.33).
- Los roles se cachean por sesión con TTL corto; ese TTL es lo que tarda en aplicarse un
  cambio hecho en la consola del IS ([00](./00-migracion-datos-e-identidad.md) RN-00.41).

Lo que **sí** sigue viviendo en nuestra base es el **ámbito**, que el IS no conoce:

### `user_department_responsibilities`

Departamentos **adicionales** que gestiona un `department_head`, además del suyo propio.

| Campo | Tipo |
|---|---|
| `user_id` | uuid FK |
| `department_id` | uuid FK → `departments` |
| — | Único por par |

## 4. Reglas de negocio

- **RN-03.1 — Rol efectivo.** Ante múltiples roles devueltos por el IS, gana el de mayor prioridad
  (`getHighestRole` en el legacy). Toda decisión de UI usa el rol efectivo; toda decisión de
  backend debe consultar el conjunto real de roles, no confiar en lo que envía el cliente.
- **RN-03.2 — Ámbito de un `department_head`.** Es la unión de: su `profiles.department_id`
  **+** todos los `department_id` de `user_department_responsibilities`. Cualquier consulta
  con alcance departamental debe usar ese conjunto, nunca sólo el departamento propio.
- **RN-03.3 — El servidor es la autoridad.** El guard del cliente es UX, no seguridad. Todo
  endpoint valida rol y ámbito por su cuenta. Un cliente manipulado no debe poder leer ni
  escribir fuera de su ámbito.
- **RN-03.4 — `global_manager` no marca asistencia.** Bloqueo explícito en la validación de
  marcaje (ver [09-marcaje-asistencia](./09-marcaje-asistencia.md), RN-09.3).
- **RN-03.5 — No hay rol por defecto.** Lo asigna un administrador en el IS al crear la
  cuenta; sin él no hay acceso. *(En el legacy se otorgaba `employee` automáticamente al
  registrarse — ese comportamiento desaparece con el auto-registro.)*
- **RN-03.6 — Departamento forzado para `global_manager`.** ✅ **Decidido: se conserva**, pero el
  destino es **configurable por id**, no el nombre "Administración" del trigger
  `enforce_gm_department` del legacy. La clave es `global_manager_department_id`
  ([06](./06-configuracion-global.md)); si está sin configurar, la regla queda desactivada.
  Se aplica **al resolver la sesión** —el único momento en que este sistema conoce los roles de
  alguien, porque viven en el Identity Server (RN-00.29)— y el cambio se audita con actor `null`,
  que es lo que corresponde a una regla aplicada por el sistema.
  Implementación: `enforceGlobalManagerDepartment` en `apps/backend/src/services/profiles.ts`.
- **RN-03.7 — Debe existir siempre al menos un `superadmin`** con rol vigente en el IS. Esta
  aplicación no puede garantizarlo (no gestiona roles): es una **responsabilidad operativa**
  de quien administra el IS, y conviene dejarla escrita en el procedimiento de altas y bajas.
- **RN-03.8 — Los roles no se modifican desde esta aplicación.** No hay endpoint que otorgue
  ni quite roles: se hace en la consola del IS, que es donde queda su rastro. Lo que sí
  auditamos aquí es el cambio de **responsabilidades de departamento** (RN-03.2).

## 5. Matriz de ámbito por recurso

Referencia rápida para implementar los filtros de cada endpoint.

| Recurso | employee | department_head | global_manager / superadmin |
|---|---|---|---|
| Marcajes | propios | ámbito (RN-03.2) | todos |
| Incidencias | propias | ámbito | todas |
| Ausencias / justificaciones | propias (lectura) | ámbito (lectura y escritura) | todas |
| Vacaciones | propias | ámbito (aprobar) | todas |
| Descansos | propios | ámbito | todos |
| Reportes | — | ámbito | global |
| Configuración global | — | — | ✅ |
| Nómina | — | ❌ | ✅ |
| Bitácora | — | — | superadmin (global) |

> **Ojo con el orden de argumentos.** En el legacy, la función
> `is_head_of_department(_user_id, _dept_id)` se llamó al revés en varias migraciones
> (hallazgo H-1). Falla cerrado, pero silenciosamente. En el sistema nuevo la comprobación
> de ámbito debe ser **una sola función tipada** reutilizada en todos lados, no repetida
> por endpoint.

## 6. Implementación propuesta en el monorepo

- **Middleware de Hono** que resuelve, una vez por petición: identidad (JWT verificado contra
  el JWKS del IS), perfil, roles (del IS, cacheados), rol efectivo y conjunto de departamentos
  gestionados; y lo deja en el contexto.
- **Helpers de autorización** exportados desde el backend:
  `requireRole('global_manager')`, `requireScope(departmentId)`, `canManage(userId)`.
- **Sin RLS como red de seguridad.** El legacy tenía RLS en Postgres como segunda barrera.
  Al migrar a Drizzle + Hono esa red desaparece: **la validación de ámbito en el handler es
  ahora la única barrera**. Esto es un riesgo real y debe compensarse con tests de
  autorización por endpoint. **Decisión abierta:** ¿se reimplementa RLS en Postgres?

## 7. API propuesta

| Método | Path | Rol mínimo |
|---|---|---|
| `GET` | `/me/permissions` | autenticado — rol efectivo + departamentos gestionados |
| `GET` | `/users/:id/department-responsibilities` | global_manager |
| `PUT` | `/users/:id/department-responsibilities` | global_manager — reemplaza el conjunto completo |

El `PUT` es de **reemplazo**, no de añadido: el cuerpo (`{ departmentIds }`) describe la lista
entera de departamentos adicionales. Así quitar uno no necesita un verbo aparte y cada cambio
de ámbito deja **una** entrada de bitácora (`profile.responsibilities_changed`) con el antes y
el después. El departamento **propio** del perfil se descarta en silencio si viene en la lista:
ya está en el ámbito por RN-03.2, y guardarlo además en la tabla lo ataría a un departamento
que puede cambiar.

No hay endpoints de roles: se consultan al IS y se otorgan en su consola (§3).

## 8. Criterios de aceptación

- [x] Un usuario con `employee` + `department_head` resuelve a `department_head`.
- [x] Un `department_head` con un departamento adicional ve los datos de **ambos**.
- [x] Un `employee` que llama a un endpoint de ámbito departamental recibe 403, aunque la UI
      nunca se lo hubiera ofrecido.
- [ ] Un `global_manager` no puede registrar un marcaje. *(Con la [09](./09-marcaje-asistencia.md).)*
- [ ] Existe un test de autorización por cada endpoint con ámbito. *(Faltan `/config`, `/me` y
      `/notifications`.)*
- [x] Ningún endpoint autoriza leyendo un campo de rol del JWT. *(`verifyJwt` sólo devuelve
      identidad; los roles salen del IS con el session token.)*
- [ ] Un cambio de rol en la consola del IS se refleja aquí como máximo tras el TTL de caché.

## 9. Decisiones abiertas

1. ~~¿Se conserva RN-03.6 (departamento forzado a Administración)?~~ **Resuelta:** se conserva
   con el departamento configurable por id. Ver RN-03.6.
2. ¿Se reimplementa RLS en Postgres o la autorización vive sólo en la capa Hono?
   (Ver [00](./00-migracion-datos-e-identidad.md) RN-00.1: es el riesgo número uno de la migración.)
3. ¿`department_head` debería poder ver salarios de su equipo? (Hoy: **no**.)
4. TTL de la caché de roles y comportamiento con el IS caído
   ([00](./00-migracion-datos-e-identidad.md) RN-00.41/42).
