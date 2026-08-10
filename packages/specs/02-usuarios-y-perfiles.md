# 02 · Usuarios y perfiles

> **Origen:** `old-docs.md` §3.1, puntos 4, 60, 61; hallazgo H-3.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe el perfil de negocio.
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
| `phone` | text, nullable | |
| `monthly_salary` | numeric, nullable | **Dato financiero sensible** (ver §6) |
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
2. Se cierra su sesión activa aquí y se revoca en el IS
   ([00](./00-migracion-datos-e-identidad.md) RN-00.38). A partir de ese momento no puede
   volver a entrar: el login lo rechaza (RN-02.4).
3. Auditoría.
4. Reactivar devuelve el acceso sin tocar nada en el IS.

## 6. Protección del dato salarial

> **Hallazgo H-3 del legacy:** `monthly_salary` vivía en `profiles` y sólo estaba protegido
> "porque ningún consumidor de rol bajo hacía `select *`". Eso es una convención, no una barrera.

**Requisito para el sistema nuevo (elegir uno, decisión abierta):**

- **(a) Tabla aparte** `employee_compensation(profile_id, monthly_salary, …)` con acceso
  restringido a rol administrativo. *Recomendado.*
- **(b) Mantenerlo en `profiles`** pero prohibir a nivel de capa de datos que cualquier
  endpoint devuelva la columna salvo los explícitamente autorizados (proyecciones
  explícitas, nunca `select *`, y un test que lo verifique).

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

- [ ] El primer ingreso de una identidad nueva crea exactamente un perfil, incompleto.
- [ ] Un perfil sin departamento no puede marcar y aparece en `/users/incomplete`.
- [ ] **Un usuario desactivado no consigue iniciar sesión**, y su historial sigue visible para
      quien tenga ámbito sobre él.
- [ ] Desactivar cierra la sesión que la persona tuviera abierta en ese momento.
- [ ] Reactivar limpia motivo, fecha y autor de la desactivación.
- [ ] Un `department_head` que consulta `/users` sólo recibe los de los departamentos que gestiona.
- [ ] Ningún endpoint accesible a `employee` o `department_head` devuelve `monthly_salary`
      (test explícito).
- [ ] `last_connection_at` no se escribe más de una vez cada 5 minutos por sesión.
- [ ] Tras la migración, ningún perfil queda sin `identity_user_id`.

## 9. Decisiones abiertas

1. ¿Tabla de compensación separada (§6a) o proyecciones controladas (§6b)?
2. ¿El historial debe congelar el departamento del momento (RN-02.9)?
3. ¿Qué pasa con el perfil cuando el IS elimina la identidad o le quita el rol? Hoy quedaría
   huérfano y nadie se enteraría. ¿Hace falta una reconciliación periódica contra el IS?
4. ¿Cómo se avisa al gestor de asistencia de un alta hecha en el IS? (RN-02.12)
