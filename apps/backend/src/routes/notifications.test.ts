import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import {
	type AppRole,
	appRoleSchema,
	type NotificationPage,
} from "@elineas/validations";
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * Pruebas de notificaciones (spec 14 §9) contra la base de desarrollo.
 *
 * Los cuatro criterios que faltaban por comprobar:
 *
 * - **RN-14.1** — nadie lee ni marca las de otro. Es el criterio más importante
 *   de esta spec y el que no tenía prueba: la API no acepta un `userId`, así que
 *   lo que hay que demostrar es que **el filtro por sesión no se puede eludir**
 *   —ni con el id de una notificación ajena en la mano, ni siendo `superadmin`—.
 * - **RN-14.2** — ningún endpoint crea notificaciones.
 * - **RN-14.4** — el flujo en vivo entrega, **y el sondeo sigue funcionando sin
 *   él**: es lo que la regla exige y lo que hace que una entrega caída no se
 *   note más de treinta segundos.
 * - **RN-14.6** — la purga se lleva las leídas viejas y **no toca las sin leer**.
 *
 * Requiere el Postgres del compose (`docker compose up -d postgres` y
 * `bun run db:migrate`).
 */

mock.module("#/lib/identity", () => ({
	IdentityError: class IdentityError extends Error {},
	signIn: async () => {
		throw new Error("Estas pruebas no pasan por el login.");
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
const { appConfig, notifications, profiles } = await import("#/db/schema");
const { invalidateConfigCache } = await import("#/services/config.ts");
const { notify, purgeReadNotifications } = await import(
	"#/services/notifications.ts"
);

const app = createApp();
const TAG = `zz-not-${crypto.randomUUID().slice(0, 8)}`;

type TestUser = { identityUserId: string; cookie: string };

function testUser(name: string, roles: AppRole[]): TestUser {
	const identityUserId = `${TAG}-${name}`;
	return {
		identityUserId,
		cookie: `ca_session=sess|${identityUserId}|${roles.join(",")}; ca_jwt=jwt|${identityUserId}`,
	};
}

const alice = testUser("alice", ["employee"]);
const bob = testUser("bob", ["employee"]);
/** Ni el rol más alto ve las de otro (RN-14.1). */
const root = testUser("root", ["superadmin"]);

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

let savedConfig: (typeof appConfig.$inferSelect)[] = [];

async function profileIdOf(who: TestUser): Promise<string> {
	const row = await db.query.profiles.findFirst({
		where: eq(profiles.identityUserId, who.identityUserId),
	});
	if (!row) throw new Error(`El perfil de ${who.identityUserId} no existe`);
	return row.id;
}

/** Siembra directa: estas pruebas miran la lectura, no quién las genera. */
async function seed(
	who: TestUser,
	overrides: Partial<typeof notifications.$inferInsert> = {},
) {
	const [row] = await db
		.insert(notifications)
		.values({
			userId: await profileIdOf(who),
			type: "department.paused",
			title: "Aviso de prueba",
			body: "Cuerpo",
			...overrides,
		})
		.returning();
	if (!row) throw new Error("No se pudo sembrar la notificación");
	return row;
}

async function page(
	query = "",
	as: TestUser = alice,
): Promise<NotificationPage> {
	const res = await request(`/api/notifications${query}`, { as });
	expect(res.status).toBe(200);
	return (await res.json()) as NotificationPage;
}

async function unreadCount(as: TestUser): Promise<number> {
	const res = await request("/api/notifications/unread-count", { as });
	expect(res.status).toBe(200);
	return ((await res.json()) as { count: number }).count;
}

async function taggedProfileIds(): Promise<string[]> {
	const rows = await db
		.select({ id: profiles.id })
		.from(profiles)
		.where(like(profiles.identityUserId, `${TAG}%`));
	return rows.map((row) => row.id);
}

async function clearRows() {
	const ids = await taggedProfileIds();
	if (ids.length === 0) return;
	await db.delete(notifications).where(inArray(notifications.userId, ids));
}

beforeAll(async () => {
	savedConfig = await db.select().from(appConfig);
	for (const who of [alice, bob, root]) {
		expect((await request("/api/me/permissions", { as: who })).status).toBe(
			200,
		);
	}
});

afterEach(async () => {
	await clearRows();
	await db.delete(appConfig);
	for (const row of savedConfig) await db.insert(appConfig).values(row);
	invalidateConfigCache();
});

afterAll(async () => {
	const ids = await taggedProfileIds();
	if (ids.length > 0) {
		await clearRows();
		await db.delete(profiles).where(inArray(profiles.id, ids));
	}
});

describe("RN-14.1 — aislamiento", () => {
	test("cada uno ve sólo las suyas, y un superadmin no ve las de nadie más", async () => {
		await seed(alice, { title: "De Alice" });
		await seed(bob, { title: "De Bob" });

		expect((await page()).notifications.map((row) => row.title)).toEqual([
			"De Alice",
		]);
		expect((await page("", bob)).notifications.map((row) => row.title)).toEqual(
			["De Bob"],
		);
		// El rol más alto del sistema tampoco: aquí no hay ámbito, hay dueño.
		expect((await page("", root)).notifications).toHaveLength(0);
	});

	test("marcar la de otro da 404, el mismo que una que no existe", async () => {
		const ajena = await seed(bob);

		const res = await request(`/api/notifications/${ajena.id}/read`, {
			as: alice,
			method: "POST",
		});
		// El mismo 404 que una inexistente: sin diferencia observable no se pueden
		// sondear ids ajenos.
		expect(res.status).toBe(404);
		expect(
			(
				await request(`/api/notifications/${crypto.randomUUID()}/read`, {
					as: alice,
					method: "POST",
				})
			).status,
		).toBe(404);

		// Y sigue sin leer, que es lo que de verdad importa.
		const [after] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, ajena.id));
		expect(after?.readAt).toBeNull();
	});

	test("«marcar todas» no alcanza a las de otro", async () => {
		await seed(alice);
		await seed(bob);

		expect(
			(
				await request("/api/notifications/read-all", {
					as: alice,
					method: "POST",
				})
			).status,
		).toBe(200);

		expect(await unreadCount(alice)).toBe(0);
		expect(await unreadCount(bob)).toBe(1);
	});

	test("sin sesión no se lee nada", async () => {
		expect((await request("/api/notifications")).status).toBe(401);
		expect((await request("/api/notifications/unread-count")).status).toBe(401);
	});
});

describe("RN-14.2 — sólo el servidor las crea", () => {
	test("ningún método de escritura existe en la colección", async () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const res = await request("/api/notifications", {
				as: alice,
				method,
				body: {
					type: "department.paused",
					title: "Inventada",
					body: "Por el cliente",
				},
			});
			expect(`${method} → ${res.status}`).toBe(`${method} → 404`);
		}
	});
});

