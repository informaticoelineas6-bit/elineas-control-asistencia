# Specs — Control de Asistencia ELINEAS

Especificaciones funcionales del sistema, una por funcionalidad. Salen de trocear
[`../old-docs.md`](../docs/old-docs.md) — el mapa del sistema legacy (React + Vite + Supabase) —
en unidades que se puedan leer, corregir y construir por separado sobre el monorepo nuevo
(Hono + Drizzle + TanStack Start).

> **`old-docs.md` es la fuente histórica, no la referencia de trabajo.** Estas specs la
> reemplazan. Cuando una spec y el documento viejo digan cosas distintas, manda la spec.

## Qué es cada spec

No son documentación de lo que hay: son **el contrato de lo que debe existir**. Cada una
describe una funcionalidad completa — datos, reglas, permisos, API, UI y criterios de
aceptación — de forma que pueda implementarse sin volver al legacy.

Cada archivo sigue la misma estructura:

| Sección | Para qué |
|---|---|
| Cabecera | Origen en `old-docs.md`, estado en legacy y en el monorepo, de qué depende y qué habilita |
| Objetivo | Qué problema resuelve, en una o dos frases |
| Modelo de datos | Tablas y campos, con notas de diseño |
| Reglas de negocio | Numeradas `RN-<nn>.<n>` para poder citarlas en código y en PRs |
| Flujos | Los recorridos que importan |
| API propuesta | Endpoints con su rol mínimo |
| UI | Pantallas y comportamiento |
| Criterios de aceptación | Casilla por casilla, lo que hay que poder demostrar |
| Decisiones abiertas | Lo que **hay que decidir antes de implementar** |

Convenciones de lectura:

- ✅ implementado en el legacy · ⚠️ implementado con deuda conocida · ❌ no existe.
- **Propuesta** marca lo que no venía del legacy y se añade por criterio.
- ⚠️ dentro del texto marca una trampa heredada que no debe repetirse.
- Las **decisiones abiertas** son deliberadas: donde el legacy no dejaba claro el
  comportamiento, la spec pregunta en vez de inventar.

## Índice

### Spec cero — leerla antes que ninguna otra

| # | Spec | Contenido |
|---|---|---|
| 00 | [Fundación: base de datos propia e identidad federada](./00-migracion-datos-e-identidad.md) | La base sale de Supabase al contenedor de PostgreSQL; usuarios, roles, autenticación y autorización pasan al **Identity Server de Elineas**; y la UX del corte |

Fija dos decisiones que ya no se discuten y que reescriben partes de las specs 02, 03, 04 y 21.

### Cimientos — nada funciona sin esto

Los cimientos están construidos. La columna **monorepo** es lo que hay hoy en el código, no lo
que la spec pide; cada cabecera detalla qué falta y por qué.

| # | Spec | Legacy | Monorepo | Depende de |
|---|---|---|---|---|
| 01 | [Organización: departamentos](./01-organizacion-departamentos.md) | ✅ | ✅ | — |
| 02 | [Usuarios y perfiles](./02-usuarios-y-perfiles.md) | ✅ | ✅ | 01 |
| 03 | [Roles y autorización](./03-roles-y-autorizacion.md) | ✅ | ✅ | 02 |
| 04 | [Autenticación y sesión](./04-autenticacion.md) | ✅ | ✅ | 02, 03 |
| 05 | [Shells de interfaz y navegación](./05-shells-y-navegacion.md) | ✅ | ⚠️ | 03, 04 |
| 06 | [Configuración global](./06-configuracion-global.md) | ✅ | ✅ | 03 |

Lo único que queda abierto en los cimientos es el **EmployeeShell** de la
[05](./05-shells-y-navegacion.md) §3: tres de sus cuatro destinos (`/clock-in`, `/my-week`,
`/issues`) pertenecen a las specs 09 y 12, así que se construye con ellas. La regla de
resolución de shell (§2) espera por lo mismo — hoy sólo existe un shell entre el que elegir.

### Reglas de trabajo — el marco que hace válido un marcaje

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 07 | [Horarios y calendario laboral](./07-horarios-y-calendario.md) | ✅ | 01, 06 |
| 08 | [Sedes, geocerca y geolocalización](./08-sedes-y-geocerca.md) | ⚠️ | 03, 06 |
| 10 | [Descansos](./10-descansos.md) | ✅ | 01, 06 |

### Núcleo

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 09 | [Marcaje de asistencia](./09-marcaje-asistencia.md) | ✅ | 07, 08, 10, 11 |

### Excepciones — lo que pasa cuando no se marca

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 11 | [Vacaciones](./11-vacaciones.md) | ✅ | 06, 09 |
| 12 | [Incidencias](./12-incidencias.md) | ✅ | 03, 09 |
| 13 | [Justificación de ausencias](./13-justificacion-ausencias.md) | ✅ | 03, 09 |

