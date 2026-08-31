# 20 · App móvil Android y distribución

> **Origen:** `old-docs.md` §3.6 (`app_releases`), puntos 66, 67, 68, 77.
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ compilación y firma 100 % manuales, seguimiento en segundo plano deficiente.
> **Preparado en el monorepo:** la capa de ubicación del cliente
> ([08](./08-sedes-y-geocerca.md) §4) está aislada en
> `apps/frontend/src/modules/geolocation/location-layer.ts` y su interfaz no menciona
> `navigator`: el proveedor nativo entra cambiando la implementación de esas cuatro funciones, sin
> tocar ninguna pantalla. Hoy sólo hay seguimiento **en primer plano**.
> **Estado en el monorepo nuevo:** ❌ no existe. **La migración del frontend a TanStack Start invalida el empaquetado anterior.**
> **Depende de:** [04-autenticacion](./04-autenticacion.md), [08-sedes-y-geocerca](./08-sedes-y-geocerca.md), [19-panel-superadmin](./19-panel-superadmin.md).

---

## 1. Objetivo

Entregar la aplicación como APK Android instalable (`com.elineas.asistencia`), y distribuirla
desde la propia web sin pasar por Google Play.

> ⚠️ **Advertencia de alcance.** El legacy empaquetaba una SPA de Vite con Capacitor. El
> monorepo usa **TanStack Start con SSR**, que no es directamente empaquetable como estático.
> Antes de dar esta spec por válida hay que resolver **cómo se construye el cliente móvil**:
> ver §2. Esta es la spec con más incertidumbre técnica del conjunto.

## 2. Cómo se construye el cliente móvil — las opciones

La API del backend es la misma en las cinco: esta decisión **no** afecta a las specs 01–19,
sólo al empaquetado, a §4–§6 y a **cómo se custodian los tokens del Identity Server**
([00](./00-migracion-datos-e-identidad.md) §C.9, [04](./04-autenticacion.md) §7).

**Se puede aplazar sin bloquear nada**, con una condición: mantener la spec
[04](./04-autenticacion.md) hablando con el backend por HTTP y no atar la sesión al
mecanismo de cookies del navegador más de lo imprescindible.

### Resumen

| | Opción | Esfuerzo | GPS en 2.º plano | Funciona sin señal | Reutiliza la web |
|---|---|---|---|---|---|
| **(a)** | PWA — sin APK | ▁ mínimo | ❌ | parcial | 100 % |
| **(b)** | WebView remoto (Capacitor apuntando a la web desplegada) | ▁▁ bajo | ⚠️ limitado | ❌ | 100 % |
| **(c)** | Capacitor con build estático empaquetado | ▁▁▁ medio | ⚠️ limitado | parcial | ~95 % |
| **(d)** | React Native / Expo — cliente propio | ▁▁▁▁▁ alto | ✅ real | ✅ | 0 % (sí la API) |
| **(e)** | Kotlin nativo | ▁▁▁▁▁▁ muy alto | ✅ real | ✅ | 0 % |

### (a) PWA — no hay app, hay web instalable

El empleado abre la web en el móvil y la "añade a la pantalla de inicio". Sin APK, sin firma,
sin distribución.

- **A favor:** desaparece toda esta spec. Una sola base de código, un solo despliegue, cero
  fricción de actualización (siempre está la última versión). La geolocalización puntual al
  marcar **funciona perfectamente** en el navegador.
- **En contra:** nada de segundo plano. El icono en la pantalla de inicio es un paso que hay
  que enseñar uno por uno. En Android el navegador puede pedir permiso de ubicación cada vez
  según la configuración.
- **Cuándo es la respuesta correcta:** si basta con leer la ubicación **en el momento de
  marcar** — que es lo que realmente hace el producto hoy.

### (b) WebView remoto — un APK que abre la web

Un contenedor Capacitor mínimo cuya única función es cargar `https://asistencia.elineas.com`
en un WebView, con los plugins nativos de geolocalización y notificaciones.

- **A favor:** casi todo el beneficio del APK (icono, permisos nativos, instalación) con el
  coste de un proyecto vacío. **Se actualiza solo**: el contenido es la web desplegada, así
  que no hay que republicar el APK por cada cambio — muere la deuda de la flota
  desactualizada (RN-20.9).
