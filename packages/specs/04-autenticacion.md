# 04 · Autenticación y sesión

> **Origen:** `old-docs.md` puntos 2, 6, 7, 8, 66.
> **Estado en el sistema legacy:** ✅ implementado (Supabase Auth).
> **Estado en el monorepo nuevo:** ✅ implementado contra el Identity Server. better-auth **ya
> se retiró**. Login, logout, custodia de tokens en cookies httpOnly, renovación transparente
> del JWT y sonda de sesión: `apps/backend/src/lib/identity.ts`, `lib/cookies.ts`,
> `routes/auth.ts` y `apps/frontend/src/modules/auth/session.ts`. Las reglas de §8 están
> cubiertas por `apps/backend/src/routes/auth.test.ts`. Queda pendiente lo atado a otras specs:
> la custodia de tokens en nativo (§7, spec 20) y la limpieza de la sede al salir (RN-04.8,
> spec 08).
> **Normativo:** [00-migracion-datos-e-identidad](./00-migracion-datos-e-identidad.md) Parte C
> y [identity-server-usage.md](../docs/identity-server-usage.md). Ante cualquier diferencia, mandan esos dos.
> **Depende de:** [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md), [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).

---

## 1. Objetivo

Inicio de sesión, renovación y cierre de sesión **contra el Identity Server (IS) de Elineas**,
y resolución en el arranque del **contexto de autorización** (perfil + roles + departamentos
gestionados) que el resto de la aplicación consume.

Este sistema **no gestiona credenciales**: no registra usuarios, no guarda contraseñas y no
las restablece. Todo eso vive en el IS
([00](./00-migracion-datos-e-identidad.md) RN-00.26 a RN-00.29).

## 2. Diferencias con el legacy

| | Legacy | Monorepo nuevo |
|---|---|---|
| Proveedor | Supabase Auth | **Identity Server de Elineas** (`systemSlug: control-asistencia`) |
| Credenciales | en la propia base | en el IS; aquí no hay contraseñas |
| Alta de usuarios | auto-registro público | **sólo un admin, en la consola del IS** |
| Sesión | token de Supabase en el cliente | **session token + JWT en cookies `httpOnly`** puestas por nuestro backend |
| Roles | tabla `user_roles` propia | `GET /api/user-roles/me?systemSlug=…` |
| Cookies | mismo origen | **cross-origin** entre frontend y backend → `sameSite: "none"` + `secure: true` |
| Guard de rutas | `ProtectedRoute` con `allowedRoles`/`excludedRoles` | equivalente en TanStack Router (§6) |

## 3. Reglas de negocio

- **RN-04.1 — No hay registro en esta aplicación.** El alta la hace un administrador en la
  consola del IS, que además debe asignarle un rol en este sistema: **sin rol, el IS rechaza
  el login con 403** ([00](./00-migracion-datos-e-identidad.md) RN-00.33). La pantalla de
  login no ofrece "crear cuenta"; explica a quién dirigirse.
- **RN-04.2 — Datos de negocio al primer ingreso.** Teléfono y departamento no los conoce el
  IS. Si el perfil no existe o está incompleto, se crea/completa según
  [00](./00-migracion-datos-e-identidad.md) RN-00.46: el usuario entra pero no puede marcar
  hasta que un administrador le asigne departamento.
- **RN-04.3 — Recuperación de contraseña.** Se resuelve en el IS. La aplicación sólo enlaza.
  ⚠️ **Confirmar que el IS ofrece autoservicio** ([00](./00-migracion-datos-e-identidad.md) §B.1);
  si no lo ofrece, hace falta un procedimiento manual documentado, porque en planta se
  olvidan contraseñas todas las semanas.
- **RN-04.4 — Perfil desactivado, no entra.** Si `is_active = false`, el login **se rechaza
  aquí** aunque el IS haya validado las credenciales: no se abre sesión, no se fijan cookies y
  se revocan en el IS los tokens que se hubieran emitido
  ([00](./00-migracion-datos-e-identidad.md) RN-00.30 y RN-00.38). El
  mensaje debe indicar que la cuenta está desactivada, no "credenciales inválidas".
- **RN-04.5** — "Recordar credenciales" sólo se ofrece en **runtime nativo** (app Android),
  nunca en navegador.
