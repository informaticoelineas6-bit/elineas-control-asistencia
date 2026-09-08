# 22 · Calidad, pruebas y deuda técnica

> **Origen:** `old-docs.md` Fase 15 (puntos 69–80) y Parte 5 (hallazgos H-1 a H-4).
> **Estado en el sistema legacy:** ❌ nada de esto existía. Era la oportunidad de no repetirlo.
> **Estado en el monorepo nuevo:** ✅ **el flujo de CI existe** (`.github/workflows/ci.yml`) con
> los cinco pasos de la §2, más el presupuesto de tamaño de RQ-22.4
> (`scripts/check-bundle.ts`) y la verificación de deriva de esquema
> (`scripts/check-schema-drift.ts`). La lista de cobertura de la §3 está **verificada fila por
> fila** contra las pruebas que existen: 684 en total —675 de backend, 9 de frontend—.
>
> **Escribir el CI encontró tres cosas que había que arreglar antes**, y eso es exactamente para
> lo que sirve: el paso de lint no pasaba —tres errores en componentes de shadcn y el `$schema`
> de Biome desfasado—, `packages/contracts` no compilaba por su cuenta (`URLSearchParams` no
> está en la librería `ES2022`) y **RQ-22.5 sólo estaba medio cumplida**: había conteo de
> consultas en el panel y no en el reporte.
>
> **Lo que no está:** la protección de rama, que es lo único de esta spec que no puede vivir en
> el repositorio (§2); las pruebas de carga de la §5; y la auditoría de accesibilidad de la §6.

---

## 1. Por qué esta spec existe

El sistema legacy funcionaba, pero **sin integración continua, sin control formal del esquema
y prácticamente sin pruebas**: cuatro archivos de test sobre utilidades puras, y cero
cobertura de la geocerca, el cálculo de tardanza, la acumulación de vacaciones, el descuento
de nómina y las reglas de acceso.

Esas cinco cosas son exactamente **las que mueven dinero y afectan al empleo de personas**.
Esta spec fija el mínimo no negociable para el sistema nuevo.

## 2. Integración continua (punto 69)

**El mayor hueco estructural del legacy: no existe.** Lint, pruebas, build y despliegue son
manuales y nada bloquea una fusión rota.

Requisito mínimo del flujo de CI:

1. `lint` — Biome sobre todo el monorepo.
2. `typecheck` — todos los paquetes.
3. `test` — unitarios + de integración.
4. `build` — backend y frontend.
5. **Verificación de esquema** — el esquema desplegado coincide con las migraciones del
   repositorio ([21](./21-migracion-desde-legacy.md) §8).

   *(Aquí había un sexto paso —build y firma del APK— que desapareció con la spec de la app
   móvil: no hay nada nativo que empaquetar. Con eso, los cinco pasos de RQ-22.1 son exactamente
   los cinco que existen.)*

- **RQ-22.1** — Ningún cambio se fusiona a `main` sin que los pasos 1–5 pasen.

> ✅ **Construido**, en un solo trabajo y en ese orden, que es el del coste: lo que falla en
> segundos va antes que lo que tarda minutos — un `lint` roto no debe esperar a que arranque un
> PostgreSQL.
>
> ⚠️ **RQ-22.1 no se cumple sola con este archivo.** El flujo *declara* las comprobaciones;
> bloquear la fusión es marcar el trabajo como obligatorio en la configuración de la rama, y eso
> vive en GitHub, no en el repositorio. **Es lo único de esta spec que no se puede confirmar en
> un commit**, y por eso queda dicho aquí: sin ese interruptor, los cinco pasos son un informe,
> no una barrera.
>
> Tres decisiones del flujo que no son evidentes:
>
> - **Las pruebas necesitan un PostgreSQL de verdad**, no un doble. Es RQ-22.3 y es la razón que
>   `contributing.md` ya daba: con la RLS de Supabase fuera, el handler de Hono es la única
>   barrera de autorización, así que una prueba con la autorización simulada no probaría nada.
> - **La CI escribe el mismo `.env.local` que un desarrollador tiene en local**, en vez de
>   inventarse otra forma de pasar la configuración. Así corre **exactamente el mismo comando** y
>   no puede desviarse de él.
> - **`AUTH_API_URL` apunta a un dominio que no resuelve.** Las pruebas sustituyen el módulo del
>   Identity Server; si alguna intentara hablar con él de verdad, tiene que fallar de forma
>   ruidosa en vez de irse a un servidor real.

## 3. Cobertura mínima obligatoria

No se pide un porcentaje global; se piden **estas pruebas concretas**, porque son las que
faltaban:

