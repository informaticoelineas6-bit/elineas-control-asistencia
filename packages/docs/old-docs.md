# Mapa funcional — entidades, roles y orden lógico de implementación

Documento de comprensión del sistema **Control de Asistencia ELINEAS**, generado a partir del escaneo
completo del repositorio (código, migraciones SQL, edge functions y los 18 documentos de `docs/`).

Tiene dos partes:

1. **Qué existe hoy** — entidades de datos, roles y catálogo de funcionalidades.
2. **En qué orden construirlo** — cada funcionalidad listada punto por punto, ordenada por dependencia
   técnica (lo que hay que tener funcionando antes de poder construir lo siguiente).

> **Cómo leer el estado de cada punto:** ✅ implementado · ⚠️ implementado parcialmente / con deuda
> conocida · ❌ no existe (pendiente).

---

## Parte 1 — Qué es el sistema

Plataforma de **control de asistencia laboral con geocerca GPS** para una operación con múltiples
departamentos y sedes. No se limita a marcar entrada/salida: cubre horarios por departamento,
descansos, vacaciones con acumulación, incidencias y justificación de ausencias, reportería mensual
asíncrona, notificaciones, ajustes de nómina, panel técnico de superadmin y distribución de su propia
app Android.

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + Vite + TypeScript + Tailwind + shadcn-ui (SPA) |
| Estado servidor | React Query + 2 Contexts (`AuthContext`, `NotificationsContext`) — sin state manager global |
| Backend | Supabase: Postgres + Auth + Storage + Edge Functions (Deno) |
| Capa de datos | Hooks custom en `src/hooks/` hablando directo con `supabase.from(...)` — **no hay capa de servicios/repositorio** |
| Autorización | Doble: `ProtectedRoute` en cliente + **RLS en Postgres** (la autoridad real) |
| Móvil | Capacitor → APK Android (`com.elineas.asistencia`), `HashRouter` en nativo |
| Gestión | Proyecto Lovable — push a `main` sincroniza, pero **publicar requiere Share → Publish manual** |

---

## Parte 2 — Roles

Enum `app_role` en Postgres. Un usuario puede tener **varias filas** en `user_roles`; gana el de mayor
prioridad ([roles.ts](../src/lib/roles.ts)`::getHighestRole`).

| Prioridad | Rol | Alcance |
|---|---|---|
| 1 | `employee` | Marca asistencia, ve su historial, pide vacaciones, configura sus descansos, crea incidencias. |
| 2 | `department_head` | Todo lo del empleado **+** ve/gestiona su departamento (y los adicionales de `user_department_responsibilities`), revisa incidencias, justifica ausencias, aprueba vacaciones de su depto, exporta su reporte. |
| 3 | `global_manager` | **No marca asistencia** (bloqueado en `validate_attendance_mark`). Panel global, configuración del sistema, gestión de usuarios y departamentos, reportería global, ajustes de nómina. Se le fuerza el departamento "Administración" por trigger. |
| 4 | `superadmin` | Todo lo del global manager **+** consola SQL, log global del sistema, modo de salida, borrado real de cuentas, publicación de la APK. |

**Dos shells de UI sobre el mismo backend** ([use-ui-mode.ts](../src/hooks/use-ui-mode.ts)):
viewport móvil (<768px) + rol no administrativo → `EmployeeShell` (bottom-nav); rol administrativo o
desktop → `AdminShell` (sidebar). Se fuerza con `?ui=employee` / `?ui=admin` para depurar.

---

## Parte 3 — Entidades (modelo de datos)

23 tablas propias del proyecto, agrupadas por dominio.

### 3.1 Identidad y organización

| Entidad | Propósito | Campos clave |
|---|---|---|
| `departments` | Departamentos/áreas (semilla: Picker and Packer, Expedición, Transporte, Inventario, Estibadores, Administración) | `name`, `rest_groups_enabled`, `is_paused`, `pause_reason`, `paused_at` |
| `profiles` | Perfil de negocio del usuario (1:1 con `auth.users`) | `user_id`, `email`, `full_name`, `department_id`, `phone`, `monthly_salary`, `last_connection_at`, `is_active`, `deactivated_at/by`, `deactivation_reason`, `contract_cancelled_at` |
| `user_roles` | Asignación de roles (tabla separada por seguridad) | `user_id`, `role` (enum `app_role`), único por par |
| `user_department_responsibilities` | Departamentos **adicionales** que gestiona un jefe (multi-depto) | `user_id`, `department_id` |

### 3.2 Reglas de trabajo

| Entidad | Propósito | Campos clave |
|---|---|---|
| `department_schedules` | Ventana horaria por departamento | `checkin_start/end_time`, `checkout_start/end_time`, `timezone`, `allow_early_checkin`, `allow_late_checkout` |
| `work_calendar` | Días laborables/no laborables por departamento y fecha | `date`, `is_workday`, `late_tolerance_minutes` |
| `user_rest_schedule` | Descansos individuales | `days_of_week[]`, `effective_from` |
| `rest_groups` | Grupos de descanso por departamento (Grupo A/B) | `department_id`, `name`, `days_of_week[]` |
| `rest_group_members` | Pertenencia de un usuario a un grupo, con vigencia | `group_id`, `user_id`, `effective_from` |

