# 19 · Panel de superadmin

> **Origen:** `old-docs.md` §3.8 (`execute_superadmin_sql`), §3.9, puntos 9, 63.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ✅ implementado, **sin la consola SQL** —que es
> lo que la §6.1 decidió no reimplementar— y sin la §2.7, que se fue con la spec móvil.
>
> Vocabulario en `packages/validations/src/admin.ts` (incluida la traducción de las
> fechas de Excel); contrato en `packages/contracts/src/admin.ts`; dominio en
> `apps/backend/src/services/admin.ts`; rutas en `apps/backend/src/routes/admin.ts`
> detrás de un solo `requireRole("superadmin")`. El **bloqueo de escrituras** del
> mantenimiento vive en `apps/backend/src/middleware/auth.ts`, que es el único sitio
> donde se conoce el rol. Interfaz: `/admin` (`apps/frontend/src/modules/admin/`) y la
> banda de aviso en el layout autenticado. Pruebas: 17 de integración en
> `apps/backend/src/routes/admin.test.ts` y 11 puras en `services/admin-rules.test.ts`.
> **Depende de:** [02-usuarios-y-perfiles](./02-usuarios-y-perfiles.md), [18-auditoria](./18-auditoria.md), [06-configuracion-global](./06-configuracion-global.md).

---

## 1. Objetivo

Herramientas de operación y soporte reservadas al `superadmin`: ver el estado global del
sistema, consultar la bitácora completa, ejecutar consultas puntuales, importar histórico,
poner el sistema en modo de mantenimiento y gestionar cuentas sin restricciones.

> Todo lo de esta spec es **potente y peligroso**. Cada funcionalidad aquí debe estar
> auditada ([18](./18-auditoria.md) §3) y ser difícil de invocar por accidente.

## 2. Contenido del panel

### 2.1 Estadísticas globales
Usuarios por rol y estado, marcajes del día/mes, departamentos, incidencias y ausencias
pendientes, corridas de reporte recientes, errores.

> ⚠️ **Todo menos lo primero: "usuarios por rol" no se puede responder.** Y no es una
> limitación de esta pantalla: **este sistema no sabe qué rol tiene nadie hasta que esa
> persona se autentica.** Los roles viven en el Identity Server y sólo se conocen por
> *session token* ([00](./00-migracion-datos-e-identidad.md) RN-00.43); en nuestra base sólo
> queda el ámbito **adicional** de un jefe (spec 03 §3). Un conteo por rol sería inventado.
>
> Es la **quinta aparición** de la misma decisión abierta —la 3 de la [11](./11-vacaciones.md)
> §9— y la primera en la que no hay salida parcial: en las otras se podía notificar a los
> responsables adicionales, aquí simplemente no hay número. Se cambia por **usuarios por
> estado**, que sí es nuestro, y la pantalla dice por qué falta el otro.
>
> Los contadores de pendientes **no se reimplementan**: son las mismas funciones que alimentan
> el badge del aside de un jefe, pedidas con ámbito `"all"`. En el legacy el panel y la bandeja
> contaban por su cuenta y acabaron discrepando.

### 2.2 Bitácora completa
Ver [18-auditoria](./18-auditoria.md) §7.

> ⚠️ **Ya no es cierto que el panel sea su único punto de acceso, y por una buena razón.** La
> [18](./18-auditoria.md) se construyó antes que este panel —la escritura llevaba años funcionando
> y lo que faltaba era leerla— así que la bitácora vive en `/logs`, con el mismo rol mínimo que
> tendría aquí. **Este panel la enlaza**, no la duplica: dos pantallas de lo mismo es cómo
> empiezan a divergir.

### 2.3 Consola SQL restringida

El legacy expone `execute_superadmin_sql`, que **bloquea `BEGIN` / `COMMIT` / `ROLLBACK`**.

> ⚠️ **Esa es una lista negra, y las listas negras no protegen.** Bloquear el control de
> transacciones no impide un `DELETE FROM profiles`, ni un `UPDATE` masivo, ni la lectura de
> salarios ajenos. Es una consola con privilegios totales sobre la base de producción,
> accesible desde el navegador.
>
> **Decisión requerida antes de reimplementar** (§6, decisión 1). Alternativas, de menos a
> más restrictiva:
> - **(a)** No reimplementarla. Para consultas puntuales se usa acceso directo a la base con
>   credenciales fuera de la aplicación. *Recomendado.*
> - **(b)** Sólo lectura: conexión con rol de base de datos de sólo `SELECT`, tiempo límite
>   por consulta y límite de filas.
> - **(c)** Consultas predefinidas parametrizadas, sin SQL libre.

