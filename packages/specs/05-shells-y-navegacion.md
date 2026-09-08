# 05 · Shells de interfaz y navegación

> **Origen:** `old-docs.md` Parte 2 (dos shells), puntos 11, 12, 13, 14.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementada, **los dos shells**. Fue lo último que quedó
> abierto de los cimientos, y se cerró al final a propósito: la regla de resolución de §2 no
> tenía entre qué elegir mientras el EmployeeShell no existiera, y el EmployeeShell no tenía qué
> enseñar mientras sus cuatro destinos fueran marcadores. Ahora los cuatro existen.
>
> **AdminShell**: aside colapsable filtrado por rol, cabecera con campana, guard de página,
> pantalla de cuenta pendiente y **barra inferior de respaldo en móvil** (RN-05.9)
> —`routes/_authed.tsx`, `components/app-sidebar.tsx`, `modules/shells/admin-bottom-bar.tsx`—.
> **EmployeeShell**: `modules/shells/employee-shell.tsx`, con su barra inferior de cuatro
> destinos y su badge. **La regla de §2** vive en `modules/shells/resolve.ts` —función pura, con
> **la primera prueba del frontend del repositorio**— y lo que necesita entorno, en
> `use-shell.ts`. Las tres capas de contención de errores de §5 siguen en `modules/errors/`.
>
> Ya no hay ningún marcador: las diecinueve rutas de §7 tienen su pantalla.
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

> ✅ **La regla vive en una función pura de cinco líneas** (`resolveShell`), separada del hook
> que la alimenta. Es la parte de esta spec que más se parece a una regla de negocio —cuatro
> casos y un override que los pisa— y probarla no debería exigir abrir un navegador y
> redimensionar una ventana. De ahí que sea la primera prueba del frontend del repositorio.
>
> **Decisión 1 de la §8, cerrada: el override `?ui=` se queda en producción**, y con un tercer
> valor que la spec no nombraba —`?ui=auto`— para poder deshacerlo. Dos razones:
>
> - **No puede otorgar nada.** RN-05.2 y RN-05.3 ya lo dicen y el código lo cumple: `?ui=admin`
>   como `employee` pinta el armazón y cada ruta sigue echando a quien no le toca, porque el
>   filtrado y el guard salen de `canAccess`. Esconder detrás de una bandera algo que no puede
>   hacer daño es ceremonia.
> - **Es la única forma de ver lo que ve un operario.** Un jefe de planta que llama para decir
>   "no me deja marcar" describe una pantalla que en un escritorio no se puede reproducir de otra
>   manera.
>
> Lo que sí hizo falta decidir: **el override se recuerda en la pestaña** (`sessionStorage`).
> Sin eso se perdería en el primer enlace que se pulse y no serviría para nada. Y en la pestaña
> —no en una cookie— porque una herramienta de depuración no debe seguir a nadie a la sesión
> siguiente ni contaminar otra ventana.
>
> ⚠️ **El primer render no sabe el ancho de la ventana.** En el servidor no hay viewport que
> medir, así que sale el AdminShell y el efecto corrige en el cliente. Es la misma concesión que
> ya hacía el aside de shadcn y se nota menos que su alternativa: pintar nada hasta saberlo.

## 3. EmployeeShell

Navegación inferior de cuatro destinos:

| Destino | Ruta | Contenido |
|---|---|---|
| Marcar | `/clock-in` | Botón de marcaje + estado de geocerca ([09](./09-marcaje-asistencia.md)) |
| Mi semana | `/my-week` | Historial propio de la semana ([09](./09-marcaje-asistencia.md) §historial) |
| Incidencias | `/incidents` | Propias, con contador de pendientes ([12](./12-incidencias.md), ✅) |
| Perfil | `/profile` | Datos, descansos ([10](./10-descansos.md), ✅), vacaciones ([11](./11-vacaciones.md), ✅), cerrar sesión |

