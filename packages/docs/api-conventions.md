# Convenciones de API

Cómo agregar un nuevo endpoint sin romper el contrato entre backend y
frontend.

1. **Esquema** — si el endpoint introduce una entidad o input nuevo,
   agrégalo en `packages/validations/src/<entidad>.ts` con Zod y expórtalo
   desde `packages/validations/src/index.ts`.

2. **Spec** — describe el endpoint en `packages/contracts/src/<recurso>.ts`:
   `method`, `path` y los esquemas `body`/`response` que importaste de
   `@elineas/validations`. Exporta el spec desde `packages/contracts/src/index.ts`.

   ```ts
   export const usersSpec = {
     get: {
       method: 'GET',
       path: '/api/users/:id',
       response: userSchema,
     },
   } as const
   ```

3. **Backend** — en `apps/backend/src/routes/`, crea o extiende el router
   de Hono usando el `path` del spec y `zValidator` con el esquema
   correspondiente para el body.

4. **Frontend** — consume el endpoint construyendo la URL con
   `VITE_BACKEND_URL + spec.path` y parsea la respuesta con
   `spec.response.parse(...)` para tener el tipo correcto y fallar rápido
   si el backend responde algo inesperado.

Mantener el `path` únicamente en el spec (nunca hardcodeado en dos lugares)
es lo que evita que backend y frontend se desincronicen.