Si se implementa alguna variante: registrar **toda** consulta ejecutada en la bitácora con su
texto íntegro, imponer tiempo límite y limitar el número de filas devueltas.

> **Decisión 1 cerrada: (a), no se reimplementa.** Es la que esta spec recomendaba, y el
> razonamiento completo está en `packages/contracts/src/admin.ts` para que no haya que rehacerlo
> dentro de un año:
>
> - La lista negra del legacy **no se puede arreglar**. No impide un `DELETE FROM profiles`, y
>   esquivarla es cuestión de un comentario, un `DO`, una función o un salto de línea. Cerrar un
>   agujero descubre el siguiente.
> - La alternativa **(b) no es gratis**: exige un rol de base de datos aparte con su credencial
>   propia, y mientras no exista, el endpoint correría como el dueño del esquema. Un endpoint que
>   *parece* restringido y no lo está es peor que ninguno.
> - Y la necesidad legítima **ya está cubierta**: `bun run db:studio` y el `psql` del contenedor,
>   con credenciales que viven fuera de la aplicación y no se alcanzan desde un navegador. Eso
>   **es** la alternativa (a).
>
> Con esto, RN-19.9 pierde su caso más peligroso ("SQL de escritura") y el séptimo criterio de la
> §5 queda sin objeto. **Hay una prueba que comprueba que el endpoint no existe**: volver a
> añadirlo tendrá que ser un acto deliberado, no un descuido.

### 2.4 Importación de histórico de asistencia

Carga masiva de marcajes desde Excel, para incorporar datos previos al sistema.

- **RN-19.1** — Es la **única** escritura de `attendance_marks` fuera del flujo de marcaje
  ([09](./09-marcaje-asistencia.md) §4). Debe marcarse como tal (`source = import`).
- **RN-19.2** — Validación previa con informe: filas válidas, filas con error y motivo,
  **antes** de escribir nada. Nunca importación parcial silenciosa.
- **RN-19.3** — Idempotencia: reimportar el mismo archivo no duplica marcajes. Clave natural
  (`user_id`, `mark_type`, `timestamp`).
- **RN-19.4** — Tras importar, se marcan para recálculo los hechos diarios del rango afectado
  ([16](./16-reporteria-mensual.md) RN-16.11).
- **RN-19.5** — Los marcajes importados **no** llevan geolocalización válida: deben quedar
  identificables para que nadie los confunda con evidencia de ubicación.
- **RN-19.6** — La importación se audita con el nombre del archivo, el rango de fechas y el
  número de filas.

> ✅ **Construida**, y tres de las seis reglas se cumplieron **sin código propio**, porque las
> piezas ya estaban puestas:
>
> - **RN-19.1** — `source: "import"`. La columna existe desde la [09](./09-marcaje-asistencia.md)
>   con esta frase dentro: *"cuando exista la importación histórica, nadie podrá distinguirlos
>   hacia atrás si no está el campo"*.
> - **RN-19.3** — la idempotencia la sostiene el **índice único por minuto** que la 09 creó para
>   el antirrebote del doble toque. Reimportar no duplica aunque se haga dos veces a la vez.
> - **RN-19.4** — el recálculo de hechos diarios es el de la [16](./16-reporteria-mensual.md)
>   RN-16.11, ya construido.
>
> Y dos decisiones que la §2.4 dejaba al implementador:
>
> - **RN-19.5, en su forma honesta: los marcajes importados van sin coordenadas.** `latitude`,
>   `longitude` y `accuracy` pasan a admitir nulo para esto. No es un dato que falte: de aquel
>   hecho **no se midió** la ubicación. Un `0, 0` señalaría al golfo de Guinea y una `accuracy`
>   de 0 diría "precisión perfecta", que es exactamente lo contrario de lo que la regla quiere
>   que se entienda.
> - **La hora del archivo es hora de pared**, y se interpreta con la zona configurada (RN-06.6).
>   Meterla como UTC correría todo el histórico cuatro o cinco horas: suficiente para que una
>   entrada de las 08:00 apareciera como tardanza o cayera en otro día laboral.
>
> ⚠️ **Y un hallazgo que decide si esto funciona con archivos reales:** Excel **no guarda las
> fechas como texto**, guarda números de serie —`45730` es el 14 de marzo de 2025— y las horas
> como fracción de día. Sin esa conversión, un histórico exportado de Excel daría **cero filas
> válidas** y el informe diría "fecha no válida" sobre algo que en la pantalla se ve
> perfectamente: el peor error posible, porque parece un problema del archivo. Las dos
> conversiones son funciones puras con sus pruebas, incluido el epoch raro de Excel (30 de
> diciembre de 1899, herencia de Lotus 1-2-3).