- **RN-05.4** — El destino por defecto tras iniciar sesión es *Marcar*.
- **RN-05.5** — Los badges de la barra inferior (incidencias pendientes, notificaciones) se
  actualizan sin recargar. *(En el AdminShell ya se cumple: toda mutación de incidencias
  invalida su conteo y el de notificaciones.)*
- **RN-05.6** — Debe funcionar con una sola mano y sin scroll para la acción principal.

> ✅ **Construido**, y las decisiones que lo hacen usable son de tamaño y de posición:
>
> - **La barra va abajo**, donde llega el pulgar. Un menú arriba en un teléfono de seis pulgadas
>   obliga a recolocar la mano en cada toque.
> - **Cada destino mide 56 px de alto y lleva su etiqueta debajo del icono.** Un icono solo se
>   adivina, y en planta —con prisa, con guantes— adivinar cuesta toques.
> - **Respeta el área segura del sistema.** Sin `env(safe-area-inset-bottom)`, en un iPhone el
>   último destino queda debajo de la barra del sistema.
> - **El contenido es lo único que hace scroll**: la barra no se va nunca, así que *Marcar* está
>   siempre a un toque. Eso **es** RN-05.6.
>
> Y una decisión sobre *Mi semana* que merece quedar dicha: **reutiliza los datos, no el
> diseño.** Es la misma consulta que *Mi asistencia* —el mismo endpoint ya agregado por el
> servidor (spec 15 §4)— pero un calendario de seis semanas y una tabla de cinco columnas en 375
> px es justo lo que este shell existe para evitar. Son siete tarjetas en una columna. Lo que sí
> se comparte son las etiquetas y los formatos (`day-presentation.ts`), que salieron de
> `history.tsx` al llegar la segunda vista: dos tablas para los mismos seis estados acabarían
> diciendo cosas distintas del mismo día, y en dos pantallas que abre la misma persona.
>
> **RN-05.4** se cumple con `defaultRouteFor(role, shell)`: en el EmployeeShell el destino es
> *Marcar*, en el AdminShell es *Inicio*. Depende del shell y no sólo del rol porque **la misma
> persona quiere cosas distintas según desde dónde entre** — un jefe en el teléfono va a marcar;
> el mismo jefe en su escritorio va a mirar a su equipo.

## 4. AdminShell

Barra lateral con navegación **agrupada** y filtrada por rol. Agrupación implementada
(`apps/frontend/src/modules/auth/navigation.ts`):

| Grupo | Ítems | Quién lo ve |
|---|---|---|
| **Personal** | Inicio · Marcar¹ · Mi asistencia¹ · Mi perfil · Diagnóstico GPS² | todos |
| **Gestión** | Asistencia del día⁴ · Mi equipo · Descansos³ · Reportes | `department_head` y por encima |
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

⁴ es el panel de departamento **y** el global de la [15](./15-paneles-y-dashboard.md) §5.2/§5.3,
que son la misma vista con distinto alcance: quien la abre ve su ámbito. Va antes de *Mi equipo*
porque el orden es el del trabajo — primero se mira cómo va el día, luego se decide sobre lo que
quedó pendiente.

> **Esta agrupación sustituye a la del borrador** (*Asistencia · Gestión · Sistema*), que
> mezclaba en un mismo grupo lo que uno hace consigo mismo y lo que hace con su equipo. La
> división real es por **de quién son los datos**: los míos, los de mi gente, los de la empresa.
>
> Del borrador quedaban dos por colocar y **ya están los dos**, en sitios distintos y por
> motivos distintos: *Superadmin* es un ítem de *Administración* sólo para `superadmin`
> ([19](./19-panel-superadmin.md)), y *Mi semana* **no es un ítem del aside** — vive en la barra
> inferior del EmployeeShell (§3), porque en escritorio la vista que sirve es *Mi asistencia* y
> tener las dos en el menú sería ofrecer dos veces el mismo dato. El *Panel global* del borrador
> **no existe como ítem propio**: la [15](./15-paneles-y-dashboard.md) lo unificó con el de
> departamento en *Asistencia del día*, porque son la misma vista con distinto alcance.
> *Incidencias* ya está, en *Personal* y con badge: la ve cualquier rol porque la
> [12](./12-incidencias.md) §7 dice "autenticado" y no invoca RN-03.4 como sí hace la
> [11](./11-vacaciones.md) con las vacaciones.
> *Notificaciones* no es un ítem de menú: es la **campana de la cabecera**, que es donde se
> mira sin abandonar lo que se está haciendo.