| Área | Qué debe estar probado | Spec |
|---|---|---|
| Validación de marcaje | Cada motivo de rechazo, cada frontera de ventana horaria, zona horaria distinta a la del servidor | [09](./09-marcaje-asistencia.md) |
| Geocerca | Dentro/fuera por 1 m, umbral de precisión, recálculo en servidor ignorando lo que envía el cliente | [08](./08-sedes-y-geocerca.md) |
| Tardanza | Tolerancia global vs. por fecha, minuto exacto de frontera | [07](./07-horarios-y-calendario.md) |
| Estado diario | Cada rama del orden de precedencia | [15](./15-paneles-y-dashboard.md) §2 |
| Vacaciones | Saldo, solapamiento, concurrencia de dos solicitudes | [11](./11-vacaciones.md) |
| Descansos | Vigencia por fecha, precedencia grupos/individual | [10](./10-descansos.md) |
| Nómina | Creación, reversión, idempotencia, empleado sin sueldo | [17](./17-nomina.md) |
| Autorización | **Un test por endpoint con ámbito**, verificando el 403 | [03](./03-roles-y-autorizacion.md) |
| Reportería | Totales que cuadran, XLSX ≡ Sheets, recálculo estable | [16](./16-reporteria-mensual.md) |

> ✅ **Las nueve filas están cubiertas**, y aquí está dónde, porque una lista de deberes sin la
> prueba al lado se convierte en una lista de buenas intenciones:
>
> | Área | Dónde |
> |---|---|
> | Validación de marcaje | `services/attendance-rules.test.ts` (pura) + `routes/attendance.test.ts` |
> | Geocerca | `services/location-rules.test.ts` (pura) + `routes/locations.test.ts` |
> | Tardanza | `services/schedule-rules.test.ts` (pura) |
> | Estado diario | `services/daily-status.test.ts` (pura, cada rama de precedencia) |
> | Vacaciones | `services/vacation-rules.test.ts` + `routes/vacations.test.ts` (incluida la concurrencia) |
> | Descansos | `services/rest-rules.test.ts` + `routes/rest.test.ts` |
> | Nómina | `routes/payroll.test.ts` + la cadena de `routes/absences.test.ts` |
> | Autorización | los 403 de cada router: `users` 13, `departments` 10, `reports` 10, `rest` 8, `vacations` 8, `absences` 7, `incidents` 7, `schedules` 7, `dashboard` 5, `locations` 5, `config` 3, y los recorridos completos de `payroll`, `admin` y `audit` |
> | Reportería | `services/report-rules.test.ts` (XLSX ≡ matriz, celda a celda) + `routes/reports.test.ts` |
>
> Dos ausencias que **no** son huecos: `attendance` y `notifications` no tienen 403 porque no
> tienen ámbito que comprobar —cualquiera autenticado marca y cualquiera lee lo suyo—, y lo que
> ahí hay que probar es el **aislamiento**, que se prueba con 404 y con listados ajenos.

- **RQ-22.2** — Las funciones de dominio son **puras** y reciben el contexto ya cargado. Es lo
  que hace posible probarlas sin base de datos.
  > ✅ Se ve en la propia tabla: seis de las nueve áreas se prueban **sin base de datos**, en un
  > archivo `*-rules.test.ts`. Es el reparto que la spec buscaba — la regla se prueba pura y la
  > integración prueba que se llamó con los datos correctos.
- **RQ-22.3** — Las pruebas de autorización usan usuarios reales de cada rol contra los
  endpoints, no dobles de prueba de la función de permisos.
  > ✅ Y no por ceremonia: es lo que atrapó el fallo de RN-05.7 —el aside filtrando por su cuenta
  > en vez de con `canAccess`— y lo que hace que la barrera de nómina de RN-13.5 signifique algo.
  > Una prueba contra un doble de la función de permisos habría pasado con el aside roto.

## 4. Contrato compartido de reportería (punto 73)

Ya cubierto como requisito en [16-reporteria-mensual](./16-reporteria-mensual.md) §7.2:
la matriz se construye una vez, ambos formatos la serializan, un test compara las salidas.
Se repite aquí porque en el legacy es un fallo silencioso y caro.

## 5. Rendimiento

