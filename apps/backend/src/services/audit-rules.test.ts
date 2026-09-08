import { describe, expect, test } from "bun:test";
import {
	AUDIT_ACTION_LABELS,
	AUDIT_ACTIONS,
	AUDIT_DOMAIN_LABELS,
	auditActionLabel,
	auditDiff,
	auditDomainOf,
	decodeKeysetCursor,
	encodeKeysetCursor,
} from "@elineas/validations";

/**
 * Pruebas puras de la bitácora (spec 18): la diferencia campo a campo de la §7,
 * el cursor de la §6 y el catálogo de la §3.
 *
 * Nada de esto necesita la base: son funciones con casos de borde —el alta sin
 * estado anterior, el valor que no es un objeto, el cursor con un `|` dentro—
 * que se prueban mejor solas. Lo que sí necesita base está en
 * `routes/audit.test.ts`.
 */

describe("§7 — la diferencia visual", () => {
	test("sólo lista los campos que cambiaron", () => {
		const changes = auditDiff(
			{ isJustified: false, notes: null },
			{ isJustified: true, notes: null },
		);

		expect(changes).toEqual([
			{ field: "isJustified", before: false, after: true },
		]);
	});

	test("un alta no tiene estado anterior y aun así se lee", () => {
		// Es la mitad de las entradas: `department.created` y compañía sólo traen
		// `new_data`. Enseñar "nada → valor" es exactamente lo que hace falta.
		expect(auditDiff(null, { name: "Producción" })).toEqual([
			{ field: "name", before: null, after: "Producción" },
		]);
	});

	test("una baja tampoco tiene estado nuevo", () => {
		expect(auditDiff({ name: "Producción" }, null)).toEqual([
			{ field: "name", before: "Producción", after: null },
		]);
	});

	test("compara valores anidados por su forma serializada", () => {
		// `rest_group.members_changed` guarda listas. Comparar por identidad diría
		// que dos listas iguales son distintas, y la pantalla enseñaría un cambio
		// que no existió.
		expect(auditDiff({ ids: ["a", "b"] }, { ids: ["a", "b"] })).toEqual([]);
		expect(auditDiff({ ids: ["a"] }, { ids: ["a", "b"] })).toHaveLength(1);
	});

	test("un valor que no es objeto se lee como un solo cambio sin nombre", () => {
		expect(auditDiff("antes", "después")).toEqual([
			{ field: "", before: "antes", after: "después" },
		]);
	});

	test("dos nulos no son un cambio", () => {
		expect(auditDiff(null, null)).toEqual([]);
	});

	test("un campo que aparece por primera vez cuenta como cambio", () => {
		expect(auditDiff({ a: 1 }, { a: 1, b: 2 })).toEqual([
			{ field: "b", before: null, after: 2 },
		]);
	});
});

describe("§6 — el cursor (compartido con la spec 14)", () => {
	const entry = {
		createdAt: "2026-03-17T14:05:09.123Z",
		id: "3f1c9a2e-5b7d-4e8f-9a1b-2c3d4e5f6a7b",
	};

	test("ida y vuelta", () => {
		expect(decodeKeysetCursor(encodeKeysetCursor(entry))).toEqual(entry);
	});

	test("se parte por el último separador, no por el primero", () => {
		// Defensivo a propósito: si algún día el cursor llevara algo con un `|`
		// dentro, partir por el primero devolvería un id truncado y la página
		// siguiente empezaría en otro sitio sin fallar.
		expect(decodeKeysetCursor("2026-03-17T14:05:09.123Z|extra|abc")).toEqual({
			createdAt: "2026-03-17T14:05:09.123Z|extra",
			id: "abc",
		});
	});

	test("una cadena sin separador no es un cursor", () => {
		expect(decodeKeysetCursor("2026-03-17")).toBeNull();
	});
});

describe("§3 — el catálogo", () => {
	/**
	 * **El criterio de aceptación que el legacy no podía cumplir.** Su bitácora se
	 * escribía desde los puntos de uso y lo que nadie recordó instrumentar no se
	 * auditó (§5). Aquí el enum obliga a pasar por el catálogo para escribir, y
	 * esta prueba cierra el otro lado: que ninguna acción del catálogo esté
	 * declarada y sin emitir. Una entrada muerta es una promesa de rastro que
	 * nadie está dejando.
	 */
	test("cada acción declarada se emite en algún servicio o ruta", async () => {
		const { Glob } = await import("bun");
		const root = `${import.meta.dir}/..`;

		const sources = await Promise.all(
			[
				...new Glob("services/*.ts").scanSync({ cwd: root }),
				...new Glob("routes/*.ts").scanSync({ cwd: root }),
			]
				.filter((file) => !file.endsWith(".test.ts"))
				.map((file) => Bun.file(`${root}/${file}`).text()),
		);
		const code = sources.join("\n");

		const dead = AUDIT_ACTIONS.filter(
			(action) => !code.includes(`"${action}"`),
		);
		expect(dead).toEqual([]);
	});

	test("toda acción tiene etiqueta en español y dominio con nombre", () => {
		// Sin esto, añadir una acción al catálogo enseñaría
		// `rest_group.members_changed` a una persona en la pantalla de la §7.
		for (const action of AUDIT_ACTIONS) {
			expect(AUDIT_ACTION_LABELS[action]).toBeTruthy();
			expect(AUDIT_DOMAIN_LABELS[auditDomainOf(action)]).toBeTruthy();
		}
	});

	test("una acción desconocida se rotula con su valor crudo", () => {
		// RN-18.6: una fila escrita por una versión anterior sigue ahí. La pantalla
		// la enseña sin nombre bonito, pero la enseña.
		expect(auditActionLabel("algo.viejo")).toBe("algo.viejo");
		expect(auditActionLabel("config.updated")).toBe("Configuración modificada");
	});
});