- **RN-05.7** — Los ítems del menú a los que el rol no tiene acceso **no se muestran**, no se
  muestran deshabilitados. El filtrado y el guard de página salen de **la misma tabla**
  (`ROUTE_ACCESS`, spec 04 §6): si un enlace no se ofrece, su ruta tampoco se abre
  escribiéndola a mano.
  > ⚠️ **Se cumplía a medias hasta la [12](./12-incidencias.md).** El aside filtraba
  > comparando `item.roles` a mano en vez de llamar a `canAccess`, y con eso se perdía la
  > **lista de exclusión**: a un `global_manager` se le ofrecían *Marcar* y *Mi asistencia*
  > para que el guard lo echara acto seguido. Es exactamente el fallo que esta regla describe,
  > y sólo podía pasar por tener la comprobación escrita dos veces. Corregido: el aside llama a
  > `canAccess`, la misma función que el guard.
- **RN-05.8** — Los grupos con pendientes muestran badge con el conteo (incidencias por
  revisar, vacaciones por aprobar, ausencias sin justificar). *Implementado con la
  [12](./12-incidencias.md) y extendido por la [13](./13-justificacion-ausencias.md). El badge se
  declara en la tabla de navegación como un identificador (`badge: "incidents-own"`), no como un
  número, para que `navigation.ts` siga siendo datos puros y el guard pueda leerla sin arrastrar
  consultas.*
  > Hoy son dos: **Incidencias**, con las propias sin revisar, y **Mi equipo**, que **suma** las
  > incidencias por revisar y las ausencias sin clasificar. Sumarlas y no partirlas es
  > deliberado: el badge de un ítem de menú responde *"¿tengo algo que hacer ahí?"*, y abrir la
  > página ya separa de qué se trata. Las vacaciones por aprobar entran igual cuando haga falta,
  > con una línea.
- **RN-05.9** — En viewport móvil el AdminShell conserva una barra inferior de respaldo con
  los destinos principales; la barra lateral pasa a ser un panel desplegable.
  > ✅ La segunda mitad ya la cumplía el aside —en pantallas pequeñas se convierte en panel
  > deslizante— y la primera se añadió con **una lista corta y explícita**: *Inicio*, *Asistencia
  > del día*, *Mi equipo* y *Usuarios*, filtrados por `canAccess`. No son "los primeros de cada
  > grupo" porque lo que un gestor abre desde el teléfono no es lo primero del menú: es cómo va
  > el día y qué espera por él.

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

- [x] Un `employee` en móvil ve la barra inferior; el mismo usuario en escritorio ve la lateral.
      *(Y un `department_head` también ve la de empleado en el móvil, que es lo que la §2 pide
      explícitamente: también marca. Los cuatro casos de la regla tienen prueba.)*