- **En contra:** sin conexión no arranca ni la pantalla de login. El puente entre el WebView y
  los plugins nativos hay que construirlo con cuidado si la web tiene que llamar a GPS nativo.
- **Cuándo:** si se quiere un APK ya, con el mínimo trabajo, y la señal en las sedes es
  fiable.

### (c) Capacitor con el build empaquetado — lo que hacía el legacy

Se genera un build estático del frontend y se empaqueta dentro del APK.

- **A favor:** el camino conocido; el `android/` del legacy es reaprovechable en parte.
  Arranca sin red hasta la pantalla de login.
- **En contra:** **hay que verificar que TanStack Start produzca un build estático usable**
  (prerender/SPA sin SSR en ejecución) — es la incógnita técnica de esta spec. Y vuelve el
  enrutado por hash por el origen `file://`. Cada cambio exige republicar el APK.
- **Cuándo:** si (b) se queda corto y no se justifica (d).

### (d) React Native / Expo — cliente propio contra la misma API

Aplicación nativa de verdad, compartiendo con la web sólo los contratos de `packages/contracts`
y los esquemas de `packages/validations`.

- **A favor:** **resuelve de raíz la deuda del punto 77** — geolocalización en segundo plano
  con servicio nativo real, que es lo único que haría fiable el modo de salida automática por
  geocerca ([09](./09-marcaje-asistencia.md) RN-09.13). Cola de marcajes sin conexión.
  Almacenamiento seguro para el session token del IS. Mejor experiencia para el uso real:
  una pantalla, un botón, con guantes.
- **En contra:** una interfaz más que mantener para siempre. Dos despliegues, dos ciclos de
  QA. Es un proyecto, no una tarea.
- **Cuándo:** si el negocio necesita marcaje sin conexión o detección automática de salida.
  Sólo entonces.

### (e) Kotlin nativo

Mencionada por completitud. Aporta sobre (d) casi nada que este producto necesite y cuesta
bastante más. **Descartar** salvo que aparezca un requisito de integración con hardware
(lector biométrico, terminal de fichaje).

### Recomendación

**Empezar por (a) o (b), y reservar (d) para cuando un requisito lo exija.**

El razonamiento: hoy el producto sólo necesita **una lectura de ubicación en el instante del
marcaje**, y eso lo hace un navegador. Todo el coste extra de (c)/(d)/(e) se paga por el
segundo plano y el sin conexión, dos cosas que el legacy nunca tuvo funcionando de verdad
(punto 77) y sin las cuales la operación viene trabajando.

La pregunta que decide es la **decisión abierta 2** de §7: *¿hace falta geolocalización en
segundo plano?* Si la respuesta es no, (a)/(b) bastan y esta spec se reduce a la mitad.

### Consecuencias sobre la sesión

| Opción | Custodia de tokens del IS |
|---|---|
| (a), (b) | Cookies `httpOnly` del backend, igual que en web — **sin cambios** |
| (c) | Origen `file://`: las cookies cross-origin se complican; probablemente haya que pasar el session token por cabecera y guardarlo en almacenamiento seguro |
| (d), (e) | Sin cookies: el session token se guarda en el almacén seguro del sistema y viaja como Bearer |

Ésta es la razón de que [04](./04-autenticacion.md) §7 y
[00](./00-migracion-datos-e-identidad.md) §C.9 remitan aquí: **si se elige (c), (d) o (e), el
backend debe soportar autenticación por cabecera además de por cookie.** Conviene contemplarlo
desde el principio aunque se empiece por (a).

## 3. Runtime nativo

- **RN-20.1** — Detección de runtime nativo para activar comportamientos exclusivos:
  enrutado por hash, "recordar credenciales" ([04](./04-autenticacion.md) RN-04.5), permisos
  de notificación ([14](./14-notificaciones.md) §6) y el proveedor de geolocalización nativo
  ([08](./08-sedes-y-geocerca.md) §4).
- **RN-20.2** — La aplicación web debe seguir siendo plenamente funcional sin runtime nativo.
  Nada esencial puede depender de la APK.

## 4. Proyecto Android

*Aplica a las opciones (b), (c), (d) y (e) de §2; con (a) esta sección desaparece.*

- Identificador de aplicación: `com.elineas.asistencia`.
- Permisos: ubicación en primer plano y, si se implementa la salida automática por geocerca,
  también en segundo plano — con la justificación correspondiente.
