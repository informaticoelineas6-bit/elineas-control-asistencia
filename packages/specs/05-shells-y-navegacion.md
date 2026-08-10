# 05 · Shells de interfaz y navegación

> **Origen:** `old-docs.md` Parte 2 (dos shells), puntos 11, 12, 13, 14.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe (hay componentes `ui/` sueltos y un `__root.tsx` mínimo).
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
| Marcar | `/marcar` | Botón de marcaje + estado de geocerca ([09](./09-marcaje-asistencia.md)) |
| Mi semana | `/mi-semana` | Historial propio de la semana ([09](./09-marcaje-asistencia.md) §historial) |
| Incidencias | `/incidencias` | Propias, con contador de pendientes ([12](./12-incidencias.md)) |
| Perfil | `/perfil` | Datos, descansos, vacaciones, cerrar sesión |

- **RN-05.4** — El destino por defecto tras iniciar sesión es *Marcar*.
- **RN-05.5** — Los badges de la barra inferior (incidencias pendientes, notificaciones) se
  actualizan sin recargar.
- **RN-05.6** — Debe funcionar con una sola mano y sin scroll para la acción principal.

## 4. AdminShell

Barra lateral con navegación **agrupada** y filtrada por rol:

- **Asistencia** — Inicio · Marcar¹ · Historial · Mi semana
- **Gestión** — Departamento² · Panel global³ · Incidencias · Usuarios³ · Departamentos³ · Nómina³ · Reportes
- **Sistema** — Configuración³ · Notificaciones · Superadmin⁴

¹ oculto para `global_manager`/`superadmin` (no marcan).
² sólo `department_head`. ³ sólo `global_manager`/`superadmin`. ⁴ sólo `superadmin`.

- **RN-05.7** — Los ítems del menú a los que el rol no tiene acceso **no se muestran**, no se
  muestran deshabilitados.
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
- **RN-05.11** — Los estados de carga usan esqueletos, no spinners a pantalla completa, en
  las vistas con datos tabulares.

## 6. Criterios de aceptación

- [ ] Un `employee` en móvil ve la barra inferior; el mismo usuario en escritorio ve la lateral.
- [ ] Un `superadmin` en móvil ve el AdminShell (con barra inferior de respaldo).
- [ ] `?ui=admin` como `employee` muestra el armazón pero cada ruta protegida sigue redirigiendo.
- [ ] Un error lanzado dentro de una página no deja la aplicación en blanco.
- [ ] Ningún mensaje de error del proveedor de datos llega al usuario en inglés.

## 7. Decisiones abiertas

1. ¿Se conserva el override `?ui=` en producción o queda tras una bandera de desarrollo?
2. ¿El `department_head` en escritorio necesita también acceso rápido a marcar?
3. Rutas en español (`/marcar`, `/mi-semana`) — confirmar que se mantiene la convención del
   legacy en el sistema nuevo.
