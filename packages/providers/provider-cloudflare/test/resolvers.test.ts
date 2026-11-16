import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_D1_PRODUCT_ID,
	CLOUDFLARE_KV_PRODUCT_ID,
	CLOUDFLARE_PAGES_PRODUCT_ID,
	CLOUDFLARE_QUEUES_PRODUCT_ID,
	CLOUDFLARE_R2_PRODUCT_ID,
	CLOUDFLARE_RESOLVED_PRODUCT_IDS,
	CLOUDFLARE_WORKERS_PRODUCT_ID,
	cloudflareResolverRegistry,
	cloudflareResolvers,
	guardedCloudflareTransport,
	redactCloudflareText,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

const ACCOUNT_ID = "acct-1234";
const CREDENTIAL_REF = "env://CLOUDFLARE_API_TOKEN";
const TOKEN = "cf-token-value";

// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
/** A 40-character token-shaped string, as Cloudflare echoes them in errors. */
const LEAKED_TOKEN = "abcdefghij0123456789ABCDEFGHIJ0123456789";

/** One recorded outbound call, so a test can assert what was actually sent. */
interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly body: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

interface Fake {
	readonly transport: HttpTransport;
	readonly calls: readonly RecordedCall[];
	countOf(method: string, path: string): number;
}

function record(request: TransportRequest): RecordedCall {
	const url = new URL(request.url);
	return {
		method: request.method,
		path: url.pathname,
		search: url.search,
		...(request.body !== undefined
			? { body: request.body }
			: { body: undefined }),
		headers: request.headers,
	};
}

/**
 * A fake transport. Never a real network: the handler is the whole provider,
 * which is what lets a test assert "exactly one create call" at all.
 */
function fakeTransport(
	handler: (call: RecordedCall) => TransportResponse,
): Fake {
	const calls: RecordedCall[] = [];
	return {
		transport: async (request) => {
			const call = record(request);
			calls.push(call);
			return handler(call);
		},
		calls,
		countOf(method, path) {
			return calls.filter(
				(call) => call.method === method && call.path === path,
			).length;
		},
	};
}

function json(status: number, payload: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	};
}

function ok(result: JsonValue): TransportResponse {
	return json(200, { success: true, errors: [], messages: [], result });
}

function missing(): TransportResponse {
	return json(404, {
		success: false,
		errors: [{ code: 10006, message: "not found" }],
		messages: [],
		result: null,
	});
}

function resolveCredential(): Promise<string> {
	return Promise.resolve(TOKEN);
}

function resolvers(options?: {
	readonly resolveCredential?: (ref: string) => Promise<string>;
}) {
	return cloudflareResolverRegistry({
		accountId: ACCOUNT_ID,
		resolveCredential: options?.resolveCredential ?? resolveCredential,
	});
}

