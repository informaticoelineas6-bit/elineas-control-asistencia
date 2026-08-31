import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type AppRole, appRoleSchema } from "@elineas/validations";
import { eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de sedes y geocerca (spec 08 §8).
 *
 * De integración, por lo mismo que las demás: con la RLS fuera (RN-00.1) el handler
 * de Hono es la única barrera, así que sólo se sustituye el Identity Server. Las
 * cuentas de distancia tienen su propio archivo unitario
 * (`services/location-rules.test.ts`); aquí se prueba lo que sólo se puede probar
 * con la base delante: roles, persistencia de la selección, la limpieza al
 * desactivar, sus avisos y la bitácora.
 */

mock.module("#/lib/identity", () => ({
	IdentityError: class IdentityError extends Error {},
	signIn: async () => {
		throw new Error("signIn no se usa en estas pruebas");
	},
	signOut: async () => {},
	refreshJwt: async () => null,
	verifyJwt: async (token: string) => {
		const [, identityUserId] = token.split("|");
		if (!identityUserId) return null;
		return {
			identityUserId,
			email: `${identityUserId}@test.local`,
			name: identityUserId,
		};
	},
	fetchRoles: async (sessionToken: string): Promise<AppRole[]> => {
		const [, , roles] = sessionToken.split("|");
		return (roles ?? "")
			.split(",")
			.filter(Boolean)
			.map((role) => appRoleSchema.parse(role));
	},
}));

const { createApp } = await import("#/app.ts");
const { db } = await import("#/db");
const { auditLog, notifications, profiles, workLocations } = await import(
	"#/db/schema"
);

const app = createApp();
const TAG = `zz-loc-${crypto.randomUUID().slice(0, 8)}`;

/** Grados de latitud que equivalen a un metro. */
const DEGREES_PER_METER = 1 / 111_194.9;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const employee = testUser("employee", ["employee"]);
const other = testUser("other", ["employee"]);
const head = testUser("head", ["department_head"]);
const manager = testUser("manager", ["global_manager"]);

function request(
	path: string,
	options: { as?: TestUser; method?: string; body?: unknown } = {},
) {
	const headers: Record<string, string> = {};
	if (options.as) headers.Cookie = options.as.cookie;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	return app.request(path, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
}

const name = (suffix: string) => `${TAG} ${suffix}`;

type Location = {
	id: string;
	name: string;
	centerLat: number;
	centerLng: number;
	radiusMeters: number;
	accuracyThreshold: number;
	blockOnPoorAccuracy: boolean;
	isActive: boolean;
};

const baseInput = {
	centerLat: 23.1136,
	centerLng: -82.3666,
	radiusMeters: 100,
	accuracyThreshold: 50,
};

async function createLocation(
	suffix: string,
	over: Record<string, unknown> = {},
): Promise<Location> {
	const res = await request("/api/work-locations", {
		as: manager,
		method: "POST",
		body: { name: name(suffix), ...baseInput, ...over },
	});
	expect(res.status).toBe(201);
	return (await res.json()) as Location;
}

/** Una lectura a N metros al norte del centro de la sede. */
const positionNorth = (location: Location, meters: number, accuracy = 10) => ({
	latitude: location.centerLat + meters * DEGREES_PER_METER,
	longitude: location.centerLng,
	accuracy,
});

async function profileIdOf(who: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, who.identityUserId),
	});
	if (!row) throw new Error(`El perfil de ${who.identityUserId} no existe`);
	return row.id;
}

beforeAll(async () => {
	for (const who of [employee, other, head, manager]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}
});