### 3.3 Ubicación / geocerca

| Entidad | Propósito | Campos clave |
|---|---|---|
| `geofence_config` | Geocerca única — **tabla legacy**, fallback si no hay `work_locations` | `center_lat/lng`, `radius_meters`, `accuracy_threshold`, `block_on_poor_accuracy` |
| `work_locations` | Sedes múltiples con geocerca propia (modelo vigente) | `name`, `center_lat/lng`, `radius_meters`, `accuracy_threshold`, `block_on_poor_accuracy`, `is_active` |

### 3.4 Asistencia

| Entidad | Propósito | Campos clave |
|---|---|---|
| `attendance_marks` | Marcaje individual (núcleo del producto) | `mark_type` IN/OUT, `timestamp`, `latitude/longitude/accuracy`, `distance_to_center`, `inside_geofence`, `blocked`, `block_reason`, `work_location_id` |
| `attendance_incidents` | Incidencia reportada por el empleado | `incident_type` (olvidé marcar / tardanza / salida temprana / gps / geofence), `status` pending→approved/rejected, `reason`, `manager_notes`, `reviewed_by/at` |
| `attendance_absence_reviews` | Justificación de una ausencia (**flujo distinto al de incidencias**) | `date`, `is_justified`, `notes`, `reviewed_by/at`, único por (`user_id`, `date`) |
| `vacation_requests` | Solicitud de vacaciones | `start_date`, `end_date`, `requested_days`, `status` pending/approved/rejected/cancelled, `review_comment` |

### 3.5 Reportería

| Entidad | Propósito | Campos clave |
|---|---|---|
| `attendance_daily_facts` | Snapshot precalculado día×empleado (rendimiento a escala) | `status` (PRESENTE/TARDE/AUSENTE/DESCANSO/NO_LABORABLE), `in/out_timestamp`, `late_minutes`, `worked_minutes` |
| `attendance_rule_versions` | Qué reglas estaban vigentes en cada corrida (trazabilidad) | `version`, `params`, `is_active`, `activated_at` |
| `report_runs` | Job asíncrono de reporte mensual | `scope` global/department, `period_start/end`, `status` queued→running→completed/failed, `artifact_bucket/path`, `checksum`, `row_count`, `duration_ms`, `retry_count`, `rule_version_id` |

### 3.6 Plataforma

| Entidad | Propósito |
|---|---|
| `app_config` | Configuración global clave/valor JSONB (ver 3.7) |
| `audit_log` | Bitácora de acciones (`action`, `table_name`, `record_id`, `old_data`/`new_data`, `source_ip`, `metadata`) |
| `notifications` | Notificaciones in-app con RLS por usuario (`type`, `title`, `body`, `read_at`, link de acción) |
| `payroll_adjustments` | Ajuste/descuento de nómina (`amount` ±, `category` unjustified_absence/vacation/other, `status` active/reverted, `source_type`/`source_id`, `created_by`, `reverted_by/at`) |
| `app_releases` | Versión publicada de la APK (`version_name`, `version_code`, `apk_path`, `file_size_bytes`, `release_notes`) |

**Buckets de Storage:** `monthly-reports` (privado, signed URLs, 50 MB) · `app-releases` (público, 200 MB, solo APK).

### 3.7 Claves de `app_config`

`include_heads_in_global_reports` · `default_work_start_time` · `default_work_end_time` ·
`late_tolerance_minutes` · `global_timezone` · `vacation_days_per_worked_day` ·
`attendance_checkout_mode` (manual/schedule/geofence_exit) · `attendance_auto_checkout_time` ·
`attendance_geofence_exit_minutes` · `rest_days_min_separation` ·
`rest_days_min_separation_departments` · `report_slo_error_rate_pct` · `report_slo_availability_pct` ·
`google_sheets_report_spreadsheet_id`

### 3.8 Lógica en base de datos (RPC / triggers)

**Seguridad:** `has_role`, `is_global_manager`, `is_superadmin`, `is_head_of_department`, `get_user_department`
**Asistencia:** `validate_attendance_mark`, `compute_daily_attendance_status`
**Vacaciones:** `get_vacation_accrual_rate`, `get_vacation_balance`, `request_vacation`, `cancel_vacation_request`, `review_vacation_request`
**Reportería:** `get_attendance_report_monthly`, `refresh_attendance_daily_facts(_for_range)`, `get_active_attendance_rule_version_id`, `get_report_runs_operational_kpis(_v2)`
**Admin:** `execute_superadmin_sql` (bloquea BEGIN/COMMIT/ROLLBACK)
**Triggers:** `handle_new_user` (crea perfil+rol al registrarse), `enforce_gm_department` (fuerza Administración a global managers), `handle_absence_review_payroll_impact` (genera/revierte descuento de nómina), varios `updated_at`

