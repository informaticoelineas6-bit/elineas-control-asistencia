import { describe, expect, test } from "bun:test";
import {
	isAdministrativeRole,
	parseShellOverride,
	resolveShell,
} from "./resolve.ts";

/**
 * La regla de resolución de shell (spec 05 §2).
 *
 * **Es la primera prueba del frontend del repositorio**, y existe porque esta
 * regla tiene cuatro casos y un override que los pisa: escrita en un componente
 * habría que abrir un navegador y redimensionar una ventana para saber si sigue
 * bien. Como función pura, cabe en un archivo.
 */

describe("§2 — la regla", () => {
	test("un empleado en móvil ve el shell de empleado", () => {
		expect(resolveShell({ role: "employee", isMobile: true })).toBe("employee");
	});

	test("el mismo empleado en escritorio ve el de admin", () => {
		expect(resolveShell({ role: "employee", isMobile: false })).toBe("admin");
	});

	test("un jefe de departamento en móvil ve el de empleado: también marca", () => {
		// Es explícito en la spec: `department_head` **no** es administrativo a
		// estos efectos.
		expect(resolveShell({ role: "department_head", isMobile: true })).toBe(
			"employee",
		);
		expect(resolveShell({ role: "department_head", isMobile: false })).toBe(
			"admin",
		);
	});

	test("un rol administrativo ve el de admin también en móvil", () => {
		for (const role of ["global_manager", "superadmin"] as const) {
			expect(resolveShell({ role, isMobile: true })).toBe("admin");
		}
	});

	test("sin rol resuelto todavía, el de admin", () => {
		expect(resolveShell({ role: null, isMobile: true })).toBe("admin");
		expect(resolveShell({ role: undefined, isMobile: true })).toBe("admin");
	});
});

describe("RN-05.2 — el override", () => {
	test("manda sobre el viewport y sobre el rol", () => {
		expect(
			resolveShell({
				role: "superadmin",
				isMobile: false,
				override: "employee",
			}),
		).toBe("employee");
		expect(
			resolveShell({ role: "employee", isMobile: true, override: "admin" }),
		).toBe("admin");
	});

	test("`auto` devuelve el comportamiento normal, no un shell", () => {
		// Sin este tercer valor, quien fuerza un shell en una pestaña no puede
		// volver atrás sin cerrarla.
		expect(
			resolveShell({ role: "employee", isMobile: true, override: "auto" }),
		).toBe("employee");
		expect(
			resolveShell({ role: "employee", isMobile: false, override: "auto" }),
		).toBe("admin");
	});

	test("sólo se aceptan los tres valores conocidos", () => {
		expect(parseShellOverride("employee")).toBe("employee");
		expect(parseShellOverride("admin")).toBe("admin");
		expect(parseShellOverride("auto")).toBe("auto");
		expect(parseShellOverride("ADMIN")).toBeNull();
		expect(parseShellOverride("otro")).toBeNull();
		expect(parseShellOverride(null)).toBeNull();
		expect(parseShellOverride(undefined)).toBeNull();
	});
});

describe("quién es administrativo", () => {
	test("el gestor global y el superadmin, y nadie más", () => {
		expect(isAdministrativeRole("global_manager")).toBe(true);
		expect(isAdministrativeRole("superadmin")).toBe(true);
		expect(isAdministrativeRole("department_head")).toBe(false);
		expect(isAdministrativeRole("employee")).toBe(false);
	});
});