### Salidas — lo que el sistema produce

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 14 | [Notificaciones](./14-notificaciones.md) | ⚠️ | 02, 05 |
| 15 | [Agregación diaria, dashboard y paneles](./15-paneles-y-dashboard.md) | ✅ | 07, 09, 10, 11, 13 |
| 16 | [Reportería mensual](./16-reporteria-mensual.md) | ⚠️ | 15 |
| 17 | [Nómina: ajustes y descuentos](./17-nomina.md) | ⚠️ | 02, 13 |
| 18 | [Bitácora de auditoría](./18-auditoria.md) | ⚠️ | 03 |

### Plataforma

| # | Spec | Estado legacy | Depende de |
|---|---|---|---|
| 19 | [Panel de superadmin](./19-panel-superadmin.md) | ✅ | 02, 06, 18 |
| 20 | [App móvil Android y distribución](./20-app-movil-y-distribucion.md) | ⚠️ | 04, 08, 19 |

### Transversales

| # | Spec | Estado | Contenido |
|---|---|---|---|
| 21 | [Migración desde el legacy](./21-migracion-desde-legacy.md) | ❌ | Qué datos se traen, qué se deja atrás, estrategia de corte |
| 22 | [Calidad, pruebas y deuda técnica](./22-calidad-y-deuda-tecnica.md) | ❌ | CI, cobertura mínima obligatoria, principios de arquitectura |

## Orden de construcción sugerido

Por dependencia técnica, no por valor de negocio:

```
00                             base propia + Identity Server: precede a todo
01 → 02 → 03 → 04 → 05        cimientos: sin esto no hay nada
06                             configuración: casi todas las reglas leen de aquí
07 → 08 → 10                   el marco de validez de un marcaje
09                             el núcleo del producto
11 → 12 → 13                   las excepciones
15 → 16                        agregación y reportes
17                             nómina (depende de 13)
14 · 18                        transversales, en paralelo desde temprano
19 → 20                        plataforma
```

**21** y **22** no son una fase final: se leen **antes de empezar**. La 22 fija cómo se
construye todo lo demás y la 21 condiciona el modelo de datos.

## Ya decidido

- **La base de datos deja Supabase** y pasa al contenedor de PostgreSQL del monorepo.
- **Usuarios, roles, autenticación y autorización se rigen por el Identity Server de Elineas**
  ([identity-server-usage.md](../docs/identity-server-usage.md)); **better-auth se retira**.
- **El alta de usuarios se hace en el Identity Server**, no en esta aplicación — ni siquiera
  llamando a su API. Aquí sólo se completa el perfil de negocio.
- **Un perfil desactivado no puede autenticarse aquí**: el login se rechaza aunque las
  credenciales del IS sean correctas. Es una baja de este sistema, no de Elineas.
- **El IS admite alta masiva**, lo que simplifica el corte: las cuentas de toda la plantilla se
  crean de una vez.

Todas en [00](./00-migracion-datos-e-identidad.md).

Y dos de forma:

- **El código se escribe en inglés; la interfaz, en español.** Rutas incluidas: *Mi asistencia*
  vive en `/attendance`. Los comentarios y estas specs siguen en español, porque el código
  las cita por número de regla. Tabla completa en
  [contributing.md §idioma](../docs/contributing.md) y
  [05 §7](./05-shells-y-navegacion.md).
- **El departamento de los `global_manager` se configura por id**, no por el nombre
  "Administración" del trigger del legacy ([03](./03-roles-y-autorizacion.md) RN-03.6).

## Antes de implementar

Lo que sigue abierto y bloquea a varias specs a la vez:

1. **¿Se reimplementa RLS en Postgres, o la autorización vive sólo en Hono?**
   → [03](./03-roles-y-autorizacion.md) §6. Con Supabase fuera, la red de seguridad
   desaparece: es el riesgo número uno de la migración
   ([00](./00-migracion-datos-e-identidad.md) RN-00.1).
2. **Dos preguntas al equipo del Identity Server**, de las que depende la UX del corte y el
   soporte del día a día: ¿fuerza cambio de contraseña al primer ingreso?, ¿tiene recuperación
   autoservicio? → [00](./00-migracion-datos-e-identidad.md) §B.1.
3. **¿Hace falta geolocalización en segundo plano y marcaje sin conexión?**
   → [20](./20-app-movil-y-distribucion.md) §7. Decide la forma de la app móvil; no bloquea
   nada más si el backend queda preparado para autenticar también por cabecera.

Y una de negocio, no técnica, que puede reescribir una spec entera:

4. **¿El modelo de vacaciones debe cumplir la normativa laboral cubana?**
   → [11](./11-vacaciones.md) §2. *(Decía "peruana": la empresa opera en Cuba, ver
   [06](./06-configuracion-global.md) §8.)*
