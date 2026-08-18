# 02 · Usuarios y perfiles

> **Origen:** `old-docs.md` §3.1, puntos 4, 60, 61; hallazgo H-3.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado, salvo lo que depende de specs por
> venir (ver §8). Código: `apps/backend/src/services/users.ts`,
> `apps/backend/src/routes/users.ts`, `apps/backend/src/services/profiles.ts`,
> `apps/frontend/src/routes/_authed/users.tsx`,
> `apps/frontend/src/routes/_authed/profile.tsx`. Pruebas:
> `apps/backend/src/routes/users.test.ts`.
> **Normativo:** la identidad la gobierna el Identity Server de Elineas —
> [00-migracion-datos-e-identidad](./00-migracion-datos-e-identidad.md) Parte C.
> **Depende de:** [01-organizacion-departamentos](./01-organizacion-departamentos.md).
> **Habilita:** [03-roles-y-autorizacion](./03-roles-y-autorizacion.md), todo lo demás.

---

## 1. Objetivo

Separar la **identidad** (credenciales, sesión, roles — responsabilidad del **Identity Server
de Elineas**) del **perfil de negocio** (departamento, teléfono, sueldo, estado operativo de
la cuenta), que es lo único que vive aquí. El perfil es 1:1 con el usuario del IS y se vincula
por su `sub` ([00](./00-migracion-datos-e-identidad.md) RN-00.44).

Cubre además el **ciclo de vida operativo**: perfil incompleto, activo, desactivado y
contrato cancelado — estados nuestros, distintos de que la cuenta exista o no en el IS
([00](./00-migracion-datos-e-identidad.md) RN-00.30).

## 2. Actores y permisos

| Acción | employee | department_head | global_manager | superadmin |
|---|:--:|:--:|:--:|:--:|
| Ver su propio perfil | ✅ | ✅ | ✅ | ✅ |
| Editar sus datos de contacto | ✅ | ✅ | ✅ | ✅ |
| Ver perfiles de su departamento | ❌ | ✅ | ✅ | ✅ |
| Ver todos los perfiles | ❌ | ❌ | ✅ | ✅ |
| Crear usuario / asignar rol | — | — | **en la consola del IS** | **en la consola del IS** |
| Cambiar departamento de otro | ❌ | ❌ | ✅ | ✅ |
| Desactivar / reactivar el perfil | ❌ | ❌ | ✅ | ✅ |
| Resetear contraseña de otro | — | — | **en el IS** | **en el IS** |
| Ver / editar `monthly_salary` | ❌ | ❌ | ✅ | ✅ |
| **Borrado real** del perfil | ❌ | ❌ | ❌ | ✅ |

## 3. Modelo de datos