### 3.9 Edge Functions (Deno, 8)

`create-user` · `delete-user` · `reset-user-password` · `validate-attendance` · `import-attendance-history` ·
`generate-monthly-report` · `snapshot-daily-facts` · `export-report-to-sheet`

---

# Parte 4 — Orden lógico de implementación

Cada punto es una funcionalidad entregable. El orden es de **dependencia técnica**: nada en una fase
puede construirse sin lo anterior. Si el objetivo es rehacer, migrar o auditar el sistema, este es el
camino; si es sólo entenderlo, se lee como el índice de qué hace cada pieza y dónde vive.

---

## Fase 0 — Cimientos del proyecto

1. ✅ **Scaffolding** — Vite + React + TS + Tailwind + shadcn-ui, alias `@/*` (en `tsconfig` y
   `vite.config.ts`/`vitest.config.ts`), ESLint, Vitest.
   *Sin dependencias.*
2. ✅ **Conexión a Supabase** — cliente y tipos generados
   ([client.ts](../src/integrations/supabase/client.ts), [types.ts](../src/integrations/supabase/types.ts) —
   archivos generados, se regeneran con la CLI, no se editan a mano) + variables
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_PUBLIC_APP_URL`.
   *Depende de: 1.*

## Fase 1 — Identidad, roles y autorización

> Todo lo demás depende de esta fase: cada tabla posterior tiene políticas RLS que llaman a estas funciones.

3. ✅ **Departamentos** — tabla `departments` con la semilla fija de áreas. Es el ancla organizativa:
   perfiles, horarios, grupos de descanso y reportes cuelgan de aquí.
   *Depende de: 2.*
4. ✅ **Perfiles** — tabla `profiles` (1:1 con `auth.users`) + trigger `handle_new_user` que crea perfil
   y rol `employee` automáticamente al registrarse.
   *Depende de: 3.*
5. ✅ **Roles y funciones de seguridad** — enum `app_role`, tabla `user_roles` (separada del perfil a
   propósito), y las `SECURITY DEFINER` que toda política RLS reutiliza: `has_role`,
   `get_user_department`, `is_head_of_department`, `is_global_manager`, `is_superadmin`.
   *Depende de: 4.*
6. ✅ **Resolución de rol en cliente** — [AuthContext](../src/contexts/AuthContext.tsx) (sesión, perfil,
   rol resuelto) + [getHighestRole](../src/lib/roles.ts). El registro de `last_connection` va throttlado
   a 5 min por `sessionStorage`.
   *Depende de: 5.*
7. ✅ **Login y registro** — [Auth.tsx](../src/pages/Auth.tsx): alta con teléfono y departamento,
   "recordar credenciales" sólo en runtime nativo, construcción del link de confirmación
   ([auth-redirect.ts](../src/lib/auth-redirect.ts) — si falta `VITE_PUBLIC_APP_URL` en localhost el
   signup falla a propósito en vez de enviar un enlace roto).
   *Depende de: 6.*
8. ✅ **Guard de rutas** — [ProtectedRoute](../src/components/ProtectedRoute.tsx) con
   `allowedRoles`/`excludedRoles` + el árbol de rutas de [App.tsx](../src/App.tsx).
   *Depende de: 7.*
9. ✅ **Rol superadmin** — se añade al enum después del diseño original; incluye limpieza de FKs para
   que el borrado de un usuario no rompa integridad referencial.
   *Depende de: 5.*
10. ✅ **Jefe multi-departamento** — `user_department_responsibilities` + [useManagedDepartments](../src/hooks/useManagedDepartments.ts),
    para que un `department_head` gestione más de un departamento.
    *Depende de: 5, 9.*

## Fase 2 — Shells de interfaz

11. ✅ **Resolución de shell** — [use-mobile](../src/hooks/use-mobile.tsx) + [use-ui-mode](../src/hooks/use-ui-mode.ts)
    (con override `?ui=`) + [AppLayout](../src/components/layout/AppLayout.tsx) que elige shell.
    *Depende de: 8.*
12. ✅ **AdminShell** — [sidebar de backoffice](../src/components/layout/AdminShell.tsx) con navegación
    agrupada (Asistencia / Gestión), filtrado por rol, badges de pendientes y bottom-nav de respaldo en móvil.
    *Depende de: 11.*
13. ✅ **EmployeeShell** — [bottom-nav móvil](../src/components/layout/EmployeeShell.tsx)
    (Marcar / Mi semana / Incidencias / Perfil) + páginas dedicadas en [src/pages/employee/](../src/pages/employee/).
    *Depende de: 11.*
14. ✅ **Contención de errores** — `AppErrorBoundary`, `AppRouterBoundary`, `NotFound`, y el mapeo de
    errores de Supabase a español ([error-messages.ts](../src/lib/error-messages.ts)).
    *Depende de: 11.*

## Fase 3 — Configuración global y auditoría

15. ✅ **Configuración clave/valor** — tabla `app_config` + [useGeneralConfig](../src/hooks/useGeneralConfig.ts)
    + pestaña *General* de [Configuration.tsx](../src/pages/Configuration.tsx). Necesaria antes de las
    reglas de asistencia porque casi todas leen de aquí (zona horaria, tolerancia, acumulación, etc.).
    *Depende de: 5, 12.*
16. ✅ **Bitácora** — tabla `audit_log` (luego ampliada con `source_ip` y `metadata`), escrita desde
    gestión de usuarios y consumida por el panel de superadmin.
    *Depende de: 5.*

## Fase 4 — Horarios y calendario laboral

17. ✅ **Horarios por departamento** — `department_schedules` (ventana de entrada/salida, zona horaria,
    permitir entrada anticipada / salida tardía) **+ la RPC `validate_attendance_mark`**, que es donde
    vive la regla de si un marcaje se acepta o no.
    *Depende de: 3, 15.*
18. ✅ **Departamento forzado para gestores globales** — trigger `enforce_gm_department`: todo
    `global_manager` queda en "Administración" y `validate_attendance_mark` le bloquea el marcaje.
    *Depende de: 17.*
19. ✅ **Calendario laboral** — `work_calendar` (día laborable/no laborable y tolerancia por fecha y
    departamento).
    *Depende de: 3.*
20. ✅ **UI de horarios** — [DepartmentScheduleCard](../src/components/configuration/DepartmentScheduleCard.tsx)
    + [useDepartmentSchedules](../src/hooks/useDepartmentSchedules.ts), incluido el **modo pausa** del
    departamento (que bloquea marcajes) y la notificación automática a los miembros cuando cambia el horario.
    *Depende de: 17, 15.*

## Fase 5 — Geolocalización y geocercas

21. ✅ **Servicio de ubicación** — [location-service.ts](../src/lib/location-service.ts) +
    [useGeolocation](../src/hooks/useGeolocation.ts): abstrae Capacitor (nativo) vs `navigator.geolocation`
    (web), cálculo Haversine y seguimiento continuo.
    ⚠️ *El tracking en segundo plano en Android usa `watchPosition` como fallback, no un servicio nativo
    real — ver [android-geolocation-remediation.md](./android-geolocation-remediation.md).*
    *Depende de: 2.*
22. ✅ **Geocerca única → sedes múltiples** — `geofence_config` (legacy) y luego `work_locations`.
    [useGeofenceConfig](../src/hooks/useGeofenceConfig.ts) resuelve la config activa con fallback a la
    tabla legacy y migra automáticamente la primera vez que se abre el admin de sedes.
    *Depende de: 5.*
23. ✅ **Administración de sedes** — [useWorkLocationsConfig](../src/hooks/useWorkLocationsConfig.ts) +
    [WorkLocationsSection](../src/components/configuration/WorkLocationsSection.tsx) +
    [LocationMapPicker](../src/components/configuration/LocationMapPicker.tsx) (mini-mapa hecho a mano
    con tiles OSM, sin librería de mapas).
    *Depende de: 22, 15.*
24. ✅ **Selección de sede por sesión** — [useWorkLocations](../src/hooks/useWorkLocations.ts) +
    [WorkLocationSelector](../src/components/layout/WorkLocationSelector.tsx): obliga a elegir sede al
    iniciar sesión (salvo `global_manager`/`superadmin`), persistida en `localStorage` por usuario. La
    validación de geocerca del marcaje usa **esa** sede.
    *Depende de: 23.*
25. ✅ **Diagnóstico GPS** — [GpsDiagnostics.tsx](../src/pages/GpsDiagnostics.tsx): pantalla de soporte
    para ver permisos, precisión y distancia al centro.
    *Depende de: 21, 24.*

## Fase 6 — Marcaje de asistencia (núcleo del producto)

26. ✅ **Tabla de marcajes** — `attendance_marks` con coordenadas, precisión, distancia al centro,
    `inside_geofence`, `blocked`/`block_reason` y `work_location_id`.
    *Depende de: 5, 24.*
27. ✅ **Validación servidor** — edge function [validate-attendance](../supabase/functions/validate-attendance/index.ts).
    Es la puerta única de escritura y valida en orden: sesión → **vacaciones aprobadas activas** →
    `validate_attendance_mark` (rol, departamento, horario) → sede seleccionada válida y activa →
    **geocerca recalculada en servidor** (no se confía en la distancia del cliente) → precisión GPS →
    marca de tardanza. Recién entonces inserta.
    *Depende de: 26, 17, 24.*
28. ✅ **UI de marcaje** — [useAttendance](../src/hooks/useAttendance.ts) +
    [AttendanceButton](../src/components/attendance/AttendanceButton.tsx) /
    [GeofenceIndicator](../src/components/attendance/GeofenceIndicator.tsx) /
    [TodayMarks](../src/components/attendance/TodayMarks.tsx) +
    [Attendance.tsx](../src/pages/Attendance.tsx) y [EmployeeMarkPage](../src/pages/employee/EmployeeMarkPage.tsx).
    *Depende de: 27.*
29. ✅ **Modo de salida configurable** — `attendance_checkout_mode`: manual por usuario, automático por
    horario (`attendance_auto_checkout_time`) o automático por salida de geocerca
    (`attendance_geofence_exit_minutes`). Se ajusta desde el panel de superadmin.
    *Depende de: 28, 15.*
30. ✅ **Tolerancia de tardanza** — `late_tolerance_minutes` + [attendance-metrics.ts](../src/lib/attendance-metrics.ts).
    El cálculo de ventanas/tardanza usa `Intl.DateTimeFormat` contra la zona horaria, **sin librería de fechas**.
    *Depende de: 28, 15.*
31. ✅ **Historial propio** — [History.tsx](../src/pages/History.tsx) y
    [EmployeeWeekPage](../src/pages/employee/EmployeeWeekPage.tsx).
    *Depende de: 28.*
32. ✅ **Bloqueo por departamento pausado** — el marcaje se rechaza si el departamento está en pausa.
    *Depende de: 20, 27.*

## Fase 7 — Descansos

33. ✅ **Descansos individuales** — `user_rest_schedule` (`days_of_week[]` con vigencia desde una fecha).
    *Depende de: 5.*
34. ✅ **Grupos de descanso** — `rest_groups` + `rest_group_members` + `departments.rest_groups_enabled`,
    para departamentos que rotan por grupos (Grupo A/B) en vez de elección individual.
    *Depende de: 33, 3.*
35. ✅ **Separación mínima entre descansos** — `rest_days_min_separation` global +
    `rest_days_min_separation_departments` para acotar a qué departamentos aplica la regla.
    *Depende de: 34, 15.*
36. ✅ **UI de descansos** — [useRestSchedule](../src/hooks/useRestSchedule.ts) +
    [RestSchedule.tsx](../src/pages/RestSchedule.tsx): valida separación mínima y que no se marque como
    descanso un día ya trabajado.
    *Depende de: 35.*

## Fase 8 — Vacaciones

37. ✅ **Solicitudes y acumulación** — `vacation_requests` + `vacation_days_per_worked_day`.
    Modelo de acumulación simple: `earned = worked_days × rate`,
    `available = earned − approved − pending`. **No existe saldo negativo**: la solicitud se bloquea en
    origen si no alcanza.
    *Depende de: 26 (los días trabajados salen de `attendance_marks`), 15.*
38. ✅ **RPCs de vacaciones** — `get_vacation_balance`, `request_vacation`, `cancel_vacation_request`,
    `review_vacation_request`. **Todas las mutaciones pasan por RPC, nunca `insert`/`update` directo** —
    mantener ese patrón al tocar este módulo.
    *Depende de: 37.*
39. ✅ **UI de vacaciones** — [useVacations](../src/hooks/useVacations.ts) +
    [Vacations.tsx](../src/pages/Vacations.tsx): saldo, solicitud, cancelación y revisión por el jefe.
    *Depende de: 38.*
40. ✅ **Interacción con el marcaje** — un empleado con vacaciones aprobadas vigentes no puede marcar
    (bloqueo en la edge function, punto 27).
    *Depende de: 39, 27.*

> ⚠️ [plan-implementacion-vacaciones.md](./plan-implementacion-vacaciones.md) describe este módulo como
> pendiente: **está desactualizado**, el módulo está completo.

## Fase 9 — Incidencias y justificación de ausencias

41. ✅ **Incidencias** — `attendance_incidents` + [incidents.ts](../src/lib/incidents.ts): tipos
    *olvidé marcar / tardanza / salida temprana / gps / geofence*, flujo `pending → approved|rejected`
    con notas del gestor. La UI detecta si falta la migración y se degrada con aviso en vez de romper.
    *Depende de: 26.*
42. ✅ **Vista del empleado** — [Incidents.tsx](../src/pages/Incidents.tsx) /
    [EmployeeIncidentsPage](../src/pages/employee/EmployeeIncidentsPage.tsx): filtro por estado, contador
    de pendientes, validación de motivo para tipos críticos.
    *Depende de: 41.*
43. ✅ **Vista de gestión** — [IncidentsManagementPage](../src/pages/management/IncidentsManagementPage.tsx):
    búsqueda por empleado/correo/departamento/tipo, orden con pendientes primero, notas de revisión.
    *Depende de: 41, 10.*
44. ✅ **Revisión de ausencias** — `attendance_absence_reviews`. **Flujo separado del de incidencias**:
    marca un día ausente como justificado o no, por upsert desde [Department.tsx](../src/pages/Department.tsx)
    (jefe) o [GlobalPanel.tsx](../src/pages/GlobalPanel.tsx) (gestor global). Alimenta los códigos
    AJ/ANJ del reporte **y dispara el descuento automático de nómina** (punto 63).
    *Depende de: 26.*
45. ✅ **RLS multi-departamento e índices** — expansión de políticas para que el jefe vea los
    departamentos que gestiona, e índices sobre `attendance_incidents` por usuario/estado/fecha.
    *Depende de: 43, 44, 10.*

## Fase 10 — Notificaciones

46. ✅ **Tabla y RLS** — `notifications`, aislada por usuario.
    *Depende de: 5.*
47. ✅ **Contexto y UI** — [NotificationsContext](../src/contexts/NotificationsContext.tsx) (Realtime
    `postgres_changes` + polling de 30 s como respaldo, toast al insertar) +
    [NotificationBell](../src/components/layout/NotificationBell.tsx) +
    [Notifications.tsx](../src/pages/Notifications.tsx).
    *Depende de: 46, 12.*
48. ✅ **Permisos nativos** — [notification-permissions.ts](../src/lib/notification-permissions.ts),
    solicitados desde `ProtectedRoute` en el primer render autenticado en runtime nativo.
    *Depende de: 47, 65.*
49. ⚠️ **Recordatorio automático de descansos** — `syncRestScheduleReminder` crea/actualiza un aviso si
    un empleado o jefe no configuró sus descansos de la semana.
    *Es lógica de negocio embebida dentro del Context, no un hook de dominio — tenerlo presente al buscar
    dónde vive una regla.*
    *Depende de: 47, 36.*

## Fase 11 — Paneles de gestión y reportería

50. ✅ **Agregación de asistencia** — [useAttendanceSummary](../src/hooks/useAttendanceSummary.ts) (603
    líneas, el hook más grande): resuelve el estado diario por empleado
    (`PRESENTE`/`TARDE`/`AUSENTE`/`DESCANSO`/`NO_LABORABLE`, más `VACACIONES` superpuesto) combinando
    marcajes, horarios, descansos, vacaciones y justificaciones.
    *Depende de: 26, 36, 39, 44.*
51. ✅ **Dashboard de inicio** — [Index.tsx](../src/pages/Index.tsx) + [MetricCard](../src/components/dashboard/MetricCard.tsx):
    estado de hoy, marcajes, resumen ejecutivo, tendencia de 7 días y alertas de gestión, variando por rol.
    *Depende de: 50.*
52. ✅ **Panel de departamento** — [Department.tsx](../src/pages/Department.tsx): asistencia del día de su
    equipo, justificación de ausencias y exportación acotada a su departamento.
    *Depende de: 50, 44.*
53. ✅ **Panel global** — [GlobalPanel.tsx](../src/pages/GlobalPanel.tsx): trabajadores por departamento,
    asistencia de hoy, detalle por empleado, exportación y envío a Google Sheets.
    *Depende de: 50.*
54. ✅ **Exportación XLSX** — [xlsx-export.ts](../src/lib/xlsx-export.ts): matriz mensual empleado×día con
    códigos (incluidos AJ/ANJ para ausencias justificadas/no justificadas) y resumen de 6 columnas
    (Presente / Descanso / Tardanza / A. Justificada / A. Injustificada / Vacaciones).
    *Depende de: 50.*
55. ✅ **RPC de reporte mensual** — `get_attendance_report_monthly`: mueve el cálculo del cliente al
    servidor, eliminando el N+1 previo.
    *Depende de: 54.*
56. ✅ **Pipeline asíncrono** — `report_runs` + bucket `monthly-reports` (descarga por signed URL) +
    edge function [generate-monthly-report](../supabase/functions/generate-monthly-report/index.ts) +
    [ReportRunsCard](../src/components/reports/ReportRunsCard.tsx) (poll cada 15 s mientras haya corridas
    activas). El reintento **crea una fila nueva**, no muta el historial.
    *Depende de: 55.*
57. ✅ **Escala y trazabilidad** — `attendance_daily_facts` (snapshot precalculado) +
    `compute_daily_attendance_status` + `refresh_attendance_daily_facts(_for_range)` + edge function
    [snapshot-daily-facts](../supabase/functions/snapshot-daily-facts/index.ts) + `attendance_rule_versions`
    (qué reglas regían en cada corrida).
    *Depende de: 56.*
58. ⚠️ **Observabilidad de reportes** — `get_report_runs_operational_kpis(_v2)` (tasa de error,
    disponibilidad, p95 de duración) + SLOs en `app_config`.
    *Ver hallazgo H-1 más abajo: la v2 tiene los argumentos invertidos en el check de jefe de departamento.*
    *Depende de: 56.*
59. ⚠️ **Exportación a Google Sheets** — botón "Enviar a Sheets" en el panel global + edge function
    [export-report-to-sheet](../supabase/functions/export-report-to-sheet/index.ts), autenticada con JWT
    RS256 de cuenta de servicio (`GOOGLE_SERVICE_ACCOUNT_JSON`) contra `google_sheets_report_spreadsheet_id`.
    *La función Deno **reimplementa a mano** la misma matriz que `xlsx-export.ts` porque no puede importar
    `src/lib`; no hay contrato compartido ni test que detecte una desincronización.*
    *Depende de: 54, 15.*

## Fase 12 — Administración de usuarios y panel técnico

60. ✅ **Gestión de usuarios** — [useUserManagement](../src/hooks/useUserManagement.ts) +
    [UserManagement.tsx](../src/pages/UserManagement.tsx) + edge functions `create-user`, `delete-user`,
    `reset-user-password`. Corren con service role porque no deben ejecutarse con la sesión RLS del propio usuario.
    *Depende de: 5, 16.*
61. ✅ **Ciclo de vida de la cuenta** — desactivación/reactivación (`is_active`, `deactivated_at/by`,
    `deactivation_reason`, `contract_cancelled_at`) y `last_connection_at`
    ([last-connection.ts](../src/lib/last-connection.ts)) — separado del borrado real.
    *Depende de: 60.*
62. ✅ **Gestión de departamentos** — [DepartmentsManagement.tsx](../src/pages/DepartmentsManagement.tsx):
    CRUD de departamentos, grupos de descanso y asignación de responsabilidades multi-depto.
    *Depende de: 34, 10.*
63. ✅ **Panel de superadmin** — [SuperAdmin.tsx](../src/pages/SuperAdmin.tsx) +
    [useSuperAdmin](../src/hooks/useSuperAdmin.ts): estadísticas globales, log completo del sistema,
    consola SQL restringida (`execute_superadmin_sql`), modo de salida, gestión total de cuentas e
    importación de histórico desde Excel ([import-attendance-history](../supabase/functions/import-attendance-history/index.ts)).
    *Depende de: 60, 16, 29.*

## Fase 13 — Nómina

64. ⚠️ **Ajustes y descuentos** — `profiles.monthly_salary` + `payroll_adjustments` (RLS: sólo
    `global_manager`/`superadmin`) + trigger `SECURITY DEFINER` `handle_absence_review_payroll_impact`
    sobre `attendance_absence_reviews`: marcar una ausencia como **no justificada** genera un descuento
    de `sueldo_mensual/30`; reclasificarla como justificada lo **revierte** (marca `reverted`, no borra).
    Corre con `SECURITY DEFINER` porque el jefe de departamento —quien justifica— no tiene ni debe tener
    acceso a la tabla de nómina.
    **Decisión de negocio explícita: las vacaciones NO generan descuento automático** (son días pagados);
    sólo se registran como ajuste manual si un admin lo decide.
    *Depende de: 44, 60.*
65. ✅ **UI de nómina** — [usePayrollAdjustments](../src/hooks/usePayrollAdjustments.ts) +
    [PayrollAdjustments.tsx](../src/pages/PayrollAdjustments.tsx) en `/nomina`: edición de sueldos,
    historial con filtro por departamento, ajuste manual y reversión.
    *Depende de: 64.*

## Fase 14 — App móvil y distribución

66. ✅ **Detección de runtime nativo** — [mobile-runtime.ts](../src/lib/mobile-runtime.ts) +
    intercambio `BrowserRouter` → `HashRouter` en nativo (los orígenes `file://` no soportan rutas por path).
    *Depende de: 8.*