### 2.5 Modo de salida / mantenimiento

El legacy lo llama "modo de salida". Suspende la operación del sistema.

> **Confirmar qué hace exactamente**: ¿bloquea todos los marcajes? ¿cierra sesiones? ¿muestra
> un aviso? En el documento heredado no está definido y es una función con efecto global.
> **Decisión abierta.**

Requisitos mínimos: motivo obligatorio, aviso visible a todos los usuarios, quién y cuándo lo
activó, y desactivación igual de simple.

> **Decisión 2 cerrada. Qué hace exactamente:**
>
> - **Bloquea toda escritura** de cualquier rol por debajo de `superadmin`, con un **503** —"vuelve
>   luego", no "no tienes permiso"— que lleva el motivo dentro. Marcar asistencia es una escritura,
>   así que queda bloqueado. Un `global_manager` tampoco escribe: el mantenimiento es del sistema,
>   no un permiso.
> - **No cierra sesiones.** Cerrarlas obligaría a toda la plantilla a volver a autenticarse contra
>   el Identity Server —que es otro sistema y no está en mantenimiento— sin impedir nada que el
>   bloqueo de escrituras no impida ya.
> - **Las lecturas siguen, y el login también.** Quien abra la aplicación tiene que poder ver el
>   aviso y sus propios datos: un sistema que no deja entrar no puede explicar por qué está
>   parado.
> - **El `superadmin` está exento**, porque es quien lo activó y quien tiene que poder apagarlo.
>
> Vive en dos claves de configuración ([06](./06-configuracion-global.md) §3.7) y **el bloqueo se
> aplica en `requireAuth`**, que es el único sitio donde ya se conoce el rol: un middleware
> anterior no tendría con qué eximir al superadmin. El aviso llega a todo el mundo por
> `GET /config/public`, que es exactamente para lo que existe ese subconjunto — sin eso haría
> falta un endpoint nuevo para repartir un aviso que ya viaja.
>
> "Quién y cuándo" **sale de la bitácora**, no de una columna: ya se escribe donde va ese tipo de
> dato ([18](./18-auditoria.md)), y una copia en `app_config` serían dos registros del mismo hecho
> que se pueden desincronizar — con el inconveniente de que el editable sería el que se lee.

### 2.6 Gestión total de cuentas
Borrado real ([02](./02-usuarios-y-perfiles.md) RN-02.8), otorgamiento del rol `superadmin`
([03](./03-roles-y-autorizacion.md) RN-03.7/8), reseteo de contraseñas.

> **De las tres, sólo una es nuestra, y ya existía.** El borrado real está desde la
> [02](./02-usuarios-y-perfiles.md) en `DELETE /users/:id`, con `superadmin` y con su exigencia de
> desactivar antes. Las otras dos **no pueden estar aquí**: otorgar un rol y resetear una
> contraseña son operaciones del **Identity Server** —esta aplicación no crea cuentas ni toca
> credenciales (RN-00.28)— y su sitio es la consola del IS, que la interfaz enlaza desde el alta
> de usuarios.
>
> Es el corte de la [00](./00-migracion-datos-e-identidad.md) visto desde el otro lado: lo que se
> gana en no custodiar contraseñas se paga en que este panel no puede resolverlo todo.

### 2.7 ~~Publicación de la app~~ — fuera del alcance
La spec de la app móvil y su distribución **se retiró**: la aplicación se sirve por web, también
en el teléfono, así que no hay APK que publicar ni versión mínima que forzar. Si algún día se
empaqueta un cliente nativo, esta sección vuelve con él.

## 3. Reglas transversales

- **RN-19.7** — Todos los endpoints exigen rol `superadmin` verificado en servidor. Ninguno
  acepta el rol declarado por el cliente.
- **RN-19.8** — Toda acción del panel se audita, sin excepción.
- **RN-19.9** — Las acciones destructivas (borrado de cuenta, importación, mantenimiento,
  SQL de escritura) exigen confirmación explícita escribiendo el nombre del recurso, no un
  simple "¿Está seguro?".
