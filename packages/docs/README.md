# @elineas/docs

Documentación del monorepo. No es una app ni exporta código: son archivos
markdown de referencia para quienes trabajan en el repo.

- [specs/](../specs/README.md) — **especificaciones funcionales del producto**, una por
  funcionalidad (asistencia, geocerca, vacaciones, nómina…). Es la referencia de qué hay que
  construir. Salen de trocear [old-docs.md](./old-docs.md).
- [architecture.md](./architecture.md) — cómo están organizadas las apps y los paquetes compartidos.
- [api-conventions.md](./api-conventions.md) — convenciones para agregar endpoints al backend.
- [contributing.md](./contributing.md) — cómo levantar el proyecto en local y flujo de trabajo.
- [identity-server-usage.md](./identity-server-usage.md) — integración con el Identity Server externo de Elineas — **referencia normativa** de la autenticación del proyecto.
- [../../DEPLOY.md](../../DEPLOY.md) — Docker en local y despliegue en el servidor.
- [old-docs.md](./old-docs.md) — mapa del sistema legacy (React + Vite + Supabase). Fuente
  histórica: ya está troceada en `specs/`; cuando ambos difieran, manda la spec.