67. ⚠️ **Proyecto Android (Capacitor)** — `android/` (appId `com.elineas.asistencia`), permisos de
    ubicación foreground/background, íconos del launcher, hardening del build.
    *Sin CI: compilación y firma son 100 % manuales — ver [guia-compilar-apk-android-studio.md](./guia-compilar-apk-android-studio.md).*
    *Depende de: 66, 21.*
68. ✅ **Distribución de la APK desde la web** — `app_releases` + bucket público `app-releases` +
    [AppReleasesSection](../src/components/superadmin/AppReleasesSection.tsx) (el superadmin sube versión,
    version code y notas) + página pública [DownloadApp](../src/pages/DownloadApp.tsx) en `/descargar-app`,
    sin login, que sirve la versión más alta por `version_code`.
    *Depende de: 67, 63.*

## Fase 15 — Trabajo pendiente (nada de esto existe hoy)

Ordenado por impacto, siguiendo la priorización de [ONBOARDING.md](../ONBOARDING.md) §7:

69. ❌ **CI/CD** — no existe `.github/workflows`. Lint, test, build y deploy son manuales; nada bloquea
    un merge roto. Es el mayor gap estructural.
70. ❌ **Control formal de cambios de esquema** — ya ocurrió un drift real entre la base remota y el
    historial de migraciones (SQL ejecutado fuera de `db push`). Falta que todo cambio pase
    obligatoriamente por una migración del repo.
