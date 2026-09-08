import {
	adminStatsSchema,
	attendanceImportReportSchema,
	attendanceImportResultSchema,
	maintenanceStateSchema,
	setMaintenanceInputSchema,
} from "@elineas/validations";

/**
 * Contrato del panel de superadmin (spec 19 §4).
 *
 * **Todo exige `superadmin`** (RN-19.7), y todo se audita (RN-19.8).
 *
 * ⚠️ **No hay `POST /admin/sql`, y es la decisión más importante de esta spec.**
 * La §6 decisión 1 la llamaba "la decisión de seguridad más importante del
 * proyecto" y ofrecía tres alternativas; se toma la que la propia spec
 * recomienda: **no reimplementarla**.
 *
 * El razonamiento, para que no haya que rehacerlo dentro de un año:
 *
 * - Lo que el legacy tenía era una **lista negra** de `BEGIN`/`COMMIT`/`ROLLBACK`,
 *   y una lista negra sobre texto SQL no se puede arreglar: no impide un `DELETE
 *   FROM profiles`, y esquivarla es cuestión de un comentario, un `DO`, una
 *   función o un salto de línea. Cerrar cada agujero descubre el siguiente.
 * - La alternativa (b), sólo lectura, no es gratis: exige un rol de base de datos
 *   aparte con su credencial propia, y mientras esa credencial no exista, el
 *   endpoint correría como el dueño del esquema. Un endpoint que **parece**
 *   restringido y no lo está es peor que ninguno.
 * - Y la necesidad legítima —una consulta puntual en soporte— **ya está
 *   cubierta**: `bun run db:studio` y el `psql` del contenedor, con credenciales
 *   que viven fuera de la aplicación y no se alcanzan desde un navegador. Es
 *   exactamente la alternativa (a).
 *
 * Con eso, RN-19.9 pierde su caso más peligroso ("SQL de escritura") y el
 * criterio de la §5 sobre la consola queda sin objeto. Hay una prueba que
 * comprueba que el endpoint **no existe**: si algún día se añade, será un acto
 * deliberado y no un descuido.
 */
export const adminSpec = {
	stats: {
		method: "GET",
		path: "/api/admin/stats",
		response: adminStatsSchema,
	},
	maintenance: {
		method: "GET",
		path: "/api/admin/maintenance",
		response: maintenanceStateSchema,
	},
	setMaintenance: {
		method: "PUT",
		path: "/api/admin/maintenance",
		body: setMaintenanceInputSchema,
		response: maintenanceStateSchema,
	},
	/**
	 * RN-19.2 — Devuelve el informe y **no escribe ni una fila**. Recibe el
	 * archivo como `multipart/form-data`, así que no lleva esquema de cuerpo: lo
	 * que se valida es la hoja, no un JSON.
	 */
	validateImport: {
		method: "POST",
		path: "/api/admin/import/attendance/validate",
		response: attendanceImportReportSchema,
	},
	/** Escribe. Reimportar el mismo archivo no duplica nada (RN-19.3). */
	commitImport: {
		method: "POST",
		path: "/api/admin/import/attendance/commit",
		response: attendanceImportResultSchema,
	},
} as const;