describe("§5 — las que se actualizan en vez de duplicarse", () => {
	test("dos avisos con la misma clave dejan una fila, y vuelve a estar sin leer", async () => {
		const userId = await profileIdOf(alice);
		const dedupeKey = `${TAG}:semana`;

		await notify(db, [userId], {
			type: "rest_schedule.missing",
			title: "Primero",
			body: "Configura tus descansos",
			dedupeKey,
		});
		await request("/api/notifications/read-all", {
			as: alice,
			method: "POST",
		});
		await notify(db, [userId], {
			type: "rest_schedule.missing",
			title: "Segundo",
			body: "Sigues sin configurarlos",
			dedupeKey,
		});

		const rows = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, userId),
					eq(notifications.dedupeKey, dedupeKey),
				),
			);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.title).toBe("Segundo");
		// Vuelve a contar como pendiente: el recordatorio sigue vigente.
		expect(rows[0]?.readAt).toBeNull();
	});
});

describe("§8 — la vista completa", () => {
	test("filtra por sin leer", async () => {
		await seed(alice, { title: "Leída", readAt: new Date() });
		await seed(alice, { title: "Sin leer" });

		expect((await page()).notifications).toHaveLength(2);
		expect(
			(await page("?unreadOnly=true")).notifications.map((row) => row.title),
		).toEqual(["Sin leer"]);
	});

	test("el cursor recorre las páginas sin repetir ni saltarse nada", async () => {
		for (let index = 0; index < 5; index += 1) {
			await seed(alice, { title: `Aviso ${index}` });
		}

		const all = await page("?limit=100");
		expect(all.notifications).toHaveLength(5);
		expect(all.nextCursor).toBeNull();

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let index = 0; index < 10; index += 1) {
			const current = await page(
				`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			seen.push(...current.notifications.map((row) => row.id));
			cursor = current.nextCursor;
			if (!cursor) break;
		}

		expect(seen).toEqual(all.notifications.map((row) => row.id));
		expect(new Set(seen).size).toBe(5);
	});

	test("un cursor con basura dentro es un 400", async () => {
		expect(
			(await request("/api/notifications?cursor=pura-basura", { as: alice }))
				.status,
		).toBe(400);
	});
});

describe("RN-14.4 — entrega en vivo y su respaldo", () => {
	/** Lee el siguiente evento con datos, con guardia de tiempo. */
	async function nextEvent(reader: {
		read: () => Promise<{ done: boolean; value?: Uint8Array }>;
	}): Promise<{ unread: number }> {
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const chunk = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("el flujo no mandó nada en 5 s")),
						5_000,
					).unref?.(),
				),
			]);
			if (chunk.done || !chunk.value) throw new Error("el flujo se cerró");

			buffer += decoder.decode(chunk.value, { stream: true });
			for (const line of buffer.split("\n")) {
				const data = line.startsWith("data: ") ? line.slice(6).trim() : "";
				// Los latidos van con `data` vacío: no son un evento.
				if (data) return JSON.parse(data) as { unread: number };
			}
		}
	}

	test("el flujo avisa al llegar una nueva", async () => {
		const res = await request("/api/notifications/stream", { as: alice });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");

		const reader = res.body?.getReader();
		if (!reader) throw new Error("el flujo no trae cuerpo");

		try {
			// El primero va al conectar: sincroniza el contador sin esperar.
			expect((await nextEvent(reader)).unread).toBe(0);

			await notify(db, [await profileIdOf(alice)], {
				type: "department.paused",
				title: "En vivo",
				body: "Recién llegada",
			});

			expect((await nextEvent(reader)).unread).toBe(1);
		} finally {
			await reader.cancel();
		}
	});

	test("con la entrega en vivo caída, el sondeo sigue actualizando el contador", async () => {
		// «Caída» aquí es literal: **no hay ninguna conexión abierta**. El criterio
		// de la §9 pide justo esto — que el respaldo no dependa del flujo.
		expect(await unreadCount(alice)).toBe(0);
		await seed(alice);
		expect(await unreadCount(alice)).toBe(1);
	});
});

describe("RN-14.6 — retención", () => {
	async function setRetention(days: number) {
		await db
			.insert(appConfig)
			.values({ key: "notification_retention_days", value: days })
			.onConflictDoUpdate({
				target: appConfig.key,
				set: { value: days },
			});
		invalidateConfigCache();
	}

	const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

	test("con la clave en 0 no se purga nada", async () => {
		await setRetention(0);
		await seed(alice, { readAt: daysAgo(400) });

		expect(await purgeReadNotifications()).toBe(0);
		expect((await page()).notifications).toHaveLength(1);
	});

	test("se lleva las leídas viejas y deja las recientes", async () => {
		await setRetention(30);
		await seed(alice, { title: "Vieja y leída", readAt: daysAgo(31) });
		await seed(alice, { title: "Leída ayer", readAt: daysAgo(1) });

		expect(await purgeReadNotifications()).toBe(1);
		expect((await page()).notifications.map((row) => row.title)).toEqual([
			"Leída ayer",
		]);
	});

	test("no toca las que están sin leer, por viejas que sean", async () => {
		// Una sin leer es trabajo pendiente de alguien: borrarla porque lleva
		// mucho tiempo ahí es lo contrario de para qué existe.
		await setRetention(30);
		await seed(alice, { title: "Vieja sin leer", createdAt: daysAgo(400) });

		expect(await purgeReadNotifications()).toBe(0);
		expect((await page()).notifications).toHaveLength(1);
	});
});
