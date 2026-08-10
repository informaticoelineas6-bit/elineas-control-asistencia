# 21 · Migración desde el sistema legacy

> **Origen:** transversal a todo `old-docs.md`; hallazgos H-2 y H-3; puntos 22 (`geofence_config`), 70 (deriva de esquema), 80 (limpieza).
> **Estado:** ❌ no iniciada. Esta spec no describe una funcionalidad del producto, sino **el trabajo de traer los datos y las decisiones del sistema anterior**.
> **Léase junto a [00-migracion-datos-e-identidad](./00-migracion-datos-e-identidad.md)**, que
> fija las decisiones (contenedor de PostgreSQL, Identity Server) y la UX del corte. Aquí está
> el detalle tabla por tabla.

---

## 1. Punto de partida

| | Legacy | Monorepo nuevo |
|---|---|---|
| Frontend | React 18 + Vite (SPA) | TanStack Start (React + SSR) |
| Backend | Supabase: Postgres + Auth + Storage + Edge Functions (Deno) | Hono + Drizzle + **PostgreSQL en contenedor** ([00](./00-migracion-datos-e-identidad.md) §A.1) |
| Autenticación | Supabase Auth | **Identity Server de Elineas** ([00](./00-migracion-datos-e-identidad.md) Parte C) |
| Autorización | RLS en Postgres (autoridad real) + guard de cliente | **Sólo capa de aplicación** salvo que se decida reimplementar RLS |
| Lógica de negocio | Repartida entre hooks de React, funciones SQL, triggers y edge functions | Servicios de dominio en el backend |
| Validación | Ad hoc | Zod compartido (`packages/validations`) |
| Contratos | Ninguno (cliente hablando directo a la base) | `packages/contracts` |
| Móvil | Capacitor sobre la SPA | Por decidir ([20](./20-app-movil-y-distribucion.md)) |
| Almacenamiento | Buckets de Supabase (`monthly-reports`, `app-releases`) | Por decidir |

## 2. Los cuatro cambios de fondo

1. **Desaparece RLS como red de seguridad.** En el legacy, aunque el cliente hablara directo
   con la base, Postgres imponía el ámbito. En el monorepo la autorización vive **sólo** en
   los handlers de Hono. Cada endpoint es un agujero potencial.
   → [03-roles-y-autorizacion](./03-roles-y-autorizacion.md) §6, decisión abierta 2.
2. **La lógica sale de la base de datos.** Triggers y funciones SQL (`validate_attendance_mark`,
   `handle_absence_review_payroll_impact`, `handle_new_user`, `enforce_gm_department`) pasan a
   ser servicios de dominio en TypeScript. Ventaja: testeables y visibles. Riesgo: lo que el
   trigger garantizaba siempre, ahora hay que invocarlo siempre.
3. **Un solo lugar por regla.** El legacy tenía la misma regla escrita tres veces (estado
   diario en un hook, en una función SQL y en una función Deno de exportación). El monorepo
   debe tener una implementación por regla, compartida.
4. **La base deja de ser compartida.** Ver §3.

## 3. Hallazgo H-2: la base de datos legacy está compartida

Los tipos generados del legacy declaran ~15 tablas que **no pertenecen a este sistema** y
conviven en el mismo esquema `public`: `activos`, `guardias`, `requests`, `request_comments`,
`request_feedback`, `request_histories`, `request_trash`, `worklogs`, `knowledge_base`,
`automation_rules`, `automation_logs`, `chat_logs`, `app_users`, `audit_logs`, `incidents`.

Consecuencias para la migración:

- **RN-21.1** — La extracción de datos debe limitar la lista de tablas explícitamente. No se
  copia el esquema entero.
- **RN-21.2** — Cuidado con los **homónimos**: `audit_logs` (ajeno) vs `audit_log` (propio);
  `incidents` (ajeno) vs `attendance_incidents` (propio). Confundirlos importaría datos de
  otro sistema.