afterAll(async () => {
	const testProfileIds = (
		await db
			.select({ id: profiles.id })
			.from(profiles)
			.where(like(profiles.identityUserId, `${TAG}%`))
	).map((row) => row.id);

	const testLocationIds = (
		await db
			.select({ id: workLocations.id })
			.from(workLocations)
			.where(like(workLocations.name, `${TAG}%`))
	).map((row) => row.id);

	if (testLocationIds.length > 0) {
		// La clave ajena es `on delete set null`, pero se limpia explícitamente: si
		// algún perfil real quedó apuntando a una sede de prueba, no debe arrastrar
		// una selección fantasma.
		await db
			.update(profiles)
			.set({ selectedWorkLocationId: null })
			.where(inArray(profiles.selectedWorkLocationId, testLocationIds));
		await db
			.delete(auditLog)
			.where(inArray(auditLog.recordId, testLocationIds));
	}
	if (testProfileIds.length > 0) {
		await db
			.delete(notifications)
			.where(inArray(notifications.userId, testProfileIds));
		await db.delete(auditLog).where(inArray(auditLog.actorId, testProfileIds));
		await db.delete(profiles).where(inArray(profiles.id, testProfileIds));
	}
	await db.delete(workLocations).where(like(workLocations.name, `${TAG}%`));
});

describe("autorización (spec 08 §7)", () => {
	test("sin sesión no se lee ni se escribe nada", async () => {
		expect((await request("/api/work-locations")).status).toBe(401);
		expect((await request("/api/me/work-location")).status).toBe(401);
		expect(
			(
				await request("/api/me/location-check", {
					method: "POST",
					body: { latitude: 23, longitude: -82, accuracy: 10 },
				})
			).status,
		).toBe(401);
	});

	test("cualquier autenticado ve las sedes activas", async () => {
		await createLocation("visible");
		const res = await request("/api/work-locations", { as: employee });

		expect(res.status).toBe(200);
		const body = (await res.json()) as Location[];
		expect(body.every((each) => each.isActive)).toBe(true);
	});

	test("la lista completa es sólo de gestor global", async () => {
		expect(
			(
				await request("/api/work-locations?includeInactive=true", {
					as: employee,
				})
			).status,
		).toBe(403);
		expect(
			(await request("/api/work-locations?includeInactive=true", { as: head }))
				.status,
		).toBe(403);
		expect(
			(
				await request("/api/work-locations?includeInactive=true", {
					as: manager,
				})
			).status,
		).toBe(200);
	});

	test("un empleado o un jefe no crean, editan ni desactivan sedes", async () => {
		const sede = await createLocation("ajena a un jefe");

		for (const who of [employee, head]) {
			expect(
				(
					await request("/api/work-locations", {
						as: who,
						method: "POST",
						body: { name: name("intento"), ...baseInput },
					})
				).status,
			).toBe(403);
			expect(
				(
					await request(`/api/work-locations/${sede.id}`, {
						as: who,
						method: "PATCH",
						body: { radiusMeters: 500 },
					})
				).status,
			).toBe(403);
			expect(
				(
					await request(`/api/work-locations/${sede.id}/deactivate`, {
						as: who,
						method: "POST",
					})
				).status,
			).toBe(403);
		}
	});
});