- **RN-04.6** — Al autenticarse se registra `last_connection_at`, throttlado (RN-02.7).
- **RN-04.7** — Los mensajes de error del proveedor se traducen a español antes de mostrarse
  (equivalente a `error-messages.ts` del legacy). Nada de textos crudos en inglés.
- **RN-04.8** — Al cerrar sesión se limpia todo estado local por usuario: sede seleccionada
  ([08-sedes-y-geocerca](./08-sedes-y-geocerca.md)), caché de consultas y preferencias de shell.
  Implementado en `useLogout` (`apps/frontend/src/modules/auth/session.ts`): invalida el caché de
  consultas y borra la copia local de la sede
  (`modules/locations/selection-cache.ts`). La selección **de verdad** vive en el perfil, en el
  servidor, así que lo que se borra aquí es sólo la caché.

## 4. Flujos

### 4.1 Inicio de sesión

```
formulario ──► POST /auth/login (NUESTRO backend)
                 │
                 ├─► POST {IS}/api/auth/sign-in { email, password, systemSlug }
                 │     ├─ 401 → credenciales inválidas
                 │     ├─ 403 → autenticado pero SIN ROL en este sistema  (RN-04.9)
                 │     └─ 200 → { user, token } + cabecera set-auth-token
                 │
                 ├─► perfil local por `sub`
                 │     ├─ is_active = false → RECHAZO + sign-out en el IS   (RN-04.4)
                 │     ├─ no existe        → se crea incompleto            (RN-04.2)
                 │     └─ activo           → sigue
                 │
                 └─► cookies httpOnly: session (larga) + jwt (~15 min)
                     resuelve perfil + roles + ámbito → devuelve el contexto
```

1. El navegador llama **siempre a nuestro backend**, nunca al IS
   ([00](./00-migracion-datos-e-identidad.md) RN-00.35).
2. **La comprobación del perfil ocurre antes de fijar cookies.** Un usuario desactivado no
   llega a tener sesión aquí.
3. Se resuelve el contexto de autorización (§5).
4. Si el rol lo requiere, se fuerza la **selección de sede** antes de continuar
   ([08-sedes-y-geocerca](./08-sedes-y-geocerca.md), RN-08.7).
5. Redirección al shell que corresponda ([05-shells-y-navegacion](./05-shells-y-navegacion.md)).

- **RN-04.10 — La desactivación también corta las sesiones ya abiertas.** No basta con
  bloquear el login: el middleware comprueba `is_active` en cada petición (el perfil ya se
  carga ahí, así que no cuesta un viaje extra) y expulsa a quien fue desactivado mientras
  tenía la app abierta.

- **RN-04.9 — El 403 del IS necesita mensaje propio.** "Tu cuenta existe pero no tiene acceso
  al control de asistencia; pide a tu administrador que te asigne un rol." Devolver
  "credenciales inválidas" ahí genera llamadas a soporte que no se resuelven nunca.

### 4.2 Renovación de sesión
El JWT dura ~15 minutos. Al caducar, el backend pide uno nuevo con
`GET {IS}/api/auth/token` usando el session token y reemplaza la cookie.
**Es transparente**: el usuario no vuelve a ver el login
([00](./00-migracion-datos-e-identidad.md) RN-00.37).

### 4.3 Cierre de sesión
`POST {IS}/api/auth/sign-out` con el session token **y** borrado de nuestras cookies. Sin lo
primero la sesión sigue viva en el IS.

### 4.4 Recuperación de contraseña
Fuera de esta aplicación: se resuelve en el IS (RN-04.3).

## 5. Contexto de autorización en cliente

Un único punto que expone: `user`, `profile`, `roles[]`, `effectiveRole`,
`managedDepartmentIds[]`, `isLoading`. Todo lo demás lo consume desde ahí.

- Debe distinguir **"cargando"** de **"no autenticado"**. Confundirlos produce parpadeos de
  redirección al inicio — problema conocido en este tipo de shells.
- El backend expone `GET /me/permissions` como fuente única (RN-03, §7); el cliente no
  recalcula roles **ni lee el JWT**: las cookies son `httpOnly` y el JavaScript del navegador
  no debe ver ningún token ([00](./00-migracion-datos-e-identidad.md) RN-00.36).
- Los roles vienen del IS y se cachean por sesión con TTL corto
  ([00](./00-migracion-datos-e-identidad.md) RN-00.41).

## 6. Guard de rutas

Equivalente a `ProtectedRoute` del legacy, con dos listas:

- `allowedRoles` — quién entra.
- `excludedRoles` — quién queda explícitamente fuera aunque su prioridad sea mayor
  (caso real: `/clock-in` excluye a `global_manager`).

Ambas se combinan. Implementación: `ROUTE_ACCESS` y `canAccess` en
`apps/frontend/src/modules/auth/navigation.ts` —la **misma** tabla que filtra el aside, para que
guard y menú no puedan discrepar— y el componente `RequireRole`, que redirige al destino por
defecto del rol (`defaultRouteFor`).

> ⚠️ **No se resuelve en `beforeLoad`,** que es lo que proponía esta spec. Las cookies de sesión
> pertenecen al origen del backend y el SSR del frontend no las ve (§5, y
> [00](./00-migracion-datos-e-identidad.md) §C.9 decisión 1): un `beforeLoad` que consultara la
> sesión recibiría "no autenticado" en cada render de servidor y mandaría al login a todo el
> mundo. Mientras frontend y backend vivan en orígenes distintos, el guard se resuelve en
> cliente, igual que el del layout. Si algún día se sirven bajo el mismo origen, esto puede
> pasar a `beforeLoad` sin cambiar la tabla de acceso.

## 7. Móvil

- **El patrón de cookies `httpOnly` no se traslada tal cual a un cliente nativo.** Ésta es la
  principal atadura entre esta spec, [00](./00-migracion-datos-e-identidad.md) §C.9 y
  [20-app-movil-y-distribucion](./20-app-movil-y-distribucion.md) §2: la forma de la app móvil
  decide cómo se custodian los tokens allí. Se deciden juntas.
- En runtime nativo la app corre desde `file://`, que **no soporta rutas por path**: hay que
  usar enrutado por hash (el legacy intercambiaba `BrowserRouter` → `HashRouter`).
- La sesión debe sobrevivir al cierre de la app: el session token es de larga duración y en
  nativo debe guardarse en almacenamiento seguro del sistema, no en `localStorage`.

## 8. Criterios de aceptación

- [x] El login funciona contra el IS con `systemSlug = control-asistencia`.
- [x] Un usuario sin rol en el sistema recibe el mensaje de RN-04.9, no "credenciales inválidas".
- [x] El JWT se verifica localmente contra el JWKS, sin llamar al IS en cada petición.
- [x] Con el JWT caducado, la siguiente petición se renueva sola y el usuario no lo nota.
- [x] El JavaScript del navegador no puede leer el session token ni el JWT. *(Las dos cookies
      salen `HttpOnly; Secure; SameSite=None`.)*
- [x] Cerrar sesión revoca en el IS y borra las cookies. *(La sede seleccionada, con la
      [08](./08-sedes-y-geocerca.md): todavía no existe.)*
- [x] Un usuario con el perfil desactivado **no obtiene sesión** y recibe "cuenta desactivada".
- [x] Ese rechazo no deja tokens vivos en el IS.
- [x] Desactivar a alguien con la app abierta lo expulsa en su siguiente petición (RN-04.10).
- [x] Un usuario sin departamento asignado entra y ve por qué (pantalla de cuenta pendiente).
      *(El bloqueo del marcaje en sí, con la [09](./09-marcaje-asistencia.md).)*
- [x] Al recargar la página autenticado no hay parpadeo de redirección al login. *(El layout
      distingue "cargando" de "no autenticado" y pinta esqueleto mientras tanto.)*
- [ ] Un `global_manager` que entra a `/clock-in` es redirigido, no ve la pantalla vacía.
      *(La ruta llega con la [09](./09-marcaje-asistencia.md); el guard que la redirigirá ya
      está, §6.)*
- [x] No queda ninguna referencia a better-auth en el proyecto.

## 9. Decisiones abiertas

1. ¿El backend de Hono o las funciones de servidor de TanStack Start hablan con el IS?
   ([00](./00-migracion-datos-e-identidad.md) §C.9, decisión 1 — recomendación: Hono.)
2. Custodia de tokens en la app móvil (§7), atada a
   [20](./20-app-movil-y-distribucion.md) §2.
3. ¿El IS ofrece recuperación de contraseña autoservicio? (RN-04.3)
4. Duración de la sesión: el session token del IS dura días. Para operarios en planta eso es
   lo deseable; confirmar que no choca con la política de seguridad de Elineas.