- **RN-21.3** — Confirmar si el otro sistema comparte además la tabla de usuarios de
  autenticación. Si es así, la migración de identidades tiene que discriminar por pertenencia
  a este producto.

## 4. Datos a migrar

| Dominio | Tablas | Notas |
|---|---|---|
| Organización | `departments` | Directo |
| Identidad | `profiles`, `user_department_responsibilities` | Ver §5. **`user_roles` y los usuarios de auth NO se migran**: pasan al Identity Server |
| Reglas | `department_schedules`, `work_calendar`, `user_rest_schedule`, `rest_groups`, `rest_group_members` | Directo; verificar convención de `days_of_week` ([10](./10-descansos.md)) |
| Ubicación | `work_locations` | **`geofence_config` no se migra**: si aún hay datos ahí, se consolidan en `work_locations` en el propio script ([08](./08-sedes-y-geocerca.md)) |
| Asistencia | `attendance_marks` | El volumen mayor. Migrar por lotes |
| Excepciones | `attendance_incidents`, `attendance_absence_reviews`, `vacation_requests` | Conservar decisiones y revisores |
| Reportería | `attendance_daily_facts`, `attendance_rule_versions`, `report_runs` | **Los hechos diarios se recalculan, no se copian** ([16](./16-reporteria-mensual.md) RN-16.10). `report_runs` sólo si se quiere conservar el historial |
| Plataforma | `app_config`, `audit_log`, `notifications`, `payroll_adjustments`, `app_releases` | `notifications` probablemente no valga la pena migrar |
| Almacenamiento | buckets `monthly-reports`, `app-releases` | Decidir si se migran los artefactos o se regeneran |

- **RN-21.4** — La migración de `payroll_adjustments` es **crítica y no negociable**: es
  historial económico. Debe migrarse íntegro, incluidos los revertidos, y verificarse contra
  los totales del sistema anterior.
- **RN-21.5** — Los identificadores se conservan cuando sea posible, para que las referencias
  cruzadas (`source_id`, `reviewed_by`) sigan resolviendo.
- **RN-21.6** — Verificación obligatoria por dominio: conteo de filas origen vs destino, y
  para asistencia además una comparación del **reporte mensual de un mes cerrado** generado
  por ambos sistemas. Si no coinciden celda a celda, la migración no está terminada.

## 5. Migración de identidades

El punto más delicado, y ya decidido: **las identidades pasan al Identity Server de Elineas**
([00](./00-migracion-datos-e-identidad.md) Parte C). Las contraseñas de Supabase **no se
migran**: no son reutilizables allí.

El trabajo concreto es de **emparejamiento**:

1. Las cuentas se crean (o ya existen) en el IS, con su rol en `control-asistencia` asignado
   — sin rol no pueden entrar ([00](./00-migracion-datos-e-identidad.md) RN-00.33).
   ✅ **El IS admite alta masiva**, así que se cargan todas de una vez desde el listado que
   salga del legacy; no hay que darlas de alta una a una.
2. Cada `profiles` heredado se vincula a su identidad del IS **por correo**, una sola vez,
   guardando el `sub` en `identity_user_id`.
3. El `user_id` de Supabase se conserva en una **tabla de correspondencia** durante la
   migración, porque todo el historial cuelga de él.

- **RN-21.7 — Ningún perfil puede quedar sin emparejar.** Un perfil sin `identity_user_id` es
  un empleado que no podrá entrar el lunes. `verify` debe fallar si queda alguno
  ([00](./00-migracion-datos-e-identidad.md) RN-00.47).
- **RN-21.8 — Correos duplicados o ausentes en el legacy** son el fallo probable de este paso:
  detectarlos y resolverlos **antes** del corte, no durante.