- [x] Un `superadmin` en móvil ve el AdminShell (con barra inferior de respaldo).
- [x] `?ui=admin` como `employee` muestra el armazón pero cada ruta protegida sigue redirigiendo.
      *(El override sólo entra en `resolveShell`, que no mira permisos; el filtrado del menú y el
      guard siguen saliendo de `canAccess`.)*
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
| `/dashboard` | Inicio | ✅ ([15](./15-paneles-y-dashboard.md) §5.1) |
| `/clock-in` | Marcar | ✅ ([09](./09-marcaje-asistencia.md)) |
| `/attendance` | Mi asistencia | ✅ ([09](./09-marcaje-asistencia.md)) |
| `/profile` | Mi perfil | ✅ |
| `/gps` | Diagnóstico GPS | ✅ ([08](./08-sedes-y-geocerca.md) §6) |
| `/incidents` | Incidencias | ✅ ([12](./12-incidencias.md)) |
| `/daily` | Asistencia del día | ✅ ([15](./15-paneles-y-dashboard.md) §5.2 y §5.3, en una sola vista) |
| `/team` | Mi equipo | ✅ ([11](./11-vacaciones.md), [12](./12-incidencias.md) y [13](./13-justificacion-ausencias.md)) |
| `/rest-days` | Descansos | ✅ ([10](./10-descansos.md)) |
| `/reports` | Reportes | ✅ ([16](./16-reporteria-mensual.md)) |
| `/users` | Usuarios | ✅ ([02](./02-usuarios-y-perfiles.md)) |
| `/departments` | Departamentos | ✅ ([01](./01-organizacion-departamentos.md)) |
| `/payroll` | Nómina | ✅ ([17](./17-nomina.md)) |
| `/settings` | Configuración | ✅ ([06](./06-configuracion-global.md)) |
| `/logs` | Logs | ✅ ([18](./18-auditoria.md)) |
| `/admin` | Superadmin | ✅ ([19](./19-panel-superadmin.md)) |
| `/notifications` | — (se llega desde la campana) | ✅ ([14](./14-notificaciones.md) §8) |
| `/my-week` | Mi semana | ✅ (§3, en la barra inferior del EmployeeShell) |

> **`/notifications` no está en el aside**, y es la única ruta del AdminShell que no está en
> ninguna sección del menú. Se llega desde la campana, que ya está siempre visible en la
> cabecera; ponerla además en el menú pondría al mismo nivel una pantalla y un icono que la
> abre. Es también la única sin `RequireRole`: no hay rol que comprobar porque no hay ámbito
> —cada persona ve las suyas y sólo las suyas (spec 14 RN-14.1)—, así que no existe una versión
> "de más" de esa pantalla que haya que esconder.

**Ya no queda ninguna ruta prevista sin construir**: `/my-week` llegó con el EmployeeShell y,
como `/notifications`, no está en el aside — se llega por la barra inferior. La otra que faltaba, la de incidencias, ya
está — pero como **`/incidents`** y no como el `/issues` que decía la §3: eran dos palabras
inglesas para la misma cosa, y la tabla, el tipo, el servicio y el módulo de la
[12](./12-incidencias.md) ya se llaman *incident*. La etiqueta sigue siendo *Incidencias*, que
es lo que lee una persona. `/clock-in` ya existe
—llegó con la [09](./09-marcaje-asistencia.md)— pero vive **dentro del AdminShell**: está
hecha en columna estrecha y con el botón grande, así que al construir el EmployeeShell se
monta sin rehacerla.

> La sección que la [18](./18-auditoria.md) llama **bitácora** se presenta en la interfaz como
> **Logs**, en `/logs`. Es la única etiqueta de menú que no está en español: "Logs" es como la
> nombra quien la va a usar —sólo la ve un `superadmin`— y "Bitácora de auditoría" no le decía
> nada a nadie. La spec conserva el término en su prosa.

## 8. Decisiones abiertas

1. ~~¿Se conserva el override `?ui=` en producción o queda tras una bandera de desarrollo?~~
   **Cerrada: se conserva**, y se recuerda en la pestaña. No puede otorgar permisos y es la única
   forma de reproducir lo que ve un operario. Ver §2.
2. ~~¿El `department_head` en escritorio necesita también acceso rápido a marcar?~~ **Cerrada: ya
   lo tiene, y no hacía falta añadir nada.** *Marcar* está en el grupo *Personal* de su aside
   desde el principio —la exclusión de RN-03.4 sólo alcanza al gestor global—, así que la
   pregunta se responde mirando el menú. Lo que sí cambió es a dónde entra: desde el teléfono,
   directo a *Marcar* (RN-05.4).
3. ~~Rutas en español (`/marcar`, `/mi-semana`) — confirmar que se mantiene la convención del
   legacy en el sistema nuevo.~~ **Resuelta: no se mantiene.** Todo el código —rutas incluidas—
   se escribe en inglés; la interfaz sigue en español. Ver §8.