- **RN-19.10** — El panel no debe ser la vía habitual para nada operativo. Si una tarea se
  hace a menudo desde aquí, falta una funcionalidad en el producto.

## 4. API propuesta

| Método | Path | Notas |
|---|---|---|
| `GET` | `/admin/stats` | |
| `GET` | `/audit…` | ver [18](./18-auditoria.md) |
| `POST` | `/admin/sql` | **sólo si se decide implementar** (§2.3) |
| `POST` | `/admin/import/attendance/validate` | devuelve informe, no escribe |
| `POST` | `/admin/import/attendance/commit` | escribe tras validar |
| `GET` / `POST` | `/admin/maintenance` | estado y activación |
| `DELETE` | `/users/:id` | borrado real |

> ✅ **Construidos todos menos `/admin/sql`**, que es la decisión 1. El de mantenimiento es un
> `PUT` y no un `POST` —activar y desactivar es fijar un estado, no crear algo— y los dos de
> importación reciben el archivo como `multipart/form-data`.
>
> **El archivo se sube dos veces, una por paso**, y es deliberado: cuesta un segundo y garantiza
> que lo que se escribe es exactamente lo que se validó. Guardarlo en el servidor entre los dos
> pasos significaría un almacén temporal de datos de asistencia que habría que limpiar, vigilar y
> explicar.

## 5. Criterios de aceptación

- [x] Ningún endpoint de `/admin` responde a un rol distinto de `superadmin`. *(Comprobado
      también contra un `global_manager`, que en todo lo demás lo puede casi todo: si algo se
      cuela, se cuela por ahí.)*
- [x] Toda acción del panel deja entrada en la bitácora. *(Mantenimiento con su verbo propio y su
      motivo; importación con el archivo, el rango y las filas.)*
- [x] La validación de importación no escribe ni una fila. *(Se comprueba contando marcajes antes
      y después, no leyendo la respuesta.)*
- [x] Reimportar el mismo archivo no duplica marcajes. *(La segunda vez inserta 0 y el informe lo
      dice antes: las cuatro ya estaban.)*
- [x] Tras importar, el reporte del periodo afectado refleja los datos nuevos. *(Se recalculan
      los hechos diarios del rango, que es de donde lee el reporte — RN-19.4 y
      [16](./16-reporteria-mensual.md) RN-16.11. La prueba comprueba que se recalcularon.)*
- [x] Los marcajes importados se distinguen de los reales. *(`source = import` **y sin
      coordenadas**: dos señales, y la segunda es la que impide confundirlos con evidencia de
      ubicación.)*
- [x] ~~Si existe consola SQL: toda consulta queda registrada íntegra y respeta tiempo límite.~~
      **Sin objeto: no existe** (decisión 1). Lo que hay es una prueba de que el endpoint no
      responde.
- [x] El modo mantenimiento se refleja en la UI de todos los usuarios conectados. *(Por
      `GET /config/public`, que alcanza también a un empleado. La prueba comprueba que las dos
      claves llegan ahí.)*

## 6. Decisiones abiertas

1. ~~**¿Se reimplementa la consola SQL?**~~ **Cerrada: no** — alternativa (a), la que esta spec
   recomendaba. Ver §2.3. Era "la decisión de seguridad más importante del proyecto" y la
   respuesta más segura resultó ser también la más barata: la herramienta ya existe fuera de la
   aplicación.
2. ~~¿Qué hace exactamente el modo de salida/mantenimiento?~~ **Cerrada**: bloquea escrituras,
   no cierra sesiones, deja leer y entrar, y exime al `superadmin`. Ver §2.5.
3. ~~¿La importación de histórico es permanente o una herramienta de migración única?~~
   **Cerrada: se queda en el panel.** El corte del legacy no es su único caso — un lector de
   huella que se cae una semana también acaba en una hoja de cálculo que hay que cargar—, y
   RN-19.10 tolera exactamente esto: algo que se hace casi nunca. La
   [21](./21-migracion-desde-legacy.md) la usa, no la contiene.
4. **⚠️ Sigue abierta — ¿cuántos superadmin debe haber? ¿Se exige segundo factor para ese rol?**
   Es la única de esta spec, y **no la decide este código**: el rol se otorga en el Identity
   Server y el segundo factor es una función suya (spec 00 §B.1). Lo que sí quedó hecho por si la
   respuesta llega: toda acción del panel está auditada con actor, IP e id de correlación, así que
   "quién hizo qué con ese rol" ya tiene respuesta.