- **RN-21.9 — Los roles se recrean en el IS a partir de `user_roles`**, que sirve como lista de
  referencia y luego se descarta. Verificar uno a uno: quién era `department_head` y quién
  `global_manager` no puede quedar a criterio de nadie.
- La UX del cambio de contraseña para el empleado está resuelta en
  [00](./00-migracion-datos-e-identidad.md) §B.1.

## 6. Estrategia de corte

**Decisión abierta.** Tres caminos:

- **Corte limpio** — se congela el legacy un fin de semana, se migra y se arranca el nuevo.
  Simple, exige que el sistema nuevo esté completo.
- **Funcionalidad por funcionalidad** — ambos sistemas conviven contra la misma base.
  **Descartado**: la base cambia de sitio y la autenticación cambia de proveedor
  ([00](./00-migracion-datos-e-identidad.md)); no hay base común sobre la que convivir.
- **Sólo hacia adelante** — el sistema nuevo arranca con los datos maestros (personas,
  departamentos, reglas) y el histórico de asistencia queda consultable en el legacy en modo
  lectura. Rápido, pero deja los reportes partidos en dos.

Recomendación inicial: **corte limpio**, con el legacy en sólo lectura durante un periodo de
gracia.

## 7. Deuda que **no** se migra

Lista explícita de cosas del legacy que deben quedarse atrás:

- `geofence_config` (tabla legacy con fallback y automigración).
- La duplicación de la matriz de reporte entre XLSX y Sheets ([16](./16-reporteria-mensual.md) §7.2).
- La regla de recordatorio de descansos dentro del contexto de notificaciones (H-4).
- Los argumentos invertidos en la comprobación de jefe de departamento (H-1).
- El salario sin barrera de columna (H-3).
- La migración vacía sin explicar y demás residuos (punto 80).
- La consola SQL con lista negra, salvo decisión explícita en contra
  ([19](./19-panel-superadmin.md) §2.3).
- **better-auth**, que quedó en el andamiaje del monorepo y se retira
  ([00](./00-migracion-datos-e-identidad.md) RN-00.26).

## 8. Control de cambios de esquema

> ⚠️ **Punto 70 del legacy:** ya ocurrió una **deriva real** entre la base de producción y el
> historial de migraciones — se ejecutó SQL a mano fuera del control de versiones.
>
> Requisito para el monorepo: **todo cambio de esquema pasa por una migración de Drizzle en el
> repositorio.** Sin excepciones, ni siquiera para "un índice rápido en producción". Debe
> haber una verificación en CI que compare el esquema desplegado con el del repositorio.

## 9. Criterios de aceptación de la migración

- [ ] Conteo de filas coincide por cada tabla migrada.
- [ ] El reporte mensual de un mes cerrado es idéntico celda a celda en ambos sistemas.
- [ ] Los totales de ajustes de nómina coinciden, incluidos los revertidos.
- [ ] Ningún dato de las tablas ajenas (§3) entró en el sistema nuevo.
- [ ] Todos los usuarios pueden iniciar sesión tras el corte, con rol asignado en el IS.
- [ ] Ningún perfil quedó sin `identity_user_id` (RN-21.7).
- [ ] Los roles recreados en el IS coinciden uno a uno con los del legacy (RN-21.9).
- [ ] Las referencias cruzadas (revisores, orígenes de ajustes) resuelven correctamente.
- [ ] Existe un procedimiento de vuelta atrás documentado y probado.

## 10. Decisiones abiertas

1. Estrategia de corte. (§6)
2. ¿Se reimplementa RLS en Postgres? (§2.1 y [00](./00-migracion-datos-e-identidad.md) RN-00.1)
3. ¿Se migran los artefactos de reportes históricos o se regeneran?
4. ¿Qué pasa con el otro sistema que comparte la base? ¿Sigue necesitando esas tablas?
5. ¿Cómo se entregan las contraseñas temporales de la carga masiva a cada empleado?
   ([00](./00-migracion-datos-e-identidad.md) §B.1)