71. ❌ **Tests de lógica crítica** — hoy sólo hay 4 archivos de test que cubren utilidades puras
    (`lib/incidents.ts`, `use-ui-mode.ts`). **Cero cobertura** de geocerca, cálculo de tardanza,
    acumulación de vacaciones, el trigger de nómina o las RLS de `payroll_adjustments`.
72. ❌ **Code splitting** — bundle principal >1.8 MB minificado, sin `manualChunks` ni `import()` dinámico.
73. ❌ **Contrato compartido de reportería** — una sola fuente (o al menos un test) entre
    `xlsx-export.ts` y `export-report-to-sheet` para que un cambio de columnas no desincronice ambos en silencio.
74. ❌ **Cierre de la auditoría de usabilidad/accesibilidad** — el plan P0–P2 de
    [guia-remediacion-paso-a-paso.md](./guia-remediacion-paso-a-paso.md) no está confirmado como ejecutado.
75. ❌ **Divisor de nómina configurable** — el `/30` está fijo en la función SQL; debería exponerse en
    Configuración como `vacation_days_per_worked_day`.
76. ❌ **Nómina en reportería, auditoría y notificaciones** — los ajustes no aparecen en el XLSX/Sheets,
    no quedan en `audit_log` y el empleado no recibe aviso cuando se le aplica o revierte uno.