function resolverFor(productId: string) {
	const resolver = resolvers().get(productId);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

const SLOTS = {
	[CLOUDFLARE_R2_PRODUCT_ID]: "bucket",
	[CLOUDFLARE_D1_PRODUCT_ID]: "data",
	[CLOUDFLARE_KV_PRODUCT_ID]: "kv",
	[CLOUDFLARE_QUEUES_PRODUCT_ID]: "queue",
	[CLOUDFLARE_WORKERS_PRODUCT_ID]: "service",
	[CLOUDFLARE_PAGES_PRODUCT_ID]: "web",
} as const satisfies Record<string, ResolveRequest["ref"]["slot"]>;

function request(
	productId: string,
	overrides?: {
		readonly logicalId?: string;
		readonly physicalId?: string;
		readonly desired?: Readonly<JsonObject>;
		readonly credentialRef?: string;
	},
): ResolveRequest {
	const slot = SLOTS[productId];
	if (slot === undefined) throw new Error(`no slot for ${productId}`);
	const physicalId = overrides?.physicalId;
	return {
		ref: {
			slot,
			productId,
			logicalId: overrides?.logicalId ?? "app-primary",
			...(physicalId !== undefined ? { physicalId } : undefined),
		},
		desired: overrides?.desired ?? {},
		credentialRef: overrides?.credentialRef ?? CREDENTIAL_REF,
	};
}

/** The code a refusal carried, or undefined if the call resolved. */
async function refusalCode(
	call: () => Promise<void>,
): Promise<string | undefined> {
	try {
		await call();
		return undefined;
	} catch (error) {
		if (error instanceof ResolverError) return error.code;
		throw error;
	}
}

async function refusalMessage(call: () => Promise<void>): Promise<string> {
	try {
		await call();
		return "";
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
}

const R2_COLLECTION = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`;
const D1_COLLECTION = `/client/v4/accounts/${ACCOUNT_ID}/d1/database`;
const KV_COLLECTION = `/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces`;
const QUEUES_COLLECTION = `/client/v4/accounts/${ACCOUNT_ID}/queues`;
const PAGES_COLLECTION = `/client/v4/accounts/${ACCOUNT_ID}/pages/projects`;
const WORKER_SCRIPT = `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/app-primary`;

// ---------------------------------------------------------------------------
// Stateful provider doubles: one per product, so "run it twice" is meaningful.
// ---------------------------------------------------------------------------

/** Minimal in-memory Cloudflare, keyed by the deterministic resource name. */
function r2Double(): (call: RecordedCall) => TransportResponse {
	const buckets = new Map<string, JsonObject>();
	return (call) => {
		const name = call.path.slice(`${R2_COLLECTION}/`.length);
		if (call.method === "GET") {
			const found = buckets.get(name);
			return found === undefined ? missing() : ok(found);
		}
		if (call.method === "POST") {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			const created = {
				name: body.name,
				location: "wnam",
				storage_class: "Standard",
			};
			buckets.set(String(body.name), created);
			return ok(created);
		}
		if (call.method === "DELETE") {
			if (!buckets.delete(name)) return missing();
			return ok(null);
		}
		throw new Error(`unexpected ${call.method} ${call.path}`);
	};
}

function d1Double(): (call: RecordedCall) => TransportResponse {
	const databases = new Map<string, JsonObject>();
	return (call) => {
		if (call.method === "GET") {
			const name = new URLSearchParams(call.search).get("name") ?? "";
			const found = databases.get(name);
			return ok(found === undefined ? [] : [found]);
		}
		if (call.method === "POST") {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			const name = String(body.name);
			const created = {
				uuid: `uuid-${name}`,
				name,
				read_replication: { mode: "disabled" },
			};
			databases.set(name, created);
			return ok(created);
		}
		if (call.method === "PATCH") {
			const uuid = call.path.slice(`${D1_COLLECTION}/`.length);
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			for (const [name, entry] of databases) {
				if (entry.uuid !== uuid) continue;
				const updated = {
					...entry,
					read_replication: body.read_replication,
				};
				databases.set(name, updated);
				return ok(updated);
			}
			return missing();
		}
		if (call.method === "DELETE") {
			const uuid = call.path.slice(`${D1_COLLECTION}/`.length);
			for (const [name, entry] of databases) {
				if (entry.uuid === uuid) {
					databases.delete(name);
					return ok(null);
				}
			}
			return missing();
		}
		throw new Error(`unexpected ${call.method} ${call.path}`);
	};
}

function kvDouble(): (call: RecordedCall) => TransportResponse {
	const namespaces = new Map<string, JsonObject>();
	return (call) => {
		if (call.method === "GET") {
			return ok([...namespaces.values()]);
		}
		if (call.method === "POST") {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			const title = String(body.title);
			const created = { id: `ns-${title}`, title };
			namespaces.set(title, created);
			return ok(created);
		}
		if (call.method === "DELETE") {
			const id = call.path.slice(`${KV_COLLECTION}/`.length);
			for (const [title, entry] of namespaces) {
				if (entry.id === id) {
					namespaces.delete(title);
					return ok(null);
				}
			}
			return missing();
		}
		throw new Error(`unexpected ${call.method} ${call.path}`);
	};
}

function queuesDouble(): (call: RecordedCall) => TransportResponse {
	const queues = new Map<string, JsonObject>();
	return (call) => {
		if (call.method === "GET") return ok([...queues.values()]);
		if (call.method === "POST") {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			const name = String(body.queue_name);
			const created = {
				queue_id: `q-${name}`,
				queue_name: name,
				settings: body.settings ?? {},
			};
			queues.set(name, created);
			return ok(created);
		}
		if (call.method === "PUT") {
			const id = call.path.slice(`${QUEUES_COLLECTION}/`.length);
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			for (const [name, entry] of queues) {
				if (entry.queue_id !== id) continue;
				const updated = { ...entry, settings: body.settings };
				queues.set(name, updated);
				return ok(updated);
			}
			return missing();
		}
		if (call.method === "DELETE") {
			const id = call.path.slice(`${QUEUES_COLLECTION}/`.length);
			for (const [name, entry] of queues) {
				if (entry.queue_id === id) {
					queues.delete(name);
					return ok(null);
				}
			}
			return missing();
		}
		throw new Error(`unexpected ${call.method} ${call.path}`);
	};
}

function pagesDouble(): (call: RecordedCall) => TransportResponse {
	const projects = new Map<string, JsonObject>();
	return (call) => {
		const name = call.path.slice(`${PAGES_COLLECTION}/`.length);
		if (call.method === "GET") {
			const found = projects.get(name);
			return found === undefined ? missing() : ok(found);
		}
		if (call.method === "POST") {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			const created = {
				name: body.name,
				production_branch: body.production_branch ?? "main",
				subdomain: `${String(body.name)}.pages.dev`,
			};
			projects.set(String(body.name), created);
			return ok(created);
		}
		if (call.method === "PATCH") {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const body = JSON.parse(call.body ?? "{}") as JsonObject;
			const existing = projects.get(name);
			if (existing === undefined) return missing();
			const updated = {
				...existing,
				production_branch: body.production_branch,
			};
			projects.set(name, updated);
			return ok(updated);
		}
		if (call.method === "DELETE") {
			if (!projects.delete(name)) return missing();
			return ok(null);
		}
		throw new Error(`unexpected ${call.method} ${call.path}`);
	};
}

function workersDouble(): (call: RecordedCall) => TransportResponse {
	const scripts = new Map<
		string,
		{ source: string; settings: JsonObject; enabled: boolean }
	>();
	return (call) => {
		if (call.path === `/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`)
			return ok({ subdomain: "account-owned" });
		const match =
				/\/workers\/scripts\/([^/]+)(?:\/(settings|subdomain))?$/u.exec(
					call.path,
				),
			name = match?.[1] ?? "",
			suffix = match?.[2],
			found = scripts.get(name);
		if (call.method === "GET") {
			if (!found) return missing();
			if (suffix === "settings") return ok(found.settings);
			if (suffix === "subdomain")
				return ok({ enabled: found.enabled, previews_enabled: false });
			return {
				status: 200,
				headers: {
					"content-type": "multipart/form-data; boundary=native-observed",
				},
				body: `--native-observed\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\n${found.source}\r\n--native-observed--\r\n`,
			};
		}
		if (call.method === "PUT") {
			const body = call.body ?? "",
				metadata = body.split("\r\n\r\n")[1]?.split("\r\n--")[0],
				source = body
					.split("Content-Type: application/javascript+module\r\n\r\n")[1]
					?.split("\r\n--")[0];
			if (!metadata || source === undefined)
				throw new Error("invalid worker upload fixture");
			// SAFETY: the worker double parses the JSON metadata section emitted by the shipped multipart composer.
			const settings = JSON.parse(metadata) as JsonObject;
			scripts.set(name, {
				source,
				settings: {
					compatibility_date: settings.compatibility_date ?? "2026-01-01",
					compatibility_flags: settings.compatibility_flags ?? [],
					placement: settings.placement ?? { mode: "off" },
					bindings: settings.bindings ?? [],
				},
				enabled: found?.enabled ?? false,
			});
			return ok({ id: name, etag: "native-etag" });
		}
		if (call.method === "POST" && suffix === "subdomain" && found) {
			const body = JSON.parse(call.body ?? "{}");
			found.enabled = body.enabled === true;
			return ok({ enabled: found.enabled, previews_enabled: false });
		}
		if (call.method === "DELETE") {
			if (!scripts.delete(name)) return missing();
			return ok(null);
		}
		throw new Error(`unexpected ${call.method} ${call.path}`);
	};
}

const WORKER_SOURCE = "export default { fetch: () => new Response('hi') };";

/**
 * Per-product harness: the double, the desired bag that makes a create
 * meaningful, and where a create lands, so one table drives the shared laws.
 */
const HARNESSES = [
	{
		name: "r2",
		productId: CLOUDFLARE_R2_PRODUCT_ID,
		double: r2Double,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		desired: {},
		createMethod: "POST",
		createPath: R2_COLLECTION,
		physicalId: "app-primary",
	},
	{
		name: "d1",
		productId: CLOUDFLARE_D1_PRODUCT_ID,
		double: d1Double,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		desired: {},
		createMethod: "POST",
		createPath: D1_COLLECTION,
		physicalId: "uuid-app-primary",
	},
	{
		name: "kv",
		productId: CLOUDFLARE_KV_PRODUCT_ID,
		double: kvDouble,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		desired: {},
		createMethod: "POST",
		createPath: KV_COLLECTION,
		physicalId: "ns-app-primary",
	},
	{
		name: "queues",
		productId: CLOUDFLARE_QUEUES_PRODUCT_ID,
		double: queuesDouble,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		desired: {},
		createMethod: "POST",
		createPath: QUEUES_COLLECTION,
		physicalId: "q-app-primary",
	},
	{
		name: "pages",
		productId: CLOUDFLARE_PAGES_PRODUCT_ID,
		double: pagesDouble,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		desired: {},
		createMethod: "POST",
		createPath: PAGES_COLLECTION,
		physicalId: "app-primary",
	},
	{
		name: "workers",
		productId: CLOUDFLARE_WORKERS_PRODUCT_ID,
		double: workersDouble,
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		desired: { script: WORKER_SOURCE } as Readonly<JsonObject>,
		createMethod: "PUT",
		createPath: WORKER_SCRIPT,
		physicalId: "app-primary",
	},
] as const;

describe("cloudflare resolver registry", () => {
	it("registers exactly the products the slot factories emit", () => {
		expect(
			resolvers()
				.list()
				.map((resolver) => resolver.productId),
		).toEqual([...CLOUDFLARE_RESOLVED_PRODUCT_IDS]);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("reports cloudflare as the provider for every resolver", () => {
		for (const resolver of resolvers().list()) {
			expect(resolver.providerId).toBe("cloudflare");
		}
	});

	it("returns undefined for a product it does not resolve", () => {
		expect(resolvers().get("aws.s3/v1")).toBeUndefined();
	});

	it("refuses a resolver handed another product's request", async () => {
		const fake = fakeTransport(() => ok({}));
		const resolver = resolverFor(CLOUDFLARE_R2_PRODUCT_ID);
		const foreign = request(CLOUDFLARE_D1_PRODUCT_ID);
		expect(
			await refusalCode(() => resolver.reconcile(foreign, fake.transport)),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(fake.calls).toHaveLength(0);
	});
});

describe.each(HARNESSES)("$name resolver reconciles convergently", ({
	productId,
	double,
	desired,
	createMethod,
	createPath,
	physicalId,
}) => {
	it("creates the resource when the provider does not have it", async () => {
		const fake = fakeTransport(double());
		const outcome = await resolverFor(productId).reconcile(
			request(productId, { desired }),
			fake.transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(physicalId);
		expect(outcome.contract).toBe("hobo.resource-resolver/v1");
		expect(fake.countOf(createMethod, createPath)).toBe(1);
	});

	it("reconciles twice into one resource with the same physical id", async () => {
		const fake = fakeTransport(double());
		const resolver = resolverFor(productId);
		const first = await resolver.reconcile(
			request(productId, { desired }),
			fake.transport,
		);
		const second = await resolver.reconcile(
			request(productId, { desired }),
			fake.transport,
		);
		expect(second.physicalId).toBe(first.physicalId);
		expect(second.action).not.toBe("create");
		// Workers share one endpoint for create and update, so the count is
		// asserted per product below; every other product must not create twice.
		if (createMethod === "POST") {
			expect(fake.countOf(createMethod, createPath)).toBe(1);
		}
	});

	it("reads back nothing before the resource exists", async () => {
		const fake = fakeTransport(double());
		const resolver = resolverFor(productId);
		expect(resolver.read).toBeTypeOf("function");
		expect(
			await resolver.read?.(request(productId, { desired }), fake.transport),
		).toBeUndefined();
	});

	it("reads back the resource once it exists", async () => {
		const fake = fakeTransport(double());
		const resolver = resolverFor(productId);
		await resolver.reconcile(request(productId, { desired }), fake.transport);
		const found = await resolver.read?.(
			request(productId, { desired }),
			fake.transport,
		);
		expect(found?.physicalId).toBe(physicalId);
	});

	it("adopts an existing resource the request did not name, and noops one it did", async () => {
		const fake = fakeTransport(double());
		const resolver = resolverFor(productId);
		await resolver.reconcile(request(productId, { desired }), fake.transport);
		const adopted = await resolver.reconcile(
			request(productId, { desired }),
			fake.transport,
		);
		const known = await resolver.reconcile(
			request(productId, { desired, physicalId }),
			fake.transport,
		);
		// Native source readback makes an unchanged Worker an adoption/noop too.
		const expected = "adopt";
		expect(adopted.action).toBe(expected);
		expect(known.action).toBe("noop");
	});

	it("deletes the resource, and deleting a missing one succeeds", async () => {
		const fake = fakeTransport(double());
		const resolver = resolverFor(productId);
		await resolver.reconcile(request(productId, { desired }), fake.transport);
		await expect(
			resolver.delete(request(productId, { desired }), fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(request(productId, { desired }), fake.transport),
		).resolves.toBeUndefined();
		expect(
			await resolver.read?.(request(productId, { desired }), fake.transport),
		).toBeUndefined();
	});

	it("deleting a resource that never existed succeeds", async () => {
		const fake = fakeTransport(double());
		await expect(
			resolverFor(productId).delete(
				request(productId, { desired }),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("mutable deltas are applied, immutable drift is only reported", () => {
	it("d1 patches read replication when the observed mode differs", async () => {
		const fake = fakeTransport(d1Double());
		const resolver = resolverFor(CLOUDFLARE_D1_PRODUCT_ID);
		await resolver.reconcile(request(CLOUDFLARE_D1_PRODUCT_ID), fake.transport);
		const updated = await resolver.reconcile(
			request(CLOUDFLARE_D1_PRODUCT_ID, {
				desired: { readReplication: true },
			}),
			fake.transport,
		);
		expect(updated.action).toBe("update");
		expect(updated.diagnostics).toContain("read replication set to auto");
		expect(fake.countOf("PATCH", `${D1_COLLECTION}/uuid-app-primary`)).toBe(1);
	});

	it("d1 stops patching once the mode matches", async () => {
		const fake = fakeTransport(d1Double());
		const resolver = resolverFor(CLOUDFLARE_D1_PRODUCT_ID);
		const desired = { readReplication: true };
		await resolver.reconcile(
			request(CLOUDFLARE_D1_PRODUCT_ID, { desired }),
			fake.transport,
		);
		const second = await resolver.reconcile(
			request(CLOUDFLARE_D1_PRODUCT_ID, { desired }),
			fake.transport,
		);
		expect(second.action).toBe("adopt");
		expect(fake.countOf("PATCH", `${D1_COLLECTION}/uuid-app-primary`)).toBe(1);
	});

	it("pages patches the production branch when it drifts", async () => {
		const fake = fakeTransport(pagesDouble());
		const resolver = resolverFor(CLOUDFLARE_PAGES_PRODUCT_ID);
		await resolver.reconcile(
			request(CLOUDFLARE_PAGES_PRODUCT_ID),
			fake.transport,
		);
		const updated = await resolver.reconcile(
			request(CLOUDFLARE_PAGES_PRODUCT_ID, {
				desired: { productionBranch: "release" },
			}),
			fake.transport,
		);
		expect(updated.action).toBe("update");
		expect(updated.outputs.productionBranch).toBe("release");
	});

	it("queues updates queue-scoped settings and reports consumer-scoped ones", async () => {
		const fake = fakeTransport(queuesDouble());
		const resolver = resolverFor(CLOUDFLARE_QUEUES_PRODUCT_ID);
		await resolver.reconcile(
			request(CLOUDFLARE_QUEUES_PRODUCT_ID),
			fake.transport,
		);
		const updated = await resolver.reconcile(
			request(CLOUDFLARE_QUEUES_PRODUCT_ID, {
				desired: { deliveryDelaySeconds: 30, maxRetries: 3 },
			}),
			fake.transport,
		);
		expect(updated.action).toBe("update");
		expect(fake.countOf("PUT", `${QUEUES_COLLECTION}/q-app-primary`)).toBe(1);
		expect(updated.diagnostics.join(" ")).toMatch(/maxRetries/u);
		expect(updated.diagnostics.join(" ")).toMatch(/consumer settings/u);
	});

	it("r2 reports a location drift rather than replacing the bucket", async () => {
		const fake = fakeTransport(r2Double());
		const resolver = resolverFor(CLOUDFLARE_R2_PRODUCT_ID);
		await resolver.reconcile(request(CLOUDFLARE_R2_PRODUCT_ID), fake.transport);
		const second = await resolver.reconcile(
			request(CLOUDFLARE_R2_PRODUCT_ID, {
				desired: { locationHint: "eeur" },
			}),
			fake.transport,
		);
		expect(second.action).not.toBe("replace");
		expect(second.diagnostics.join(" ")).toMatch(/immutable/u);
	});

	/**
	 * R2 accepts `locationHint` lowercase and reports `location` uppercase, so a
	 * case-sensitive compare would report drift on a bucket that is exactly
	 * where it was asked to be — a diagnostic firing on every reconcile teaches
	 * operators to ignore diagnostics.
	 */
	it("r2 does not report drift when the location differs only by case", async () => {
		const fake = fakeTransport(r2Double());
		const resolver = resolverFor(CLOUDFLARE_R2_PRODUCT_ID);
		await resolver.reconcile(
			request(CLOUDFLARE_R2_PRODUCT_ID, { desired: { locationHint: "wnam" } }),
			fake.transport,
		);
		const second = await resolver.reconcile(
			request(CLOUDFLARE_R2_PRODUCT_ID, { desired: { locationHint: "WNAM" } }),
			fake.transport,
		);
		expect(second.diagnostics.join(" ")).not.toMatch(/immutable/u);
	});

	it("kv reports that ttlSeconds is a per-write setting", async () => {
		const fake = fakeTransport(kvDouble());
		const created = await resolverFor(CLOUDFLARE_KV_PRODUCT_ID).reconcile(
			request(CLOUDFLARE_KV_PRODUCT_ID, { desired: { ttlSeconds: 60 } }),
			fake.transport,
		);
		expect(created.diagnostics.join(" ")).toMatch(/per write/u);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("r2 sends the jurisdiction as a header on every call", async () => {
		const fake = fakeTransport(r2Double());
		await resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
			request(CLOUDFLARE_R2_PRODUCT_ID, { desired: { jurisdiction: "eu" } }),
			fake.transport,
		);
		for (const call of fake.calls) {
			expect(call.headers["cf-r2-jurisdiction"]).toBe("eu");
		}
	});

	it("workers upload a multipart body carrying the module source", async () => {
		const fake = fakeTransport(workersDouble());
		await resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
			request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				desired: { script: WORKER_SOURCE, compatibilityDate: "2026-01-01" },
			}),
			fake.transport,
		);
		const upload = fake.calls.find((call) => call.method === "PUT");
		expect(upload?.headers["content-type"]).toMatch(/^multipart\/form-data; /u);
		expect(upload?.body).toContain(WORKER_SOURCE);
		expect(upload?.body).toContain('"compatibility_date":"2026-01-01"');
	});

	it("workers refuse to create a script with no source", async () => {
		const fake = fakeTransport(workersDouble());
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_WORKERS_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

describe("credentials are locators, and a missing one is a refusal", () => {
	it.each([
		["", "RESOLVER_CREDENTIAL_MISSING", "an empty ref names nothing"],
		["   ", "RESOLVER_CREDENTIAL_MISSING", "a blank ref names nothing"],
		[
			LEAKED_TOKEN,
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"a pasted token is material, not a locator",
		],
		[
			"CLOUDFLARE_API_TOKEN",
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"a bare name has no scheme",
		],
		["env:TOKEN", "RESOLVER_CREDENTIAL_NOT_A_REF", "a locator needs scheme://"],
	])("refuses credentialRef %j with %s", async (ref, code) => {
		const fake = fakeTransport(() => ok({}));
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_R2_PRODUCT_ID, { credentialRef: ref }),
					fake.transport,
				),
			),
		).toBe(code);
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses when the host resolver returns nothing", async () => {
		const fake = fakeTransport(() => ok({}));
		const registry = resolvers({
			resolveCredential: async () => Promise.resolve(""),
		});
		expect(
			await refusalCode(() =>
				registry
					.get(CLOUDFLARE_R2_PRODUCT_ID)
					?.reconcile(request(CLOUDFLARE_R2_PRODUCT_ID), fake.transport),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses when the host resolver throws, with remediation", async () => {
		const fake = fakeTransport(() => ok({}));
		const registry = resolvers({
			resolveCredential: () => Promise.reject(new Error("vault sealed")),
		});
		const resolver = registry.get(CLOUDFLARE_R2_PRODUCT_ID);
		expect(resolver).toBeDefined();
		const message = await refusalMessage(async () =>
			resolver?.reconcile(request(CLOUDFLARE_R2_PRODUCT_ID), fake.transport),
		);
		expect(message).toMatch(/Register the reference/u);
		expect(message).toMatch(/vault sealed/u);
		expect(fake.calls).toHaveLength(0);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("sends the resolved material as a bearer token and never the ref", async () => {
		const fake = fakeTransport(r2Double());
		await resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
			request(CLOUDFLARE_R2_PRODUCT_ID),
			fake.transport,
		);
		const first = fake.calls[0];
		expect(first?.headers.authorization).toBe(`Bearer ${TOKEN}`);
	});
});

describe("provider responses cross a parse boundary", () => {
	it("maps a non-success envelope to RESOLVER_PROVIDER_REJECTED", async () => {
		const fake = fakeTransport(() =>
			json(403, {
				success: false,
				errors: [{ code: 10000, message: "Authentication error" }],
				result: null,
			}),
		);
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_R2_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("redacts token-shaped text out of the provider's error message", async () => {
		const fake = fakeTransport(() =>
			json(403, {
				success: false,
				errors: [{ code: 10000, message: `Invalid token ${LEAKED_TOKEN}` }],
				result: null,
			}),
		);
		const message = await refusalMessage(() =>
			resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
				request(CLOUDFLARE_R2_PRODUCT_ID),
				fake.transport,
			),
		);
		expect(message).not.toContain(LEAKED_TOKEN);
		expect(message).toContain("[redacted]");
		expect(message).toContain("Invalid token");
	});

	it("maps a non-JSON body to RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const fake = fakeTransport(() => ({
			status: 200,
			headers: {},
			body: "<html>maintenance</html>",
		}));
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_R2_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("maps a JSON body that is not the v4 envelope to RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const fake = fakeTransport(() => json(200, { result: { name: "x" } }));
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_R2_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("maps a successful envelope with an unusable result to RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const fake = fakeTransport((call) =>
			call.method === "GET" ? missing() : ok("not-an-object"),
		);
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_R2_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses a D1 record with no uuid rather than inventing an id", async () => {
		const fake = fakeTransport((call) =>
			call.method === "GET" ? ok([]) : ok({ name: "app-primary" }),
		);
		expect(
			await refusalCode(() =>
				resolverFor(CLOUDFLARE_D1_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_D1_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("redacts long token-shaped runs but leaves ordinary prose alone", () => {
		expect(redactCloudflareText(`bad token ${LEAKED_TOKEN}`)).toBe(
			"bad token [redacted]",
		);
		expect(redactCloudflareText("bucket name is invalid")).toBe(
			"bucket name is invalid",
		);
	});
});

describe("paged lookups find a resource that is not on the first page", () => {
	it("keeps reading KV pages until the provider says it is done", async () => {
		const filler = Array.from({ length: 100 }, (_, index) => ({
			id: `ns-filler-${index}`,
			title: `filler-${index}`,
		}));
		const fake = fakeTransport((call) => {
			if (call.method !== "GET") throw new Error("unexpected write");
			const page = new URLSearchParams(call.search).get("page");
			return json(200, {
				success: true,
				errors: [],
				result:
					page === "1"
						? filler
						: [{ id: "ns-app-primary", title: "app-primary" }],
				result_info: { page: Number(page), per_page: 100, total_pages: 2 },
			});
		});
		const found = await resolverFor(CLOUDFLARE_KV_PRODUCT_ID).read?.(
			request(CLOUDFLARE_KV_PRODUCT_ID),
			fake.transport,
		);
		expect(found?.physicalId).toBe("ns-app-primary");
		expect(fake.calls).toHaveLength(2);
	});
});

describe("the Cloudflare guard is what makes an injected transport safe", () => {
	const inner: HttpTransport = async () => ok({});

	it("passes a legitimate Cloudflare v4 call through", async () => {
		const fake = fakeTransport(r2Double());
		const guarded = guardedCloudflareTransport(fake.transport);
		const outcome = await resolverFor(CLOUDFLARE_R2_PRODUCT_ID).reconcile(
			request(CLOUDFLARE_R2_PRODUCT_ID),
			guarded,
		);
		expect(outcome.action).toBe("create");
	});

	it("refuses a host that is not api.cloudflare.com", async () => {
		const guarded = guardedCloudflareTransport(inner);
		await expect(
			guarded({
				method: "GET",
				url: "https://api.cloudfIare.com/client/v4/accounts/a/r2/buckets",
				headers: {},
				timeoutMs: 1_000,
				maxResponseBytes: 1_024,
			}),
		).rejects.toMatchObject({ code: "TRANSPORT_HOST_FORBIDDEN" });
	});

	it("refuses a path outside /client/v4/", async () => {
		const guarded = guardedCloudflareTransport(inner);
		await expect(
			guarded({
				method: "GET",
				url: "https://api.cloudflare.com/admin/accounts",
				headers: {},
				timeoutMs: 1_000,
				maxResponseBytes: 1_024,
			}),
		).rejects.toMatchObject({ code: "TRANSPORT_PATH_FORBIDDEN" });
	});

	it("refuses plain http even on the allowlisted host", async () => {
		const guarded = guardedCloudflareTransport(inner);
		await expect(
			guarded({
				method: "GET",
				url: "http://api.cloudflare.com/client/v4/accounts/a/r2/buckets",
				headers: {},
				timeoutMs: 1_000,
				maxResponseBytes: 1_024,
			}),
		).rejects.toMatchObject({ code: "TRANSPORT_SCHEME_FORBIDDEN" });
	});
});

describe("resolver construction fails closed", () => {
	it("refuses an empty accountId rather than targeting the wrong tenant", () => {
		expect(() =>
			cloudflareResolvers({ accountId: "  ", resolveCredential }),
		).toThrow(/accountId/u);
	});
});

describe("Workers native lifecycle and serving proof", () => {
	it("activates public workers.dev only when explicitly requested and reads actual source/endpoint", async () => {
		const fake = fakeTransport(workersDouble()),
			r = resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID),
			req = request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				desired: { script: WORKER_SOURCE, workersDev: true },
			});
		const created = await r.reconcile(req, fake.transport);
		expect(created.outputs).toMatchObject({
			ready: true,
			operationConfirmed: true,
			workersDev: true,
			servingEndpoint: "https://app-primary.account-owned.workers.dev",
		});
		expect(created.outputs.artifactDigest).toMatch(/^sha256:/);
		expect(fake.countOf("POST", `${WORKER_SCRIPT}/subdomain`)).toBe(1);
		await r.reconcile(req, fake.transport);
		expect(fake.countOf("PUT", WORKER_SCRIPT)).toBe(1);
		expect(fake.countOf("POST", `${WORKER_SCRIPT}/subdomain`)).toBe(1);
	});
	it("does not invent a public endpoint or activate a private generic Worker", async () => {
		const fake = fakeTransport(workersDouble()),
			result = await resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
				request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
					desired: { script: WORKER_SOURCE },
				}),
				fake.transport,
			);
		expect(result.outputs.ready).toBe(true);
		expect(result.outputs.workersDev).toBe(false);
		expect(result.outputs.servingEndpoint).toBeUndefined();
		expect(fake.calls.every((call) => call.method !== "POST")).toBe(true);
	});
	it("requires the provider to acknowledge public activation", async () => {
		const native = workersDouble();
		const fake = fakeTransport((call) =>
			call.method === "POST" && call.path.endsWith("/subdomain")
				? ok({ enabled: false })
				: native(call),
		);
		await expect(
			resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
				request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
					desired: { script: WORKER_SOURCE, workersDev: true },
				}),
				fake.transport,
			),
		).rejects.toThrow(/confirm.*exposure/);
	});
	it("refuses a foreign or missing native account subdomain", async () => {
		for (const account of [{ subdomain: "foreign.example" }, {}]) {
			const native = workersDouble();
			const fake = fakeTransport((call) =>
				call.path === `/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`
					? ok(account)
					: native(call),
			);
			await expect(
				resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
						desired: { script: WORKER_SOURCE, workersDev: true },
					}),
					fake.transport,
				),
			).rejects.toThrow(/invalid native serving subdomain/);
		}
	});
	it("keeps settings-only observations pending without an artifact proof", async () => {
		const native = workersDouble();
		const fake = fakeTransport((call) =>
			call.method === "GET" && call.path === WORKER_SCRIPT
				? missing()
				: native(call),
		);
		const result = await resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
			request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				desired: { script: WORKER_SOURCE },
			}),
			fake.transport,
		);
		expect(result.outputs.ready).toBe(false);
		expect(result.outputs.operationConfirmed).toBe(false);
		expect(result.outputs.artifactDigest).toBeUndefined();
		expect(result.outputs.servingEndpoint).toBeUndefined();
	});
	it("reports actual differing source bytes instead of copying the desired digest", async () => {
		const native = workersDouble();
		const fake = fakeTransport((call) =>
			call.method === "GET" && call.path === WORKER_SCRIPT
				? {
						status: 200,
						headers: { "content-type": "application/javascript" },
						body: "provider-different-source",
					}
				: native(call),
		);
		const r = resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID);
		const req = request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
			desired: { script: WORKER_SOURCE },
		});
		const result = await r.reconcile(req, fake.transport);
		const normal = await r.reconcile(
			req,
			fakeTransport(workersDouble()).transport,
		);
		expect(result.outputs.artifactDigest).not.toBe(
			normal.outputs.artifactDigest,
		);
	});
	it("deactivates a public Worker only when explicitly requested", async () => {
		const fake = fakeTransport(workersDouble());
		const r = resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID);
		await r.reconcile(
			request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				desired: { script: WORKER_SOURCE, workersDev: true },
			}),
			fake.transport,
		);
		const result = await r.reconcile(
			request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				desired: { script: WORKER_SOURCE, workersDev: false },
			}),
			fake.transport,
		);
		expect(result.outputs.ready).toBe(true);
		expect(result.outputs.workersDev).toBe(false);
		expect(result.outputs.servingEndpoint).toBeUndefined();
		expect(fake.countOf("POST", `${WORKER_SCRIPT}/subdomain`)).toBe(2);
		expect(fake.countOf("PUT", WORKER_SCRIPT)).toBe(1);
	});
	it("never recreates a missing pinned Worker or follows a conflicting desired name", async () => {
		for (const req of [
			request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				physicalId: "app-primary",
				desired: { script: WORKER_SOURCE },
			}),
			request(CLOUDFLARE_WORKERS_PRODUCT_ID, {
				physicalId: "owned",
				desired: { name: "foreign", script: WORKER_SOURCE },
			}),
		]) {
			const fake = fakeTransport(workersDouble());
			await expect(
				resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
					req,
					fake.transport,
				),
			).rejects.toThrow(/pinned|physical/);
			expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
		}
	});
	it("rejects unsupported exposure flags, module injection and oversized unobservable artifacts before I/O", async () => {
		for (const desired of [
			{ script: WORKER_SOURCE, workersDev: "true" },
			{ script: WORKER_SOURCE, mainModule: 'bad"\r\nmodule.js' },
			{ script: "x".repeat(524288) },
			{ script: WORKER_SOURCE, ownershipRef: "invented" },
		]) {
			const fake = fakeTransport(workersDouble());
			await expect(
				resolverFor(CLOUDFLARE_WORKERS_PRODUCT_ID).reconcile(
					request(CLOUDFLARE_WORKERS_PRODUCT_ID, { desired }),
					fake.transport,
				),
			).rejects.toThrow();
			expect(fake.calls).toHaveLength(0);
		}
	});
});
