import { z } from "zod";
import { payrollAdjustmentEffectSchema } from "./payroll.ts";
import { isoDateSchema } from "./time.ts";

/**
 * Justificación de ausencias (spec 13). El jefe decide si un día ausente está
 * justificado, y esa decisión **mueve dinero**: injustificada crea un descuento,
 * reclasificarla lo revierte (RN-13.4).
 *
 * **No es el flujo de incidencias** ([12](../../specs/12-incidencias.md) §2): esa
 * la inicia el empleado, va sobre un marcaje y no toca la nómina. Aquí la inicia
 * el jefe, va sobre un día completo y sí la toca. Que sean dos cosas distintas
 * es lo que el legacy nunca dejó claro, y de ahí venía su defecto: aprobar
 * "olvidé marcar" no justificaba el día y el descuento se aplicaba igual.
 *
 * Como en las specs 10, 11 y 12, aquí vive el vocabulario y lo que comparten
 * servidor e interfaz. Hay poco que compartir: la única regla que no necesita la
 * base es la asimetría de las notas (RN-13.6). El resto —RN-13.1 sobre todo—
 * depende de la agregación diaria y sólo se puede comprobar en el servidor, que
 * es justo lo que esa regla exige.
 *
 * Decisiones de la §9 que se cierran aquí:
 *
 * 3. **RN-13.10 confirmada: un día ausente sin revisar es ANJ en la
 *    presentación, pero no genera descuento.** La asimetría es deliberada y las
 *    dos mitades tienen el mismo motivo: el descuento mueve dinero y exige que
 *    una persona lo decida; el reporte no debe **esconder** una ausencia que
 *    nadie explicó. Ocultarla hasta que alguien la revise haría que un mes sin
 *    revisar pareciera un mes sin ausencias.
 * 4. **RN-13.6 confirmada tal como está escrita: notas obligatorias al
 *    justificar, opcionales al marcar injustificada.** La spec pedía
 *    confirmarlo contra el legacy y el legacy **no lo documenta** (`old-docs.md`
 *    punto 44 no menciona la obligatoriedad), así que manda el texto de la spec.
 *    Es la asimetría **inversa** a las de las specs 11 y 12, donde el que exige
 *    motivo es el rechazo, y el motivo del cambio es el mismo: se pide la razón
 *    de la decisión **discrecional**. Allí lo discrecional era negar algo a una
 *    persona; aquí es perdonar un descuento.
 *
 * Sigue abierta la **decisión 2** (RN-13.9, reclasificar tras cerrar el periodo)
 * porque depende del cierre de periodo, que es una decisión de la spec 17 que
 * nadie ha tomado; y la **5** (tipos de justificación en vez de un booleano),
 * que cambiaría el reporte de la spec 16. La **1** se cierra en la spec 12.
 */

/**
 * Los dos códigos del reporte (spec 16, y `old-docs.md` punto 62). Son una
 * **superposición** sobre un día `AUSENTE`, no un estado nuevo del vocabulario
 * de la spec 15 — así lo dejaba anotado `attendanceDayStatusSchema`.
 */
export const absenceCodeSchema = z.enum(["AJ", "ANJ"]);

/**
 * La superposición de esta spec sobre un día del historial.
 *
 * Nula cuando el día no es `AUSENTE`, y también cuando la jornada **todavía
 * puede completarse** (`pending`): llamar ANJ a alguien a media mañana sería
 * clasificar una ausencia que aún no ha ocurrido.
 */
export const absenceOverlaySchema = z.object({
	code: absenceCodeSchema,
	/**
	 * `false` = nadie la ha revisado, y entonces `code` es `ANJ` por RN-13.10 —
	 * **sin descuento**. Es el campo que distingue "injustificada porque alguien
	 * lo decidió" de "injustificada porque nadie la miró", que en el reporte se
	 * ven igual y en la nómina no.
	 */
	reviewed: z.boolean(),
	notes: z.string().nullable(),
});

/**
 * `PUT /absences/:userId/:date`.
 *
 * RN-13.6 — Justificar exige notas; marcar injustificada no. Ver la nota de
 * cabecera: la razón se pide para la decisión discrecional, y aquí lo
 * discrecional es perdonar el descuento.
 */
export const reviewAbsenceInputSchema = z
	.object({
		isJustified: z.boolean(),
		notes: z.string().trim().max(1000).optional(),
	})
	.refine((input) => !input.isJustified || !!input.notes, {
		message: "Justificar una ausencia necesita notas que expliquen el motivo.",
		path: ["notes"],
	});