### `profiles` (1:1 con el usuario del Identity Server)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `identity_user_id` | text, único, no nulo | `sub` del JWT del IS. **Sustituye al `user_id` del legacy**; no hay FK, la identidad es externa |
| `email` | text | Copia desnormalizada, se mantiene sincronizada |
| `full_name` | text | |
| `department_id` | uuid FK → `departments` | |
| `phone` | text, nullable | Validado con **la misma regla que el Identity Server**: `libphonenumber-js`, formato internacional, país por defecto `CU` en la interfaz (`packages/validations/src/phone.ts`) |
| ~~`monthly_salary`~~ | — | **Movido a `employee_compensation`** (§6a). Ya no es columna de `profiles` |
| `is_active` | boolean, default `true` | |
| `deactivated_at` | timestamptz, nullable | |
| `deactivated_by` | uuid, nullable | Quién desactivó |
| `deactivation_reason` | text, nullable | |
| `contract_cancelled_at` | timestamptz, nullable | Baja contractual, distinta de la desactivación operativa |
| `last_connection_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

## 4. Reglas de negocio

- **RN-02.1 — El perfil se crea al primer ingreso, no al registrarse.** Este sistema no da de
  alta usuarios: cuando alguien autenticado en el IS entra por primera vez, se crea su perfil
  con los datos que trae el IS (`sub`, correo, nombre) y **sin departamento**
  ([00](./00-migracion-datos-e-identidad.md) RN-00.46).
- **RN-02.2** — `identity_user_id` es único: no puede haber dos perfiles para la misma
  identidad del IS.
- **RN-02.3 — Perfil incompleto.** Un perfil sin `department_id` es un estado válido y
  transitorio: el usuario entra, ve que su cuenta está pendiente de configurar y **no puede
  marcar**. Debe existir una vista de perfiles incompletos para el administrador
  ([00](./00-migracion-datos-e-identidad.md) RN-00.49); sin ella, la gente se pierde en el
  alta de dos pasos.
- **RN-02.4** — **Desactivar ≠ borrar.** Un perfil con `is_active = false` **no puede entrar a
  este sistema** —el backend rechaza el login aunque el IS autentique correctamente
  ([00](./00-migracion-datos-e-identidad.md) RN-00.30)— y conserva todo su historial: sigue
  apareciendo en los reportes del periodo en que estuvo activo, y desaparece de los listados
  operativos.
  Es una baja **de este sistema**; la cuenta del IS sigue existiendo y puede entrar a otros
  sistemas de Elineas. Sacarla de todos es quitarle el rol o deshabilitarla allí.
- **RN-02.5** — Al desactivar se exige `deactivation_reason` y se registran `deactivated_at`
  y `deactivated_by`. Al reactivar, los tres campos se limpian.
- **RN-02.6** — `contract_cancelled_at` es informativo (fin de relación laboral) y es
  independiente de `is_active`: se puede desactivar sin cancelar contrato y viceversa.
- **RN-02.7** — `last_connection_at` se actualiza de forma **throttlada** (legacy: máximo una
  escritura cada 5 minutos por sesión) para no golpear la base en cada render.
- **RN-02.8** — El borrado real es exclusivo de `superadmin` y debe limpiar/anular las claves
  foráneas dependientes en orden, sin romper integridad referencial.
- **RN-02.9** — Cambiar el departamento de un usuario **no** reescribe su historial: los
  marcajes y reportes pasados conservan el departamento vigente en su momento.
  *Implicación de diseño:* si esto importa, hay que denormalizar `department_id` en
  `attendance_marks` o consultar por fecha. **Decisión abierta.**

## 5. Flujos

### 5.1 Alta de una persona (dos pasos, y hay que asumirlo)

```
Paso 1 — consola del IS (fuera de esta app)
  admin crea la cuenta (nombre, correo, contraseña inicial)
  admin le asigna un rol en el sistema `control-asistencia`   ← sin esto no puede ni entrar

Paso 2 — esta aplicación
  la persona entra por primera vez  → se crea su perfil incompleto (RN-02.1)
  el admin le asigna departamento (y teléfono, sueldo si aplica) → perfil completo
