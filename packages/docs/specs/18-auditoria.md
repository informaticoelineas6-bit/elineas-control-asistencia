# 18 · Bitácora de auditoría

> **Origen:** `old-docs.md` §3.6, punto 16; punto 76 (hueco de nómina).
> **Estado en el sistema legacy:** ✅ implementado, ⚠️ con cobertura parcial.
> **Estado en el monorepo nuevo:** ❌ no existe.
> **Depende de:** [03-roles-y-autorizacion](./03-roles-y-autorizacion.md).

---

## 1. Objetivo

Dejar rastro de **quién hizo qué, cuándo y sobre qué**, para las acciones que afectan a
personas, dinero o configuración. Es lo que permite responder "¿por qué a este empleado le
descontaron en marzo?" seis meses después.

## 2. Modelo de datos

### `audit_log`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `actor_id` | uuid, nullable | Quién actuó (`null` si fue el sistema) |
| `action` | text | Verbo canónico, ver §3 |
| `table_name` | text | Recurso afectado |
| `record_id` | uuid/text, nullable | Identificador del registro |
| `old_data` | jsonb, nullable | Estado anterior |
| `new_data` | jsonb, nullable | Estado nuevo |
| `source_ip` | inet/text, nullable | |
| `metadata` | jsonb, nullable | Contexto adicional (motivo, user-agent, id de correlación) |
| `created_at` | timestamptz | |

**Índices:** (`created_at desc`), (`table_name`, `record_id`), (`actor_id`, `created_at desc`).

## 3. Qué se audita

Mínimo obligatorio:

| Dominio | Acciones |
|---|---|
| Usuarios | alta, cambio de rol, cambio de departamento, desactivación, reactivación, reseteo de contraseña, borrado |
| Nómina ⚠️ | creación y reversión de ajustes, cambio de `monthly_salary` — **hueco del legacy, punto 76** |
| Justificación de ausencias | toda decisión, con el valor anterior |
| Configuración global | todo cambio de clave, con valor anterior y nuevo |
| Departamentos | creación, renombrado, pausa/reanudación, eliminación |
| Horarios y calendario | cambios de ventana y de días laborables |
| Sedes | alta, cambio de coordenadas o radio, desactivación |
| Superadmin | ejecución de consultas SQL, importación de histórico, publicación de versión de la app, activación del modo mantenimiento |
| Marcajes | sólo borrados/correcciones administrativas (los marcajes normales **no** se auditan: ya son el registro) |

- **RN-18.1 — Lo que no se audita.** Lecturas y navegación no se registran. El volumen mataría
  la utilidad de la bitácora.
- **RN-18.2 — Datos sensibles.** `old_data`/`new_data` no deben incluir contraseñas ni tokens.
  El salario **sí** se registra (es el punto de la auditoría) pero la bitácora completa sólo la
  ve `superadmin` (RN-18.5).

## 4. Reglas de negocio

- **RN-18.3 — Escritura desde el servidor.** Ningún cliente escribe en la bitácora. Se genera
  en la capa de dominio del backend.
- **RN-18.4 — Misma transacción.** La entrada se escribe en la transacción de la acción
  auditada: si la acción se revierte, su rastro también. Si la escritura de bitácora falla,
  **la acción falla** — para las acciones de §3. *(Decidir si esto aplica a todas o sólo a
  nómina y usuarios.)*
- **RN-18.5 — Lectura.** La bitácora completa es exclusiva de `superadmin`
  ([19-panel-superadmin](./19-panel-superadmin.md)). **Decisión abierta:** ¿un
  `global_manager` debería ver la de su ámbito (usuarios, nómina)?
- **RN-18.6 — Inmutable.** No hay actualización ni borrado de entradas por la aplicación.
- **RN-18.7 — Retención.** **Decisión abierta:** ¿cuánto se conserva? Una bitácora de nómina
  probablemente deba conservarse años. Propuesta: sin purga automática; archivado manual si
  crece.
- **RN-18.8 — Correlación.** Una acción que dispara efectos en cascada (justificar una
  ausencia → ajuste de nómina → notificación) debe compartir un identificador de correlación
  en `metadata`, para poder leer la cadena completa.

## 5. Implementación propuesta

En el legacy la bitácora se escribía **desde los puntos de uso** (gestión de usuarios,
principalmente), lo que explica su cobertura parcial: lo que nadie recordó instrumentar, no
se auditó.

**Propuesta para el monorepo:** una función única `audit(ctx, { action, resource, before,
after, metadata })` invocada dentro de los servicios de dominio, más un test por cada acción
de §3 que verifique que la entrada se escribe. Instrumentar por convención, no por memoria.

## 6. API propuesta

| Método | Path | Rol |
|---|---|---|
| `GET` | `/audit?actor=&table=&recordId=&from=&to=&cursor=` | superadmin |
| `GET` | `/audit/resource/:table/:id` | superadmin — historial de un registro concreto |

## 7. UI

Dentro del panel de superadmin ([19](./19-panel-superadmin.md)):

- Tabla paginada, orden descendente por fecha.
- Filtros por actor, acción, recurso y rango de fechas.
- Vista de detalle con **diferencia visual** entre `old_data` y `new_data` — leer dos bloques
  de JSON crudo no sirve.
- Acceso desde cada recurso a "ver su historial".

## 8. Criterios de aceptación

- [ ] Cada acción listada en §3 tiene un test que verifica que se registra.
- [ ] Un ajuste de nómina y un cambio de sueldo aparecen en la bitácora (hueco cerrado).
- [ ] Las entradas registran el estado anterior, no sólo el nuevo.
- [ ] Ningún endpoint permite modificar ni borrar entradas.
- [ ] Un `global_manager` recibe 403 al consultar la bitácora completa.
- [ ] Una acción en cascada comparte identificador de correlación entre sus entradas.
- [ ] Ninguna entrada contiene credenciales.

## 9. Decisiones abiertas

1. ¿`global_manager` puede leer parte de la bitácora? (RN-18.5)
2. ¿El fallo de escritura de bitácora aborta la acción siempre o sólo en dominios críticos?
   (RN-18.4)
3. Política de retención. (RN-18.7)
4. ¿Se registra la IP de origen? (Implica tratamiento de dato personal.)