export const absenceReviewSchema = z.object({
	id: z.uuid(),
	userId: z.uuid(),
	/** Resueltos para la bandeja, que busca por persona, correo y departamento. */
	userFullName: z.string(),
	userEmail: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	date: isoDateSchema,
	isJustified: z.boolean(),
	notes: z.string().nullable(),
	reviewedBy: z.uuid(),
	reviewedAt: z.iso.datetime(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

/**
 * Lo que devuelve una revisión: la decisión **y qué pasó con la nómina**.
 *
 * La §6 lo pide explícitamente —"para que la UI lo confirme al jefe antes y
 * después de la acción"— y es la única forma honesta de cerrar el bucle: la
 * escritura de nómina ocurre dentro de esta transacción y con privilegio que
 * quien la dispara no tiene (RN-13.5), así que si el resultado no lo dijera,
 * el jefe no tendría ninguna manera de saber si movió dinero.
 */
export const absenceReviewResultSchema = z.object({
	review: absenceReviewSchema,
	payrollAdjustment: payrollAdjustmentEffectSchema,
});

/**
 * Un día ausente **sin decisión**: la bandeja que la §5 echa en falta en el
 * legacy ("hoy sólo se ven navegando día por día").
 *
 * No lleva importe: el descuento todavía no existe, y anticiparlo sería
 * enseñarle el sueldo al jefe (ver `payrollAdjustmentEffectSchema`).
 */
export const pendingAbsenceSchema = z.object({
	userId: z.uuid(),
	userFullName: z.string(),
	userEmail: z.string(),
	departmentId: z.uuid().nullable(),
	departmentName: z.string().nullable(),
	date: isoDateSchema,
});

/**
 * `GET /absences/pending?from=&to=&departmentId=`.
 *
 * El rango es obligatorio en la práctica y acotado: resolver los días ausentes
 * de un ámbito exige clasificar cada jornada de cada persona (spec 15), así que
 * un rango abierto sería una consulta que crece con la antigüedad de la empresa.
 * Sin `from`/`to`, el servidor usa **los últimos 30 días**, que es la ventana en
 * la que un jefe revisa de verdad.
 */
export const pendingAbsencesQuerySchema = z
	.object({
		from: isoDateSchema.optional(),
		to: isoDateSchema.optional(),
		departmentId: z.uuid().optional(),
	})
	.refine(({ from, to }) => !from || !to || from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	})
	.refine(
		({ from, to }) =>
			!from ||
			!to ||
			(Date.parse(`${to}T00:00:00.000Z`) -
				Date.parse(`${from}T00:00:00.000Z`)) /
				86_400_000 <=
				186,
		{
			message: "El rango de ausencias pendientes no puede pasar de medio año.",
		},
	);

/**
 * `GET /absences?userId=&from=&to=`: las decisiones ya tomadas.
 *
 * `userId` es opcional: sin él devuelve las de todo el ámbito de quien pregunta,
 * que es lo que necesita "¿qué se ha decidido este mes?". El ámbito lo aplica el
 * servidor; este parámetro sólo acota dentro de él.
 */
export const listAbsenceReviewsQuerySchema = z
	.object({
		userId: z.uuid().optional(),
		from: isoDateSchema,
		to: isoDateSchema,
	})
	.refine(({ from, to }) => from <= to, {
		message:
			"El rango de fechas está invertido: «desde» es posterior a «hasta».",
	});

export const pendingAbsencesCountSchema = z.object({
	count: z.number().int().nonnegative(),
});

export type AbsenceCode = z.infer<typeof absenceCodeSchema>;
export type AbsenceOverlay = z.infer<typeof absenceOverlaySchema>;
export type AbsenceReview = z.infer<typeof absenceReviewSchema>;
export type AbsenceReviewResult = z.infer<typeof absenceReviewResultSchema>;
export type ReviewAbsenceInput = z.infer<typeof reviewAbsenceInputSchema>;
export type PendingAbsence = z.infer<typeof pendingAbsenceSchema>;
export type PendingAbsencesQuery = z.infer<typeof pendingAbsencesQuerySchema>;
export type ListAbsenceReviewsQuery = z.infer<
	typeof listAbsenceReviewsQuerySchema
>;
export type PendingAbsencesCount = z.infer<typeof pendingAbsencesCountSchema>;