describe("alta y edición", () => {
	test("se crea con lo que se manda y se puede releer", async () => {
		const sede = await createLocation("alta completa", {
			radiusMeters: 250,
			accuracyThreshold: 80,
			blockOnPoorAccuracy: true,
		});

		expect(sede.radiusMeters).toBe(250);
		expect(sede.accuracyThreshold).toBe(80);
		expect(sede.blockOnPoorAccuracy).toBe(true);
		expect(sede.isActive).toBe(true);

		const list = (await (
			await request("/api/work-locations", { as: manager })
		).json()) as Location[];
		expect(list.some((each) => each.id === sede.id)).toBe(true);
	});

	test("por defecto la mala precisión advierte, no bloquea", async () => {
		const sede = await createLocation("sin bloqueo por defecto");
		expect(sede.blockOnPoorAccuracy).toBe(false);
	});

	test("el nombre repetido se rechaza sin distinguir mayúsculas", async () => {
		await createLocation("Duplicada");
		const res = await request("/api/work-locations", {
			as: manager,
			method: "POST",
			body: { name: name("duplicada").toUpperCase(), ...baseInput },
		});

		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain(
			"Ya existe una sede",
		);
	});

	test("los valores imposibles los para el esquema", async () => {
		const cases = [
			{ name: name("mala 1"), ...baseInput, centerLat: 91 },
			{ name: name("mala 2"), ...baseInput, centerLng: -181 },
			{ name: name("mala 3"), ...baseInput, radiusMeters: 5 },
			{ name: name("mala 4"), ...baseInput, radiusMeters: 20_001 },
			{ name: name("mala 5"), ...baseInput, accuracyThreshold: 4 },
			{ name: "", ...baseInput },
		];

		for (const body of cases) {
			const res = await request("/api/work-locations", {
				as: manager,
				method: "POST",
				body,
			});
			expect(res.status).toBe(400);
		}
	});

	test("editar mueve el centro y deja el antes y el después en la bitácora", async () => {
		const sede = await createLocation("editable");
		const actorId = await profileIdOf(manager);

		const res = await request(`/api/work-locations/${sede.id}`, {
			as: manager,
			method: "PATCH",
			body: { centerLat: 23.2, radiusMeters: 400 },
		});
		expect(res.status).toBe(200);

		const updated = (await res.json()) as Location;
		expect(updated.centerLat).toBe(23.2);
		expect(updated.radiusMeters).toBe(400);

		const entry = (
			await db.select().from(auditLog).where(eq(auditLog.recordId, sede.id))
		).find((row) => row.action === "work_location.updated");

		expect(entry?.actorId).toBe(actorId);
		expect(entry?.oldData).toMatchObject({ radiusMeters: 100 });
		expect(entry?.newData).toMatchObject({ radiusMeters: 400 });
	});

	test("un parche que no menciona el bloqueo no lo apaga", async () => {
		// Regresión: el esquema de parche se construía con `.partial()` sobre el de
		// alta, y el default de `blockOnPoorAccuracy` sobrevivía a esa transformación.
		// Cambiar el radio de una sede estricta la volvía permisiva sin decirlo.
		const sede = await createLocation("estricta que sigue estricta", {
			blockOnPoorAccuracy: true,
		});

		const res = await request(`/api/work-locations/${sede.id}`, {
			as: manager,
			method: "PATCH",
			body: { radiusMeters: 300 },
		});

		const updated = (await res.json()) as Location;
		expect(updated.radiusMeters).toBe(300);
		expect(updated.blockOnPoorAccuracy).toBe(true);
	});

	test("un parche vacío no se acepta", async () => {
		const sede = await createLocation("parche vacío");
		expect(
			(
				await request(`/api/work-locations/${sede.id}`, {
					as: manager,
					method: "PATCH",
					body: {},
				})
			).status,
		).toBe(400);
	});

	test("una sede que no existe responde 404", async () => {
		expect(
			(
				await request(`/api/work-locations/${crypto.randomUUID()}`, {
					as: manager,
					method: "PATCH",
					body: { radiusMeters: 120 },
				})
			).status,
		).toBe(404);
	});
});