- Iconos de lanzador y pantalla de arranque.
- Endurecimiento del build (ofuscación, sin depuración en release, sin tráfico en claro).

> ⚠️ **Deuda heredada (punto 67):** no hay integración continua. Compilar y firmar es
> manual, con una guía paso a paso. Cada versión depende de que una persona siga bien el
> procedimiento en su máquina. **Requisito nuevo: automatizar el build y la firma** en CI
> ([22-calidad-y-deuda-tecnica](./22-calidad-y-deuda-tecnica.md)).

> ⚠️ **Deuda heredada (punto 77):** el seguimiento de ubicación en segundo plano usa
> `watchPosition` en lugar de un servicio nativo. No sobrevive a que Android suspenda el
> proceso. Condiciona el modo de salida por geocerca
> ([09](./09-marcaje-asistencia.md) RN-09.13).

## 5. Distribución desde la web

*Aplica a (b), (c), (d) y (e). Con (a) no hay APK que distribuir; y con (b) sólo hay que
republicar cuando cambia el contenedor, no en cada cambio de la web.*

### `app_releases`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `version_name` | text | Visible, p. ej. `1.4.2` |
| `version_code` | int | **Ordena las versiones**: se sirve la más alta |
| `apk_path` | text | Ruta en el almacenamiento público |
| `file_size_bytes` | bigint | |
| `release_notes` | text | |
| `published_by` | uuid | |
| `created_at` | timestamptz | |

Almacenamiento: bucket **público**, límite 200 MB, sólo archivos APK.

### Reglas

- **RN-20.3** — La página pública de descarga sirve **la versión con `version_code` más
  alto**, no la más reciente por fecha.
- **RN-20.4** — `version_code` es único y estrictamente creciente. Publicar uno menor o
  repetido se rechaza.
- **RN-20.5** — Sólo se aceptan archivos `.apk`, con validación del tipo real, no de la
  extensión.
- **RN-20.6** — La página de descarga (`/descargar-app`) es **pública, sin autenticación**:
  un empleado nuevo tiene que poder instalar la app antes de tener cuenta.
- **RN-20.7** — Se muestran versión, tamaño, notas y fecha, más instrucciones para instalar
  desde fuera de la tienda (permitir orígenes desconocidos en Android).
- **RN-20.8** — Publicar una versión se audita ([18](./18-auditoria.md)).
- **RN-20.9** — **Propuesta:** aviso de actualización dentro de la app cuando el
  `version_code` publicado supera al instalado. El legacy no lo tiene, así que la flota queda
  desactualizada en silencio.

### API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/app-releases/latest` | **público** |
| `GET` | `/app-releases` | superadmin |
| `POST` | `/app-releases` | superadmin — sube APK + metadatos |

## 6. Criterios de aceptación

- [ ] La página de descarga funciona sin sesión y sirve la versión de mayor `version_code`.
- [ ] Publicar un `version_code` menor o repetido se rechaza.
- [ ] Subir un archivo que no es APK se rechaza aunque tenga extensión `.apk`.
- [ ] La app instalada obtiene ubicación y permite marcar dentro de la geocerca.
- [ ] La sesión persiste al cerrar y reabrir la app.
- [ ] La navegación funciona en el runtime nativo (rutas resueltas correctamente).
- [ ] La aplicación web sigue funcionando completa en navegador de escritorio y móvil.

## 7. Decisiones abiertas

1. **¿Se necesita geolocalización en segundo plano** o basta con la lectura puntual al marcar?
   **Es la pregunta que decide §2**: si basta la lectura puntual, (a) o (b); si no, (d).
2. **¿Se necesita marcar sin conexión?** Segunda pregunta que empuja hacia (d). El legacy no
   lo soporta; conviene comprobar cómo es la señal en cada sede antes de responder.
3. ¿Cómo se construye el cliente móvil? (§2) — se responde sola con 1 y 2.
4. ¿Distribución fuera de tienda de forma permanente, o publicar en Google Play?
5. ¿Se implementa el aviso de actualización? (RN-20.9 — irrelevante si se elige (a) o (b).)

> Ninguna de estas bloquea el desarrollo del resto del sistema. La única precaución a tomar
> desde ya es la de §2, *Consecuencias sobre la sesión*: dejar el backend preparado para
> autenticar por cabecera además de por cookie.