- **Code splitting (punto 72).** El bundle principal del legacy superaba 1,8 MB minificado,
  sin división por rutas. En TanStack Start la división por ruta es el comportamiento
  esperado; verificarlo, no darlo por hecho.
  **RQ-22.4** — Presupuesto de tamaño verificado en CI.
  > ✅ `scripts/check-bundle.ts`. **Medido: 1.403 KB de JavaScript de cliente en 100 trozos**, el
  > mayor de 296 KB. La división por ruta funciona.
  >
  > Son **tres** comprobaciones y no una, porque el total no detecta lo que de verdad se quiere
  > evitar: un `import` mal puesto que arrastre medio proyecto al trozo de entrada cambia poco el
  > total y hunde el reparto. Así que además del total hay un máximo por trozo y un **mínimo de
  > trozos** — si algún día hay menos de veinte, la división dejó de funcionar.
  >
  > Se mide **sin comprimir** a propósito: es el número que no depende de la versión de gzip del
  > servidor ni de su configuración, así que compara igual hoy y dentro de un año.
- **Consultas.** Prohibido el N+1 en los paneles ([15](./15-paneles-y-dashboard.md) §4).
  **RQ-22.5** — Test de conteo de consultas en los endpoints de panel y reporte.
  > ✅ **Los dos, y el del reporte faltaba.** El del panel llegó con la spec 15 —"un panel de 203
  > personas hace las mismas 11 consultas que uno de 5"— y el del reporte se escribió aquí, que
  > es el que más lo necesitaba: la matriz mensual es empleado × día, así que una consulta por
  > persona no se nota con cinco y tumba el servidor con doscientas.
  >
  > ⚠️ **Y enseñó algo que el del panel no podía enseñar: el reporte sí crece.** Medido, **34
  > consultas con 5 personas y 45 con 205**. Los once de diferencia no son un N+1: son el
  > `insert` de los hechos diarios materializados, que va en **trozos de 500 filas** porque uno
  > de decenas de miles supera el límite de parámetros del protocolo de PostgreSQL. 205 personas
  > × 31 días son 6.355 filas, o trece trozos.
  >
  > Así que la prueba no afirma que el número sea el mismo —lo sería sólo si se ignorara el
  > límite del protocolo— sino que **el crecimiento sea muchísimo menor que el de la plantilla**.
  > Con un N+1 de lectura, la cifra pasaría de 230.
  >
  > El contador vive en `src/test-support/count-queries.ts`, compartido por las dos pruebas: dos
  > copias del mecanismo y una de las dos acabaría midiendo mal y tranquilizando.
- **Particionamiento de marcajes (punto 78).** Condicional: sólo al superar >10 M filas o p95
  sostenido > 2 s. **No hacerlo antes de medirlo.**
  > **No toca, y ahora hay con qué justificarlo.** Los KPIs de la
  > [16](./16-reporteria-mensual.md) §6 miden el p95 de las corridas de reporte contra su SLO, y
  > la prueba de conteo de arriba acota las consultas. Mientras esas dos cifras estén dentro,
  > particionar sería añadir complejidad de esquema para un problema que nadie ha visto.
- **Pruebas de carga (punto 79).** Existe una guía heredada sin evidencia de ejecución.
  Ejecutarlas sobre la reportería antes de producción.
  > ⚠️ **Sigue pendiente, y es la deuda viva de esta spec.** No es algo que se pueda cerrar
  > escribiendo código: necesita un entorno parecido al de producción y datos del volumen real
  > —la plantilla entera, un año de marcajes—, y ese entorno es la decisión 3 de la §9. Lo que sí
  > está preparado es de dónde saldrían esos datos: la importación de histórico de la
  > [19](./19-panel-superadmin.md) §2.4.

## 6. Accesibilidad y usabilidad (punto 74)

El legacy tiene una auditoría de usabilidad con un plan P0–P2 **sin confirmación de haberse
ejecutado**. Mínimos para el sistema nuevo:

- Contraste suficiente y objetivos táctiles grandes en el shell de empleado — se usa con
  guantes, a contraluz, en planta.
- Navegación por teclado completa en el backoffice.
- Etiquetas y textos alternativos en los controles del marcaje.
- Mensajes de error accionables, en español, que digan qué hacer
  ([05](./05-shells-y-navegacion.md) RN-05.10).

> **Dos de los cuatro se cumplen por construcción, y conviene distinguirlos de los otros dos.**
>
> - **Objetivos táctiles**: la barra inferior del EmployeeShell tiene destinos de 56 px con
>   etiqueta debajo del icono, y el botón de marcaje es el elemento más grande de su pantalla
>   ([05](./05-shells-y-navegacion.md) §3). Se decidió pensando en guantes y prisa, no en una
>   auditoría.
> - **Mensajes en español y accionables**: RN-05.10 con `friendlyError` y **un solo**
>   `InlineError`. Hay una prueba de que ningún mensaje del proveedor de datos llega en inglés.
>
> ⚠️ Los otros dos **no están verificados y no se van a dar por buenos**: el contraste no se ha
> medido con una herramienta, y la navegación por teclado del backoffice funciona porque los
> componentes de shadcn la traen, no porque nadie la haya recorrido entera. Es la auditoría del
> punto 74, y sigue abierta igual que en el legacy — con la diferencia de que aquí está dicho.