describe("desactivar y reactivar (RN-08.6, RN-08.10)", () => {
	test("desactivar limpia la selección de quien la tenía y se lo notifica", async () => {
		const sede = await createLocation("con gente dentro");
		const profileId = await profileIdOf(employee);

		expect(
			(
				await request("/api/me/work-location", {
					as: employee,
					method: "PUT",
					body: { workLocationId: sede.id },
				})
			).status,
		).toBe(200);

		await db.delete(notifications).where(eq(notifications.userId, profileId));

		const res = await request(`/api/work-locations/${sede.id}/deactivate`, {
			as: manager,
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as Location).isActive).toBe(false);

		// La selección se limpia en el servidor, no esperando a que el cliente lo
		// descubra al llegar a la puerta.
		const mine = (await (
			await request("/api/me/work-location", { as: employee })
		).json()) as { location: Location | null };
		expect(mine.location).toBeNull();

		const avisos = await db
			.select()
			.from(notifications)
			.where(eq(notifications.userId, profileId));
		expect(avisos.length).toBe(1);
		expect(avisos[0]?.type).toBe("work_location.deactivated");
		expect(avisos[0]?.actionUrl).toBe("/profile");

		const entry = (
			await db.select().from(auditLog).where(eq(auditLog.recordId, sede.id))
		).find((row) => row.action === "work_location.deactivated");
		expect(entry?.metadata).toMatchObject({ clearedSelections: 1 });
	});

	test("una sede desactivada sale de la lista de activas, no del catálogo", async () => {
		const sede = await createLocation("apagada");
		await request(`/api/work-locations/${sede.id}/deactivate`, {
			as: manager,
			method: "POST",
		});

		const activas = (await (
			await request("/api/work-locations", { as: employee })
		).json()) as Location[];
		expect(activas.some((each) => each.id === sede.id)).toBe(false);

		const todas = (await (
			await request("/api/work-locations?includeInactive=true", { as: manager })
		).json()) as Location[];
		expect(todas.some((each) => each.id === sede.id)).toBe(true);
	});

	test("no se desactiva dos veces, y se puede volver a activar", async () => {
		const sede = await createLocation("ida y vuelta");

		expect(
			(
				await request(`/api/work-locations/${sede.id}/deactivate`, {
					as: manager,
					method: "POST",
				})
			).status,
		).toBe(200);
		expect(
			(
				await request(`/api/work-locations/${sede.id}/deactivate`, {
					as: manager,
					method: "POST",
				})
			).status,
		).toBe(409);

		const res = await request(`/api/work-locations/${sede.id}/reactivate`, {
			as: manager,
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as Location).isActive).toBe(true);

		expect(
			(
				await request(`/api/work-locations/${sede.id}/reactivate`, {
					as: manager,
					method: "POST",
				})
			).status,
		).toBe(409);
	});
});

describe("la sede de cada persona (RN-08.7, RN-08.8)", () => {
	test("empieza sin sede, y a quien marca se le exige tenerla", async () => {
		const res = await request("/api/me/work-location", { as: other });
		const body = (await res.json()) as {
			location: Location | null;
			required: boolean;
		};

		expect(body.location).toBeNull();
		expect(body.required).toBe(true);
	});

	test("al gestor global no se le exige: no marca (RN-08.7, RN-03.4)", async () => {
		const body = (await (
			await request("/api/me/work-location", { as: manager })
		).json()) as { required: boolean };
		expect(body.required).toBe(false);
	});

	test("elegir sede persiste en el perfil, no en el dispositivo", async () => {
		const sede = await createLocation("elegible");

		const res = await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: sede.id },
		});
		expect(res.status).toBe(200);

		// Otra petición, sin nada guardado en cliente: la selección sigue ahí.
		const mine = (await (
			await request("/api/me/work-location", { as: other })
		).json()) as { location: Location | null };
		expect(mine.location?.id).toBe(sede.id);

		const row = await db.query.profiles.findFirst({
			where: eq(profiles.identityUserId, other.identityUserId),
		});
		expect(row?.selectedWorkLocationId).toBe(sede.id);
	});

	test("la sede de una persona no es la de otra en el mismo terminal", async () => {
		const suya = await createLocation("de uno");
		const mia = await createLocation("de otro");

		await request("/api/me/work-location", {
			as: employee,
			method: "PUT",
			body: { workLocationId: suya.id },
		});
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: mia.id },
		});

		const unoSuyo = (await (
			await request("/api/me/work-location", { as: employee })
		).json()) as { location: Location };
		const otroSuyo = (await (
			await request("/api/me/work-location", { as: other })
		).json()) as { location: Location };

		expect(unoSuyo.location.id).toBe(suya.id);
		expect(otroSuyo.location.id).toBe(mia.id);
	});

	test("no se puede elegir una sede desactivada ni una que no existe", async () => {
		const sede = await createLocation("no elegible");
		await request(`/api/work-locations/${sede.id}/deactivate`, {
			as: manager,
			method: "POST",
		});

		expect(
			(
				await request("/api/me/work-location", {
					as: other,
					method: "PUT",
					body: { workLocationId: sede.id },
				})
			).status,
		).toBe(409);

		expect(
			(
				await request("/api/me/work-location", {
					as: other,
					method: "PUT",
					body: { workLocationId: crypto.randomUUID() },
				})
			).status,
		).toBe(404);
	});

	test("se puede quitar la selección", async () => {
		const sede = await createLocation("quitable");
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: sede.id },
		});

		const res = await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: null },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { location: unknown }).location).toBeNull();
	});
});

