# 19 · Panel de superadmin

> **Origen:** `old-docs.md` §3.8 (`execute_superadmin_sql`), §3.9, puntos 9, 63.
> **Estado en el sistema legacy:** ✅ implementado.
> **Estado en el monorepo nuevo:** ❌ no existe.
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

### 2.2 Bitácora completa
Ver [18-auditoria](./18-auditoria.md) §7. El panel es su único punto de acceso.

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

### 2.5 Modo de salida / mantenimiento

El legacy lo llama "modo de salida". Suspende la operación del sistema.

> **Confirmar qué hace exactamente**: ¿bloquea todos los marcajes? ¿cierra sesiones? ¿muestra
> un aviso? En el documento heredado no está definido y es una función con efecto global.
> **Decisión abierta.**

Requisitos mínimos: motivo obligatorio, aviso visible a todos los usuarios, quién y cuándo lo
activó, y desactivación igual de simple.

### 2.6 Gestión total de cuentas
Borrado real ([02](./02-usuarios-y-perfiles.md) RN-02.8), otorgamiento del rol `superadmin`
([03](./03-roles-y-autorizacion.md) RN-03.7/8), reseteo de contraseñas.

### 2.7 Publicación de la app
Ver [20-app-movil-y-distribucion](./20-app-movil-y-distribucion.md).

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

## 5. Criterios de aceptación

- [ ] Ningún endpoint de `/admin` responde a un rol distinto de `superadmin`.
- [ ] Toda acción del panel deja entrada en la bitácora.
- [ ] La validación de importación no escribe ni una fila.
- [ ] Reimportar el mismo archivo no duplica marcajes.
- [ ] Tras importar, el reporte del periodo afectado refleja los datos nuevos.
- [ ] Los marcajes importados se distinguen de los reales.
- [ ] Si existe consola SQL: toda consulta queda registrada íntegra y respeta tiempo límite.
- [ ] El modo mantenimiento se refleja en la UI de todos los usuarios conectados.

## 6. Decisiones abiertas

1. **¿Se reimplementa la consola SQL?** (§2.3) — la decisión de seguridad más importante del
   proyecto.
2. ¿Qué hace exactamente el modo de salida/mantenimiento? (§2.5)
3. ¿La importación de histórico es una funcionalidad permanente o una herramienta de migración
   única? Si es lo segundo, va en
   [21-migracion-desde-legacy](./21-migracion-desde-legacy.md) y no en el producto.
4. ¿Cuántos superadmin debe haber? ¿Se exige segundo factor para ese rol?
