# 05 · Shells de interfaz y navegación

> **Origen:** `old-docs.md` Parte 2 (dos shells), puntos 11, 12, 13, 14.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ⚠️ parcial. Existe el **AdminShell** con aside colapsable
> filtrado por rol, cabecera con campana de notificaciones, guard de página y pantalla de cuenta
> pendiente (`apps/frontend/src/routes/_authed.tsx`, `components/app-sidebar.tsx`,
> `modules/auth/navigation.ts`), y las **tres capas de contención de errores** de §5
> (`modules/errors/`, declaradas en `router.tsx` y en `routes/__root.tsx`). Falta el
> **EmployeeShell** entero (§3), la regla de resolución de shell (§2) y los badges de pendientes
> (RN-05.8). Las secciones que aún no tienen spec implementada son marcadores.
> **Depende de:** [04-autenticacion](./04-autenticacion.md), [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).

---

## 1. Objetivo

La aplicación tiene **dos interfaces distintas sobre el mismo backend**, porque atiende a
dos usos incompatibles:

- **EmployeeShell** — operario en planta, con el móvil en la mano. Pocas acciones, botones
  grandes, navegación inferior. Lo importante es marcar rápido.
- **AdminShell** — backoffice en escritorio. Barra lateral, tablas densas, filtros,
  exportaciones.

No son dos aplicaciones: son dos envolturas de navegación sobre las mismas rutas y datos.

## 2. Regla de resolución del shell

```
viewport < 768px  Y  rol no administrativo  →  EmployeeShell
en cualquier otro caso                      →  AdminShell
```

Donde "rol administrativo" = `global_manager` o `superadmin`.
`department_head` **no** es administrativo a estos efectos: en el móvil ve el shell de
empleado (porque también marca), en escritorio ve el de admin.

- **RN-05.1** — La resolución es reactiva al tamaño de viewport (rotar el dispositivo o
  redimensionar la ventana cambia el shell sin recargar).
- **RN-05.2** — Se puede forzar con `?ui=employee` / `?ui=admin` **para depuración**. El
  override no otorga permisos: un `employee` con `?ui=admin` ve el armazón de admin pero
  cada ruta sigue protegida por su guard.
- **RN-05.3** — El shell nunca decide permisos. Sólo decide qué se muestra en el menú.

## 3. EmployeeShell

Navegación inferior de cuatro destinos:

| Destino | Ruta | Contenido |
|---|---|---|
| Marcar | `/clock-in` | Botón de marcaje + estado de geocerca ([09](./09-marcaje-asistencia.md)) |
| Mi semana | `/my-week` | Historial propio de la semana ([09](./09-marcaje-asistencia.md) §historial) |
| Incidencias | `/issues` | Propias, con contador de pendientes ([12](./12-incidencias.md)) |
| Perfil | `/profile` | Datos, descansos ([10](./10-descansos.md), ✅), vacaciones ([11](./11-vacaciones.md), ✅), cerrar sesión |

- **RN-05.4** — El destino por defecto tras iniciar sesión es *Marcar*.
- **RN-05.5** — Los badges de la barra inferior (incidencias pendientes, notificaciones) se
  actualizan sin recargar.
- **RN-05.6** — Debe funcionar con una sola mano y sin scroll para la acción principal.

## 4. AdminShell

Barra lateral con navegación **agrupada** y filtrada por rol. Agrupación implementada
(`apps/frontend/src/modules/auth/navigation.ts`):

| Grupo | Ítems | Quién lo ve |
|---|---|---|
| **Personal** | Inicio · Marcar¹ · Mi asistencia¹ · Mi perfil · Diagnóstico GPS² | todos |
| **Gestión** | Mi equipo · Descansos³ · Reportes | `department_head` y por encima |
| **Administración** | Usuarios · Departamentos · Nómina · Configuración | `global_manager` y por encima |
| | Logs | sólo `superadmin` |

¹ excluido para `global_manager`, que no marca (RN-03.4). `superadmin` sí lo ve, porque hereda
todo lo anterior.

² lo ve **cualquier rol**, incluido el gestor global que no marca ([08](./08-sedes-y-geocerca.md)
§6): quien la usa de verdad es el jefe en planta con el teléfono de otro en la mano, resolviendo
un "dice que estoy fuera y estoy dentro".

³ empieza en `department_head` y **no** en *Administración* porque asignar personas a un grupo de
descanso es su operación ([10](./10-descansos.md) §4): los grupos los define un gestor, pero
quien organiza el turno de su gente es el jefe. Los descansos **propios** no están ahí, están en
*Mi perfil*.

> **Esta agrupación sustituye a la del borrador** (*Asistencia · Gestión · Sistema*), que
> mezclaba en un mismo grupo lo que uno hace consigo mismo y lo que hace con su equipo. La
> división real es por **de quién son los datos**: los míos, los de mi gente, los de la empresa.
>
> Del borrador quedan por colocar, cuando existan sus specs: *Historial* y *Mi semana*
> ([09](./09-marcaje-asistencia.md)), *Incidencias* ([12](./12-incidencias.md)), *Panel global*
> ([15](./15-paneles-y-dashboard.md)) y *Superadmin* ([19](./19-panel-superadmin.md)).
> *Notificaciones* no es un ítem de menú: es la **campana de la cabecera**, que es donde se
> mira sin abandonar lo que se está haciendo.

- **RN-05.7** — Los ítems del menú a los que el rol no tiene acceso **no se muestran**, no se
  muestran deshabilitados. El filtrado y el guard de página salen de **la misma tabla**
  (`ROUTE_ACCESS`, spec 04 §6): si un enlace no se ofrece, su ruta tampoco se abre
  escribiéndola a mano.