describe("veredicto del servidor (spec 08 §6, RN-08.2)", () => {
	async function checkAs(who: TestUser, body: unknown) {
		const res = await request("/api/me/location-check", {
			as: who,
			method: "POST",
			body,
		});
		return {
			status: res.status,
			body: (await res.json()) as Record<string, unknown>,
		};
	}

	test("sin sede elegida, el veredicto lo dice y propone la más cercana", async () => {
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: null },
		});
		const sede = await createLocation("cercana al diagnóstico");

		const { status, body } = await checkAs(other, positionNorth(sede, 5));

		expect(status).toBe(200);
		expect(body.allowed).toBe(false);
		expect(body.reason).toBe("INVALID_LOCATION");
		expect(Array.isArray(body.nearby)).toBe(true);
	});

	test("dentro de su sede: permitido, con la distancia recalculada", async () => {
		const sede = await createLocation("dentro");
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: sede.id },
		});

		const { body } = await checkAs(other, positionNorth(sede, 30));

		expect(body.allowed).toBe(true);
		expect(body.insideGeofence).toBe(true);
		expect(Math.round(body.distanceMeters as number)).toBe(30);
	});

	test("a un metro del borde, rechazado (criterio de aceptación)", async () => {
		const sede = await createLocation("borde");
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: sede.id },
		});

		const { body } = await checkAs(
			other,
			positionNorth(sede, sede.radiusMeters + 1),
		);

		expect(body.allowed).toBe(false);
		expect(body.reason).toBe("OUTSIDE_GEOFENCE");
	});

	test("un cliente que dice estar dentro con coordenadas de fuera es rechazado igual", async () => {
		const sede = await createLocation("mentirosa");
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: sede.id },
		});

		const { body } = await checkAs(other, {
			...positionNorth(sede, 900),
			insideGeofence: true,
			distanceMeters: 0,
		});

		expect(body.allowed).toBe(false);
		expect(body.reason).toBe("OUTSIDE_GEOFENCE");
		expect(Math.round(body.distanceMeters as number)).toBe(900);
	});

	test("mala precisión: bloquea si la sede lo pide, y si no, entra y queda registrada", async () => {
		const estricta = await createLocation("estricta", {
			accuracyThreshold: 20,
			blockOnPoorAccuracy: true,
		});
		await request("/api/me/work-location", {
			as: other,
			method: "PUT",
			body: { workLocationId: estricta.id },
		});

		const bloqueada = await checkAs(other, positionNorth(estricta, 10, 300));
		expect(bloqueada.body.allowed).toBe(false);
		expect(bloqueada.body.reason).toBe("POOR_GPS_ACCURACY");

		await request(`/api/work-locations/${estricta.id}`, {
			as: manager,
			method: "PATCH",
			body: { blockOnPoorAccuracy: false },
		});

		const permitida = await checkAs(other, positionNorth(estricta, 10, 300));
		expect(permitida.body.allowed).toBe(true);
		expect(permitida.body.accuracyOk).toBe(false);
	});

	test("un cuerpo sin coordenadas no se acepta", async () => {
		expect((await checkAs(other, { accuracy: 10 })).status).toBe(400);
		expect(
			(await checkAs(other, { latitude: 23, longitude: -82 })).status,
		).toBe(400);
	});
});