## 7. Deuda heredada, resuelta o pendiente

| # legacy | Deuda | Dónde se resuelve |
|---|---|---|
| 69 | Sin CI/CD | §2 — ✅ **resuelto**, salvo la protección de rama |
| 70 | Deriva de esquema | [21](./21-migracion-desde-legacy.md) §8 |
| 71 | Sin pruebas de lógica crítica | §3 — ✅ **resuelto**: las nueve áreas, verificadas fila por fila |
| 72 | Sin code splitting | §5 — ✅ **resuelto y medido**: 100 trozos, el mayor de 296 KB |
| 73 | Reportería duplicada | [16](./16-reporteria-mensual.md) §7.2 |
| 74 | Auditoría de usabilidad sin cerrar | §6 — ⚠️ **parcial**: táctil y mensajes sí, contraste y teclado sin verificar |
| 75 | Divisor de nómina fijo | [17](./17-nomina.md) RN-17.3 |
| 76 | Nómina fuera de reportes, auditoría y avisos | [17](./17-nomina.md) RN-17.9/10/11 |
| 77 | Geolocalización en segundo plano | [08](./08-sedes-y-geocerca.md) §4 — **fuera del alcance**: exige cliente nativo |
| 78 | Particionamiento | §5 |
| 79 | Pruebas de carga | §5 — ⚠️ **pendiente**: necesita un entorno como el de producción |
| 80 | Residuos y limpieza | [21](./21-migracion-desde-legacy.md) §7 |
| H-1 | Argumentos invertidos en comprobación de ámbito | [03](./03-roles-y-autorizacion.md) §5 |
| H-2 | Base de datos compartida con otro sistema | [21](./21-migracion-desde-legacy.md) §3 |
| H-3 | Salario sin barrera de columna | [02](./02-usuarios-y-perfiles.md) §6 |
| H-4 | Regla de negocio dentro de un contexto de React | [10](./10-descansos.md) §5, [14](./14-notificaciones.md) §5 |

## 8. Principios de arquitectura derivados

Cinco reglas que salen directamente de los errores del legacy:

1. **Una regla, una implementación.** Si una regla existe en dos lugares, se desincronizan.
2. **El dominio es puro.** Las reglas no tocan base de datos ni HTTP; reciben datos y
   devuelven decisiones.
3. **El servidor no confía en el cliente.** Distancias, horas y roles se recalculan siempre.
4. **Lo que mueve dinero se audita y se notifica.** Sin excepciones.
5. **Nada llega a producción sin pasar por el repositorio.** Ni esquema, ni configuración, ni
   parches.

## 9. Decisiones abiertas

1. ~~¿Qué plataforma de CI?~~ **Cerrada: GitHub Actions.** El repositorio ya vive en GitHub y
   `gh` es la herramienta que se usa; otra plataforma sería una cuenta más, un secreto más y un
   sitio más donde mirar cuando algo falla.
2. ~~¿Se exige cobertura mínima numérica, o basta la lista de §3?~~ **Cerrada: basta la lista, y
   no se pone porcentaje.** Un umbral global premia probar lo que es fácil de probar —los
   formateadores, los mapeos de etiquetas— y no dice nada de si la geocerca está cubierta. Esta
   spec ya eligió el criterio mejor en su §3: **nombrar las nueve áreas que faltaban**, que son
   las que mueven dinero y afectan al empleo de personas. La regla operativa que sí se sostiene:
   *una regla de dominio nueva llega con su prueba, y la tabla de la §3 se actualiza con ella.*
   Quien quiera el número, `bun test --coverage` lo imprime.
3. **⚠️ Sigue abierta — ¿entornos de staging y producción separados?** Y bloquea las pruebas de
   carga de la §5, que necesitan un sitio donde poder tumbar el sistema sin tumbarlo. Es una
   decisión con coste de infraestructura detrás, y la empresa opera en Cuba
   ([06](./06-configuracion-global.md) §8), donde eso no se resuelve con una tarjeta de crédito.
4. **⚠️ Sigue abierta — ¿seguimiento de errores en producción?** Hoy hay lo que hay: `console.error`
   y los logs del contenedor, más la bitácora de la [18](./18-auditoria.md) para lo que sí es una
   acción de alguien. Un servicio como Sentry exige salida a internet desde el servidor y un
   tercero al que se le manda información del sistema; ninguna de las dos cosas se decide desde
   el código.
