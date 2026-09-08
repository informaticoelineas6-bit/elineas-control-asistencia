# 22 · Calidad, pruebas y deuda técnica

> **Origen:** `old-docs.md` Fase 15 (puntos 69–80) y Parte 5 (hallazgos H-1 a H-4).
> **Estado:** ❌ nada de esto existía en el legacy. Es la oportunidad de no repetirlo.

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

- **RQ-22.2** — Las funciones de dominio son **puras** y reciben el contexto ya cargado. Es lo
  que hace posible probarlas sin base de datos.
- **RQ-22.3** — Las pruebas de autorización usan usuarios reales de cada rol contra los
  endpoints, no dobles de prueba de la función de permisos.

## 4. Contrato compartido de reportería (punto 73)

Ya cubierto como requisito en [16-reporteria-mensual](./16-reporteria-mensual.md) §7.2:
la matriz se construye una vez, ambos formatos la serializan, un test compara las salidas.
Se repite aquí porque en el legacy es un fallo silencioso y caro.

## 5. Rendimiento

- **Code splitting (punto 72).** El bundle principal del legacy superaba 1,8 MB minificado,
  sin división por rutas. En TanStack Start la división por ruta es el comportamiento
  esperado; verificarlo, no darlo por hecho.
  **RQ-22.4** — Presupuesto de tamaño verificado en CI.
- **Consultas.** Prohibido el N+1 en los paneles ([15](./15-paneles-y-dashboard.md) §4).
  **RQ-22.5** — Test de conteo de consultas en los endpoints de panel y reporte.
- **Particionamiento de marcajes (punto 78).** Condicional: sólo al superar >10 M filas o p95
  sostenido > 2 s. **No hacerlo antes de medirlo.**
- **Pruebas de carga (punto 79).** Existe una guía heredada sin evidencia de ejecución.
  Ejecutarlas sobre la reportería antes de producción.

## 6. Accesibilidad y usabilidad (punto 74)

El legacy tiene una auditoría de usabilidad con un plan P0–P2 **sin confirmación de haberse
ejecutado**. Mínimos para el sistema nuevo:

- Contraste suficiente y objetivos táctiles grandes en el shell de empleado — se usa con
  guantes, a contraluz, en planta.
- Navegación por teclado completa en el backoffice.
- Etiquetas y textos alternativos en los controles del marcaje.
- Mensajes de error accionables, en español, que digan qué hacer
  ([05](./05-shells-y-navegacion.md) RN-05.10).

## 7. Deuda heredada, resuelta o pendiente

| # legacy | Deuda | Dónde se resuelve |
|---|---|---|
| 69 | Sin CI/CD | §2 |
| 70 | Deriva de esquema | [21](./21-migracion-desde-legacy.md) §8 |
| 71 | Sin pruebas de lógica crítica | §3 |
| 72 | Sin code splitting | §5 |
| 73 | Reportería duplicada | [16](./16-reporteria-mensual.md) §7.2 |
| 74 | Auditoría de usabilidad sin cerrar | §6 |
| 75 | Divisor de nómina fijo | [17](./17-nomina.md) RN-17.3 |
| 76 | Nómina fuera de reportes, auditoría y avisos | [17](./17-nomina.md) RN-17.9/10/11 |
| 77 | Geolocalización en segundo plano | [08](./08-sedes-y-geocerca.md) §4 — **fuera del alcance**: exige cliente nativo |
| 78 | Particionamiento | §5 |
| 79 | Pruebas de carga | §5 |
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

1. ¿Qué plataforma de CI? (GitHub Actions, dado que se usa `gh`.)
2. ¿Se exige cobertura mínima numérica, o basta la lista de §3?
3. ¿Entornos de staging y producción separados? El legacy parece tener sólo uno.
4. ¿Se adopta seguimiento de errores en producción? Hoy no hay ninguno.