77. ❌ **Background geolocation real en Android** — evaluar un plugin/servicio nativo en lugar del
    `watchPosition` actual.
78. ❌ **Particionamiento de `attendance_marks`** — condicional a superar el umbral (>10 M filas o p95 >2 s
    sostenido); nunca implementado.
79. ❌ **Ejecución de las pruebas de carga** — [pruebas-carga-reportes.md](./pruebas-carga-reportes.md) es
    una guía sin evidencia de haberse ejecutado.
80. ❌ **Limpieza** — migración vacía `20260216151704_new-migration.sql` sin explicar, doc de vacaciones
    desactualizado, `android` sin ignorar en `eslint.config.js` (hace fallar `npm run lint` sin acotar).

---

# Parte 5 — Hallazgos del escaneo

Cosas detectadas al leer el código que no estaban documentadas antes:

**H-1 · Argumentos invertidos en `get_report_runs_operational_kpis_v2`** ⚠️
[20260424101500_reporting_kpis_scope_filters.sql:31](../supabase/migrations/20260424101500_reporting_kpis_scope_filters.sql#L31)
llama `is_head_of_department(rr.department_id, auth.uid())`, pero la firma es
`is_head_of_department(_user_id, _dept_id)`. Falla cerrado (no es un agujero de seguridad), pero un
`department_head` no verá los KPIs operativos de las corridas de su propio departamento. El mismo error
existía en las migraciones de incidencias y ausencias de febrero/marzo, pero allí **sí** fue corregido
por `20260305123000`; en esta función quedó vivo, por ser la última migración que la define.

**H-2 · El proyecto Supabase está compartido con otras aplicaciones** ℹ️
[types.ts](../src/integrations/supabase/types.ts) declara ~15 tablas que **no existen en las migraciones
de este repo y no se usan en ningún punto del código**: `activos`, `guardias`, `requests`,
`request_comments`, `request_feedback`, `request_histories`, `request_trash`, `worklogs`,
`knowledge_base`, `automation_rules`, `automation_logs`, `chat_logs`, `app_users`, `audit_logs`,
`incidents`. Son de otro sistema que convive en la misma instancia. Implicaciones: el esquema `public`
no es exclusivo de esta app, `audit_logs`/`incidents` son homónimos confusos de los propios
(`audit_log`/`attendance_incidents`), y regenerar tipos siempre arrastrará ruido ajeno.

**H-3 · Dato financiero sin barrera a nivel de columna** ⚠️
`profiles.monthly_salary` sólo está protegido porque ningún hook de rol bajo hace `select('*')` sobre
`profiles` — RLS en Postgres es por fila, no por columna. Hoy se cumple, pero nada lo impide a futuro.

**H-4 · La regla de negocio del recordatorio de descansos vive en un Context**
`syncRestScheduleReminder` está dentro de `NotificationsContext`, no en `src/hooks/`. Si se busca esa
regla en la capa de dominio no aparece.

---

## Referencias

| Para profundizar en | Leer |
|---|---|
| Contexto completo de negocio, arquitectura y deuda técnica | [ONBOARDING.md](../ONBOARDING.md) |
| Guía de arquitectura para agentes/desarrolladores | [CLAUDE.md](../CLAUDE.md) |
| Pipeline de reportería (técnico / operativo) | [pipeline-reporting-tecnico.md](./pipeline-reporting-tecnico.md) · [runbook-reporting-pipeline.md](./runbook-reporting-pipeline.md) |
| Escalabilidad y trazabilidad de reportes | [analisis-escalabilidad-trazabilidad-reportes.md](./analisis-escalabilidad-trazabilidad-reportes.md) |
| Auditoría de usabilidad y su plan de remediación | [usabilidad-calidad-reporte.md](./usabilidad-calidad-reporte.md) · [guia-remediacion-paso-a-paso.md](./guia-remediacion-paso-a-paso.md) |
| Android / Capacitor / APK | [android-geolocation-remediation.md](./android-geolocation-remediation.md) · [guia-compilar-apk-android-studio.md](./guia-compilar-apk-android-studio.md) · [guia-publicar-app-movil.md](./guia-publicar-app-movil.md) · [checklist-hardening-apk.md](./checklist-hardening-apk.md) |
| Módulo de nómina | [resumen-ajustes-nomina.md](./resumen-ajustes-nomina.md) |
| Aplicar cambios de base de datos | [comandos-aplicar-cambios-bd.md](./comandos-aplicar-cambios-bd.md) |
| Manual de usuario final | [manual-usuario.md](./manual-usuario.md) |