- **RN-05.8** — Los grupos con pendientes muestran badge con el conteo (incidencias por
  revisar, vacaciones por aprobar, ausencias sin justificar).
- **RN-05.9** — En viewport móvil el AdminShell conserva una barra inferior de respaldo con
  los destinos principales; la barra lateral pasa a ser un panel desplegable.

## 5. Contención de errores

Tres capas, heredadas del legacy:

1. **Frontera de error de aplicación** — captura cualquier fallo de render y muestra una
   pantalla recuperable con opción de recargar. Nunca pantalla en blanco.
2. **Frontera de error de rutas** — errores de carga de datos de una ruta concreta, sin
   tumbar el shell.
3. **404** — ruta no encontrada, con enlace de vuelta al destino por defecto del rol.

- **RN-05.10** — Todo error de backend se traduce a un mensaje en español antes de mostrarse
  (equivalente a `error-messages.ts`). El código técnico se registra, no se enseña.
  Implementación: `friendlyError` en `apps/frontend/src/modules/errors/messages.ts`, y **un
  solo** componente `InlineError` para los errores dentro de pantalla. Que sea uno solo es la
  regla: cuando cada pantalla repetía el bloque y pintaba `error.message` en crudo, bastaba un
  fallo de red para que a un operario le apareciera "Failed to fetch" en inglés.
- **RN-05.11** — Los estados de carga usan esqueletos, no spinners a pantalla completa, en
  las vistas con datos tabulares.

## 6. Criterios de aceptación

- [ ] Un `employee` en móvil ve la barra inferior; el mismo usuario en escritorio ve la lateral.
      *(Falta el EmployeeShell, §3.)*
- [ ] Un `superadmin` en móvil ve el AdminShell (con barra inferior de respaldo). *(Falta la
      barra de respaldo, RN-05.9.)*
- [ ] `?ui=admin` como `employee` muestra el armazón pero cada ruta protegida sigue redirigiendo.
      *(Falta el override, RN-05.2.)*
- [x] Un error lanzado dentro de una página no deja la aplicación en blanco.
- [x] Una ruta que no existe muestra un 404 con vuelta al destino por defecto del rol.
- [x] Ningún mensaje de error del proveedor de datos llega al usuario en inglés.

## 7. Convención de rutas

**Las rutas van en inglés, la interfaz en español.** Es la convención del monorepo entero
([contributing.md](../docs/contributing.md) §idioma): identificadores, nombres de archivo y
rutas en inglés; todo lo que lee una persona —etiquetas, mensajes de error, textos de ayuda— en
español, que además es obligatorio por RN-05.10.

La ruta nombra el **recurso**; la etiqueta habla de la relación del usuario con él. No tienen
por qué coincidir, y no coinciden: *Mi asistencia* vive en `/attendance`. Meter el posesivo en
la URL sobraba — `/attendance` ya es la asistencia de quien la abre, porque no hay otra que
pueda ver desde ahí.

| Ruta | Etiqueta | Estado |
|---|---|---|
| `/login` | Entrar | ✅ |
| `/pending-account` | Cuenta pendiente | ✅ |
| `/dashboard` | Inicio | ✅ |
| `/clock-in` | Marcar | ✅ ([09](./09-marcaje-asistencia.md)) |
| `/attendance` | Mi asistencia | ✅ ([09](./09-marcaje-asistencia.md)) |
| `/profile` | Mi perfil | ✅ |
| `/gps` | Diagnóstico GPS | ✅ ([08](./08-sedes-y-geocerca.md) §6) |
| `/team` | Mi equipo | ✅ ([11](./11-vacaciones.md); crece con las specs 12 y 13) |
| `/rest-days` | Descansos | ✅ ([10](./10-descansos.md)) |
| `/reports` | Reportes | marcador ([16](./16-reporteria-mensual.md)) |
| `/users` | Usuarios | ✅ ([02](./02-usuarios-y-perfiles.md)) |
| `/departments` | Departamentos | ✅ ([01](./01-organizacion-departamentos.md)) |
| `/payroll` | Nómina | marcador ([17](./17-nomina.md)) |
| `/settings` | Configuración | ✅ ([06](./06-configuracion-global.md)) |
| `/logs` | Logs | marcador ([18](./18-auditoria.md)) |

Rutas previstas que aún no existen: `/my-week` y `/issues` (§3). `/clock-in` ya existe
—llegó con la [09](./09-marcaje-asistencia.md)— pero vive **dentro del AdminShell**: está
hecha en columna estrecha y con el botón grande, así que al construir el EmployeeShell se
monta sin rehacerla.

> La sección que la [18](./18-auditoria.md) llama **bitácora** se presenta en la interfaz como
> **Logs**, en `/logs`. Es la única etiqueta de menú que no está en español: "Logs" es como la
> nombra quien la va a usar —sólo la ve un `superadmin`— y "Bitácora de auditoría" no le decía
> nada a nadie. La spec conserva el término en su prosa.

## 8. Decisiones abiertas

1. ¿Se conserva el override `?ui=` en producción o queda tras una bandera de desarrollo?
2. ¿El `department_head` en escritorio necesita también acceso rápido a marcar?
3. ~~Rutas en español (`/marcar`, `/mi-semana`) — confirmar que se mantiene la convención del
   legacy en el sistema nuevo.~~ **Resuelta: no se mantiene.** Todo el código —rutas incluidas—
   se escribe en inglés; la interfaz sigue en español. Ver §8.