```

- **RN-02.10** — La UI de gestión debe **explicar el paso 1**, no ofrecer un botón de "crear
  usuario" que no puede cumplir ([00](./00-migracion-datos-e-identidad.md) RN-00.48). Enlace
  directo a la consola del IS.
- **RN-02.11** — El paso 2 se registra en [18-auditoria](./18-auditoria.md).
- **RN-02.12** — El alta en dos pasos **la pueden hacer dos personas distintas**: quien
  administra el IS y quien gestiona la asistencia. Para que nadie quede a medias, la aparición
  de un perfil incompleto debe **notificarse** a los gestores
  ([14-notificaciones](./14-notificaciones.md)), no sólo listarse.

> El alta por API del IS **está descartada**: la creación de cuentas es responsabilidad del
> Identity Server ([00](./00-migracion-datos-e-identidad.md) §C.7).

### 5.2 Desactivación
1. Motivo obligatorio → `is_active = false`.
2. Se cierra su sesión activa aquí. **No se revoca en el IS**, y esto corrige lo que decía
   antes este paso: había una contradicción con RN-02.4, que define la desactivación como una
   baja *de este sistema* y deja explícito que la cuenta sigue sirviendo para otros sistemas de
   Elineas. Revocar allí lo echaría de todos. **Manda RN-02.4.**
   Su sesión aquí muere igual sin tocar el IS: el middleware rechaza a un perfil inactivo en su
   siguiente petición y le limpia las cookies ([00](./00-migracion-datos-e-identidad.md)
   RN-00.30), y el login posterior lo rechaza. *Además, el IS no tiene API para revocar la
   sesión de otra persona: `sign-out` sólo revoca la propia.*
3. Auditoría.
4. Reactivar devuelve el acceso sin tocar nada en el IS.

- **RN-02.13 — Para borrar hay que desactivar primero.** El borrado real exige `is_active =
  false`. No es prudencia: si la cuenta del IS conserva su rol, el perfil **volvería a crearse
  vacío** en el siguiente ingreso (RN-02.1), perdiendo departamento y contacto sin que nadie se
  entere. Desactivar es lo que impide ese regreso.

## 6. Protección del dato salarial

> **Hallazgo H-3 del legacy:** `monthly_salary` vivía en `profiles` y sólo estaba protegido
> "porque ningún consumidor de rol bajo hacía `select *`". Eso es una convención, no una barrera.

**Decidido: (a) tabla aparte.**

- **(a) Tabla aparte** `employee_compensation(profile_id, monthly_salary, currency, updated_at,
  updated_by)`, 1:1 con el perfil. ✅ **Implementado.** La separación es física: un endpoint que
  consulta `profiles` no puede devolver lo que no está en la fila, ni por descuido ni por un
  `select *` futuro. Con la RLS fuera del proyecto ([00](./00-migracion-datos-e-identidad.md)
  RN-00.1) esa diferencia importa más que antes.
- (b) Mantenerlo en `profiles` con proyecciones explícitas — descartada: volvía a depender de
  que nadie se equivoque al escribir una consulta nueva.

**Consecuencia sobre la API:** el sueldo **no viaja en `PATCH /users/:id`** como proponía §7,
sino en sus propios endpoints (`GET`/`PUT /users/:id/compensation`). Compartir DTO con el perfil
habría reintroducido justo el riesgo que la tabla aparte elimina. Son los únicos dos endpoints
—y `services/users.ts` el único módulo— que mencionan `employee_compensation`.

El importe **sí** se registra en la bitácora, con valor anterior y nuevo: es el punto de
auditarlo ([18](./18-auditoria.md) RN-18.2).

**Moneda.** El importe nunca viaja sin ella. Vocabulario cerrado en
`packages/validations/src/currency.ts`, porque no todas son códigos ISO 4217: `CUP` (moneda
nacional), `USD`, `EUR`, `MLC` (moneda libremente convertible), `TRO` (tropical) y `CLA`
(clásica). **Un importe, una moneda** —no varias líneas por persona—; si algún día hay pagos
mixtos, es una tabla con una fila por moneda, no un campo más aquí. Default `CUP`, y la moneda
también queda en la bitácora.

## 7. API propuesta

| Método | Path | Rol mínimo |
|---|---|---|
| `GET` | `/me` | autenticado |
| `PATCH` | `/me` | autenticado (sólo datos de contacto) |
| `GET` | `/users` | department_head (acotado a su ámbito) |
| `GET` | `/users/incomplete` | global_manager — perfiles sin departamento (RN-02.3) |
| `GET` | `/users/:id` | department_head (ámbito) |
| `PATCH` | `/users/:id` | global_manager — departamento, teléfono, sueldo |
| `POST` | `/users/:id/deactivate` | global_manager |
| `POST` | `/users/:id/reactivate` | global_manager |
| `DELETE` | `/users/:id` | superadmin — borra el **perfil**, no la cuenta del IS |

No hay `POST /users` ni `reset-password`: son operaciones del IS (§5.1).

## 8. Criterios de aceptación

- [x] El primer ingreso de una identidad nueva crea exactamente un perfil, incompleto.
- [x] Un perfil sin departamento aparece en `/users/incomplete`. *La otra mitad del criterio
      —que no pueda marcar— está **bloqueada por la [09](./09-marcaje-asistencia.md)**: no hay
      marcaje que impedir. Lo que sí se comprueba es que el perfil incompleto no puede pasar
      por completo, y la UI le dice por qué.*
- [x] **Un usuario desactivado no consigue iniciar sesión**, y su historial sigue visible para
      quien tenga ámbito sobre él. *Desaparece del listado operativo y se recupera con
      `?includeInactive=true`; su ficha sigue accesible.*
- [x] Desactivar cierra la sesión que la persona tuviera abierta en ese momento. *En su
      siguiente petición: el middleware la rechaza con 403 y le limpia las cookies.*
- [x] Reactivar limpia motivo, fecha y autor de la desactivación.
- [x] Un `department_head` que consulta `/users` sólo recibe los de los departamentos que
      gestiona. *El filtro se aplica en la consulta, no descartando filas después; y pedir otro
      departamento explícitamente da 403, no una lista vacía.*
- [x] Ningún endpoint accesible a `employee` o `department_head` devuelve `monthly_salary`
      (test explícito). *Se comprueba sobre el cuerpo crudo de la respuesta, buscando el
      importe y el nombre del campo, en el listado, el detalle y `GET /me`.*
- [x] `last_connection_at` no se escribe más de una vez cada 5 minutos por sesión.
- [x] Ningún perfil queda sin `identity_user_id`. *La columna es `not null` y `unique`, así que
      la base lo garantiza; la migración de los datos del legacy es de la
      [21](./21-migracion-desde-legacy.md).*
- [x] **Añadido:** el borrado real exige perfil desactivado (RN-02.13) y no deja punteros
      colgando.
- [x] **Añadido:** al asignar departamento a un perfil incompleto se avisa a la persona: es el
      momento en que su alta queda cerrada.

## 9. Decisiones tomadas

1. **Tabla de compensación separada** (§6a). Ver ahí el detalle y su consecuencia sobre la API.
2. **El historial se congela en el marcaje, no aquí.** Cuando exista la tabla de marcajes
   ([09](./09-marcaje-asistencia.md)), cada marcaje guardará el `department_id` vigente en ese
   momento. Es exacto y no cuesta nada hoy; queda anotado allí para que no se pierda. Se
   descartó una tabla de vigencias por departamento: añadiría hoy una tabla que nada consulta y
   convertiría toda consulta histórica en un rango de fechas.
3. **La reconciliación contra el IS queda pendiente, y está bloqueada por el propio IS.**
   No se puede implementar: su API son cinco endpoints (`sign-in`, `token`, `jwks`, `sign-out`,
   `user-roles/me`) y **ninguno permite listar usuarios ni consultar por rol**, sólo responder
   por el usuario de la sesión en curso. Sin API de administración no hay con qué reconciliar.
   Lo que sí se detecta hoy, de forma pasiva: quien pierde el rol o la cuenta deja de poder
   entrar, y `last_connection_at` delata a los perfiles que llevan mucho sin aparecer.
   *Si el IS añade un listado de usuarios por sistema, esto pasa a ser un proceso programado.*
4. **A los gestores se les avisa por el departamento de gestores globales.** Por la misma
   limitación del punto 3, este sistema no puede preguntarle al IS quién tiene el rol
   `global_manager`, y almacenar roles aquí está prohibido
   ([00](./00-migracion-datos-e-identidad.md) RN-00.29). La única lista de gestores que se puede
   conocer son los miembros activos del departamento configurado en
   `global_manager_department_id`, donde RN-03.6 los concentra
   ([06](./06-configuracion-global.md)). **Si esa clave no está configurada no hay a quién
   avisar**: el aviso no se crea y sólo queda la lista de incompletos, que la pantalla muestra
   destacada de todas formas.
