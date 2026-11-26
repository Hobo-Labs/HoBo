/**
 * Hostinger resolver tests, driven entirely through an injected fake
 * `HttpTransport`.
 *
 * The fake is the whole provider: that is what lets a test assert "reconcile
 * twice made no mutating call at all" — the property that matters on a provider
 * where allocation is a purchase rather than an API call. Nothing here touches
 * a network, a credential, or a Hostinger account — see the HONEST SCOPE
 * section of `src/resolvers.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	guardedHostingerTransport,
	HOSTINGER_ALLOWED_PATH_PREFIXES,
	HOSTINGER_API_HOST,
	HOSTINGER_DEFAULT_BINDINGS,
	HOSTINGER_DNS_ZONE_PRODUCT_ID,
	HOSTINGER_EXCLUDED_PATH_PREFIXES,
	HOSTINGER_MYSQL_PRODUCT_ID,
	HOSTINGER_RESOLVED_PRODUCT_IDS,
	HOSTINGER_STATIC_SITE_PRODUCT_ID,
	HOSTINGER_UNRESOLVED_PRODUCT_IDS,
	HOSTINGER_VPS_PRODUCT_ID,
	HOSTINGER_WEB_HOSTING_PRODUCT_ID,
	type HostingerResolverOptions,
	hostingerApiUrl,
	hostingerResolverRegistry,
	hostingerResolvers,
	redactHostingerText,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = parseJsonObject(
	readFileSync(
		join(packageRoot, "../contracts/provider-hostinger-boundary.pact.json"),
		"utf8",
	),
);

const CREDENTIAL_REF = "owner://HOSTINGER_API_TOKEN";
/** A token-shaped account token. Never expected anywhere but one header. */
const TOKEN = "fakehostingeraccounttoken0123456789abcd";
/** A 40-character token-shaped string, as providers echo them in error text. */
const LEAKED_TOKEN = "abcdefghij0123456789ABCDEFGHIJ0123456789";

type Rec = JsonObject;

interface RecordedCall {
	readonly method: string;
	readonly host: string;
	readonly path: string;
	readonly search: string;
	readonly body: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

interface Fake {
	readonly transport: HttpTransport;
	readonly calls: readonly RecordedCall[];
	/** Every call that could change something in the account. */
	mutating(): readonly RecordedCall[];
}

function record(request: TransportRequest): RecordedCall {
	const url = new URL(request.url);
	return {
		method: request.method,
		host: url.hostname,
		path: url.pathname,
		search: url.search,
		body: request.body,
		headers: request.headers,
	};
}

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
		mutating() {
			return calls.filter((call) => call.method !== "GET");
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

function notFound(): TransportResponse {
	return json(404, { message: "Not found" });
}

function unexpected(call: RecordedCall): TransportResponse {
	return json(500, {
		message: `the fake received an unexpected ${call.method} ${call.path}${call.search}`,
	});
}

function bodyOf(call: RecordedCall): Rec {
	return call.body === undefined ? {} : parseJsonObject(call.body);
}

function options(
	overrides: Partial<HostingerResolverOptions> = {},
): HostingerResolverOptions {
	return {
		resolveCredential: async () => TOKEN,
		resolveDatabasePassword: async () => DATABASE_PASSWORD,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<HostingerResolverOptions> = {},
): ResourceResolver {
	const resolver = hostingerResolverRegistry(options(overrides)).get(productId);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

function request(input: {
	readonly slot: string;
	readonly productId: string;
	readonly logicalId: string;
	readonly physicalId?: string;
	readonly desired?: Rec;
}): ResolveRequest {
	return parseResolveRequest({
		ref: {
			slot: input.slot,
			productId: input.productId,
			logicalId: input.logicalId,
			...(input.physicalId !== undefined
				? { physicalId: input.physicalId }
				: undefined),
		},
		desired: input.desired ?? {},
		credentialRef: CREDENTIAL_REF,
	});
}

async function codeOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ResolverError) return error.code;
		throw error;
	}
	return "NO_ERROR_THROWN";
}

async function messageOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	return "NO_ERROR_THROWN";
}

/** Every outcome must survive core's outcome parse boundary. */
function checked(outcome: ResolveOutcome): ResolveOutcome {
	return parseResolveOutcome(outcome);
}

// ---------------------------------------------------------------------------
// Fake Hostinger API
// ---------------------------------------------------------------------------

const MACHINES = "/api/vps/v1/virtual-machines";
const ZONE = "/api/dns/v1/zones/example.com";

function runningMachine(overrides: Rec = {}) {
	return {
		id: 12345,
		hostname: "api-1",
		state: "running",
		template: { name: "ubuntu-24-04" },
		data_center: { name: "Phoenix" },
		ipv4: [{ address: "203.0.113.9" }],
		...overrides,
	};
}

function vpsApi(
	initial: Rec[] = [],
): (call: RecordedCall) => TransportResponse {
	let machines = [...initial];
	return (call) => {
		if (call.method === "GET" && call.path === MACHINES) {
			return json(200, { data: machines });
		}
		if (call.method === "GET" && call.path.startsWith(`${MACHINES}/`)) {
			const id = Number(call.path.slice(MACHINES.length + 1));
			const found = machines.find((entry) => entry.id === id);
			return found === undefined ? notFound() : json(200, { data: found });
		}
		if (call.method === "POST" && call.path.endsWith("/setup")) {
			const id = Number(call.path.split("/")[5]);
			const sent = bodyOf(call);
			machines = machines.map((entry) =>
				entry.id === id
					? {
							...entry,
							hostname: sent.hostname,
							state: "installing",
							template: { name: "ubuntu-24-04" },
						}
					: entry,
			);
			return json(202, { message: "setup queued" });
		}
		if (call.method === "PUT" && call.path.endsWith("/hostname")) {
			const id = Number(call.path.split("/")[5]);
			const sent = bodyOf(call);
			machines = machines.map((entry) =>
				entry.id === id ? { ...entry, hostname: sent.hostname } : entry,
			);
			return json(200, { message: "hostname updated" });
		}
		return unexpected(call);
	};
}

function dnsApi(initial?: Rec[]): (call: RecordedCall) => TransportResponse {
	let zone = initial;
	return (call) => {
		if (call.method === "GET" && call.path === ZONE) {
			return zone === undefined ? notFound() : json(200, zone);
		}
		if (call.method === "PUT" && call.path === ZONE) {
			const zoneBody = bodyOf(call).zone;
			zone = isJsonArray(zoneBody) ? zoneBody.filter(isJsonObject) : [];
			return json(200, { message: "zone updated" });
		}
		if (call.method === "DELETE" && call.path === ZONE) {
			if (zone === undefined) return notFound();
			zone = [];
			return json(200, { message: "zone reset" });
		}
		return unexpected(call);
	};
}

const VPS_REQUEST = {
	slot: "web",
	productId: HOSTINGER_VPS_PRODUCT_ID,
	logicalId: "api-1",
	desired: { template: "ubuntu-24-04" },
} as const;

const ZONE_RECORDS = [
	{ name: "@", type: "A", ttl: 300, records: [{ content: "203.0.113.9" }] },
];

const ZONE_REQUEST = {
	slot: "api",
	productId: HOSTINGER_DNS_ZONE_PRODUCT_ID,
	logicalId: "example.com",
	desired: { records: ZONE_RECORDS },
} as const;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Websites and databases
// ---------------------------------------------------------------------------

const WEBSITES_PATH = "/api/hosting/v1/websites";
const ACCOUNT = "u123456";
const DATABASES_PATH = `/api/hosting/v1/accounts/${ACCOUNT}/databases`;
const ORDER_ID = 8675309;
/** Material the host's custody hands over. Expected in one request body only. */
const DATABASE_PASSWORD = "c0rrect-horse-battery-staple";

function websiteRecord(overrides: Rec = {}) {
	return {
		domain: "example.com",
		vhost_type: "main",
		is_enabled: true,
		username: ACCOUNT,
		client_id: 1,
		order_id: ORDER_ID,
		created_at: "2026-08-19T12:00:00Z",
		root_directory: "public_html",
		website_type: "other",
		...overrides,
	};
}

function websiteRequest(productId: string, desired: Rec = {}): ResolveRequest {
	return request({
		slot: "web",
		productId,
		logicalId: "example.com",
		desired: { orderId: ORDER_ID, ...desired },
	});
}

/** A fake account that starts with no site and remembers the one created. */
function websiteWorld(): Fake {
	let existing: Rec | undefined;
	return fakeTransport((call) => {
		if (call.method === "GET" && call.path === WEBSITES_PATH) {
			const wanted = new URLSearchParams(call.search).get("domain");
			const matches =
				existing !== undefined && existing.domain === wanted ? [existing] : [];
			return json(200, { data: matches, meta: {} });
		}
		if (call.method === "POST" && call.path === WEBSITES_PATH) {
			const body = bodyOf(call);
			existing = websiteRecord({
				domain: body.domain,
				order_id: body.order_id,
			});
			return json(201, { message: "Website created" });
		}
		if (call.method === "DELETE" && call.path.startsWith(`${WEBSITES_PATH}/`)) {
			existing = undefined;
			return json(200, { message: "Website deleted" });
		}
		return unexpected(call);
	});
}

describe("the website resolvers fill a plan without buying one", () => {
	it.each([
		["hosted", HOSTINGER_WEB_HOSTING_PRODUCT_ID],
		["static", HOSTINGER_STATIC_SITE_PRODUCT_ID],
	] as const)("creates a %s site inside an owned order", async (_kind, productId) => {
		const fake = websiteWorld();
		const resolver = resolverFor(productId);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(websiteRequest(productId), fake.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("example.com");
		expect(outcome.outputs.hostingAccount).toBe(ACCOUNT);
		const create = fake.calls.find((call) => call.method === "POST");
		if (create === undefined) {
			throw new Error("expected a create call");
		}
		expect(bodyOf(create).order_id).toBe(ORDER_ID);
	});

	/**
	 * Hostinger's website records are not uniformly populated — a freshly
	 * created site, or one on a plan that does not expose a hosting account,
	 * comes back with most of these fields missing. The outputs are recorded
	 * alongside `desired` and read back by later reconciles, so an absent field
	 * has to be *absent*: a key whose value is the string "undefined" reads as a
	 * real hosting account or document root to everything downstream, and would
	 * make the next reconcile see drift against a value that was never there.
	 */
	it("omits every optional output the account did not report", async () => {
		const fake = fakeTransport((call) => {
			if (call.method === "GET" && call.path === WEBSITES_PATH) {
				// Only the domain: the field the resolver keys on, and nothing else.
				return json(200, { data: [{ domain: "example.com" }], meta: {} });
			}
			return unexpected(call);
		});
		const outcome = parseResolveOutcome(
			await resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID).reconcile(
				websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
				fake.transport,
			),
		);
		expect(outcome.outputs.domain).toBe("example.com");
		expect(outcome.outputs.url).toBe("https://example.com");
		for (const key of [
			"hostingAccount",
			"vhostType",
			"websiteType",
			"documentRoot",
			"orderId",
		]) {
			expect(outcome.outputs).not.toHaveProperty(key);
		}
	});

	/** The property the whole design exists to have. */
	it("reconciles twice into one site and one create", async () => {
		const fake = websiteWorld();
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		const first = await resolver.reconcile(
			websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
			fake.transport,
		);
		const second = parseResolveOutcome(
			await resolver.reconcile(
				websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
				fake.transport,
			),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	/**
	 * The refusal that keeps this provider honest. Without an order id there is
	 * no plan to put the site in, and the only way to get one is to buy it.
	 */
	it("refuses to create a site when no owned order is named", async () => {
		const fake = websiteWorld();
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		const bare = request({
			slot: "web",
			productId: HOSTINGER_WEB_HOSTING_PRODUCT_ID,
			logicalId: "example.com",
		});
		const message = await messageOf(() =>
			resolver.reconcile(bare, fake.transport),
		);
		expect(message).toContain("orderId");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("never reaches the billing namespace to get one", async () => {
		const fake = websiteWorld();
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		await resolver.reconcile(
			websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
			fake.transport,
		);
		for (const call of fake.calls) {
			expect(call.path).not.toContain(
				HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.prefix,
			);
		}
	});

	it("reads back the site rather than reporting its own request", async () => {
		// The create answers with a message and no record. A resolver that
		// synthesised outputs from the request would report a site that may not
		// exist; this one refuses instead.
		const fake = fakeTransport((call) => {
			if (call.method === "GET" && call.path === WEBSITES_PATH) {
				return json(200, { data: [], meta: {} });
			}
			if (call.method === "POST" && call.path === WEBSITES_PATH) {
				return json(201, { message: "Website created" });
			}
			return unexpected(call);
		});
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		expect(
			await codeOf(() =>
				resolver.reconcile(
					websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
					fake.transport,
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("refuses to adopt a near-miss domain", async () => {
		const fake = fakeTransport((call) => {
			if (call.method === "GET" && call.path === WEBSITES_PATH) {
				// The filter answered with a neighbour, which is what a substring
				// match does. Adopting it would manage the wrong site.
				return json(200, {
					data: [websiteRecord({ domain: "staging.example.com" })],
					meta: {},
				});
			}
			if (call.method === "POST" && call.path === WEBSITES_PATH) {
				return json(201, { message: "Website created" });
			}
			return unexpected(call);
		});
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		await resolver
			.reconcile(
				websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
				fake.transport,
			)
			.catch(() => undefined);
		// It created rather than adopting the neighbour.
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("treats an already-absent site as a successful delete", async () => {
		const fake = websiteWorld();
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		await expect(
			resolver.delete(
				websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
				fake.transport,
			),
		).resolves.toBeUndefined();
		expect(fake.mutating()).toHaveLength(0);
	});

	it("says so when the site exists but is disabled", async () => {
		const fake = fakeTransport((call) =>
			call.method === "GET" && call.path === WEBSITES_PATH
				? json(200, { data: [websiteRecord({ is_enabled: false })], meta: {} })
				: unexpected(call),
		);
		const resolver = resolverFor(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		const read = await resolver.read(
			websiteRequest(HOSTINGER_WEB_HOSTING_PRODUCT_ID),
			fake.transport,
		);
		if (read === undefined) {
			throw new Error("expected a read outcome");
		}
		const outcome = parseResolveOutcome(read);
		expect(outcome.diagnostics.join(" ")).toContain("disabled");
	});
});

function databaseRecord(overrides: Rec = {}) {
	return {
		name: "appdb",
		user: "appuser",
		domain: "example.com",
		permissions: {},
		created_at: "2026-08-19T12:00:00Z",
		updated_at: "2026-08-19T12:00:00Z",
		disk_usage_mb: 0,
		max_size_mb: 1024,
		host: "mysql.hostinger.com",
		port: 3306,
		...overrides,
	};
}

function databaseRequest(desired: Rec = {}): ResolveRequest {
	return request({
		slot: "data",
		productId: HOSTINGER_MYSQL_PRODUCT_ID,
		logicalId: "appdb",
		desired: {
			hostingAccount: ACCOUNT,
			databaseUser: "appuser",
			websiteDomain: "example.com",
			...desired,
		},
	});
}

function databaseWorld(): Fake {
	let existing: Rec | undefined;
	return fakeTransport((call) => {
		if (call.method === "GET" && call.path === DATABASES_PATH) {
			const wanted = new URLSearchParams(call.search).get("search") ?? "";
			const matches =
				existing !== undefined &&
				String(existing.name).includes(wanted) &&
				wanted.length > 0
					? [existing]
					: [];
			return json(200, { data: matches, meta: {} });
		}
		if (call.method === "POST" && call.path === DATABASES_PATH) {
			const body = bodyOf(call);
			existing = databaseRecord({ name: body.name, user: body.user });
			return json(201, { message: "Database created" });
		}
		if (
			call.method === "DELETE" &&
			call.path.startsWith(`${DATABASES_PATH}/`)
		) {
			existing = undefined;
			return json(200, { message: "Database deleted" });
		}
		return unexpected(call);
	});
}

describe("the MySQL resolver converges a database inside a hosting account", () => {
	it("creates a database that is not there", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(databaseRequest(), fake.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.databaseUser).toBe("appuser");
		expect(outcome.outputs.host).toBe("mysql.hostinger.com");
	});

	it("reconciles twice into one database and one create", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		const first = await resolver.reconcile(databaseRequest(), fake.transport);
		const second = parseResolveOutcome(
			await resolver.reconcile(databaseRequest(), fake.transport),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("sends the password from the host's custody, and only in the create body", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(databaseRequest(), fake.transport),
		);
		const create = fake.calls.find((call) => call.method === "POST");
		if (create === undefined) {
			throw new Error("expected a create call");
		}
		expect(bodyOf(create).password).toBe(DATABASE_PASSWORD);
		expect(JSON.stringify(outcome.outputs)).not.toContain(DATABASE_PASSWORD);
		expect(JSON.stringify(outcome.diagnostics)).not.toContain(
			DATABASE_PASSWORD,
		);
		// The endpoint output is a locator, not a DSN carrying the password.
		expect(String(outcome.outputs.endpoint)).not.toContain("@");
	});

	it("cannot even express a password in desired, ref or not", () => {
		expect(() => databaseRequest({ password: "hunter2" })).toThrow(
			/credential/i,
		);
		expect(() => databaseRequest({ passwordRef: "owner://SOMETHING" })).toThrow(
			/credential/i,
		);
	});

	it("refuses to create when the host wired no password custody", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID, {
			resolveDatabasePassword: undefined,
		});
		expect(
			await codeOf(() => resolver.reconcile(databaseRequest(), fake.transport)),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("refuses a request that names no hosting account", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		const bare = request({
			slot: "data",
			productId: HOSTINGER_MYSQL_PRODUCT_ID,
			logicalId: "appdb",
			desired: { databaseUser: "appuser", websiteDomain: "example.com" },
		});
		expect(await codeOf(() => resolver.reconcile(bare, fake.transport))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
		expect(fake.calls).toHaveLength(0);
	});

	/**
	 * `?search=` is a substring match. Trusting it would let `appdb` adopt
	 * `appdb_staging` and then manage — or delete — the wrong database.
	 */
	it("refuses to adopt a database whose name merely contains the wanted one", async () => {
		const fake = fakeTransport((call) => {
			if (call.method === "GET" && call.path === DATABASES_PATH) {
				return json(200, {
					data: [databaseRecord({ name: "appdb_staging" })],
					meta: {},
				});
			}
			if (call.method === "POST" && call.path === DATABASES_PATH) {
				return json(201, { message: "Database created" });
			}
			return unexpected(call);
		});
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		await resolver
			.reconcile(databaseRequest(), fake.transport)
			.catch(() => undefined);
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("treats an already-absent database as a successful delete", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		await expect(
			resolver.delete(databaseRequest(), fake.transport),
		).resolves.toBeUndefined();
		expect(fake.mutating()).toHaveLength(0);
	});

	it("deletes a database it created, and reads back absent afterwards", async () => {
		const fake = databaseWorld();
		const resolver = resolverFor(HOSTINGER_MYSQL_PRODUCT_ID);
		await resolver.reconcile(databaseRequest(), fake.transport);
		await resolver.delete(databaseRequest(), fake.transport);
		expect(
			await resolver.read(databaseRequest(), fake.transport),
		).toBeUndefined();
	});
});

describe("the registry covers exactly the products with a convergent API", () => {
	it("registers a resolver for every resolved product id", () => {
		const registry = hostingerResolverRegistry(options());
		for (const productId of HOSTINGER_RESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)?.productId).toBe(productId);
		}
	});

	/**
	 * Every catalogued product converges. The list stays exported and stays
	 * asserted: a product added to `slots.ts` without a resolver has to appear
	 * here, which is what makes the next gap a review decision rather than an
	 * uncounted one.
	 */
	it("leaves no catalogued product without a resolver", () => {
		const registry = hostingerResolverRegistry(options());
		for (const productId of HOSTINGER_UNRESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)).toBeUndefined();
		}
		expect(HOSTINGER_UNRESOLVED_PRODUCT_IDS).toEqual([]);
	});

	/**
	 * These three used to be excluded on the grounds that hPanel was the only
	 * way to reach them. `/api/hosting/v1/` carries full CRUD for a website and
	 * for a database, so the excuse was wrong, not the catalog.
	 */
	it("resolves the three products that used to be excluded", () => {
		const registry = hostingerResolverRegistry(options());
		for (const productId of [
			HOSTINGER_MYSQL_PRODUCT_ID,
			HOSTINGER_STATIC_SITE_PRODUCT_ID,
			HOSTINGER_WEB_HOSTING_PRODUCT_ID,
		]) {
			expect(HOSTINGER_RESOLVED_PRODUCT_IDS).toContain(productId);
			expect(registry.get(productId)?.productId).toBe(productId);
		}
	});

	it("accounts for every catalogued product exactly once", () => {
		const catalogued = new Set(
			Object.values(HOSTINGER_DEFAULT_BINDINGS)
				.flatMap((entries) => [...(entries ?? [])])
				.map((entry) => entry.productId)
				.filter((id): id is string => id !== undefined),
		);
		const accounted = [
			...HOSTINGER_RESOLVED_PRODUCT_IDS,
			...HOSTINGER_UNRESOLVED_PRODUCT_IDS,
		].sort();
		expect(accounted).toEqual([...catalogued].sort());
		expect(new Set(accounted).size).toBe(accounted.length);
	});

	it("lists resolvers in id order and stamps the provider target", () => {
		const resolvers = hostingerResolvers(options());
		expect(resolvers.map((entry) => entry.productId)).toEqual(
			resolvers.map((entry) => entry.productId).toSorted(),
		);
		for (const resolver of resolvers) {
			expect(resolver.providerId).toBe("hostinger");
		}
	});
});

describe("allocation is a purchase, and this package will not make it", () => {
	it("refuses when nothing in the account can be adopted", async () => {
		const fake = fakeTransport(vpsApi());
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request(VPS_REQUEST),
				fake.transport,
			),
		);
		expect(message).toContain("billing order");
		expect(message).toContain("will not spend the account's money");
		expect(fake.mutating()).toHaveLength(0);
	});

	/**
	 * The refusal above is a code path; this is the property underneath it. The
	 * transport guard does not allowlist the order-placing namespace, so a later
	 * edit cannot start spending money without widening a policy a reviewer sees.
	 */
	it("cannot address the billing namespace at all", () => {
		expect(HOSTINGER_ALLOWED_PATH_PREFIXES).not.toContain(
			HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.prefix,
		);
		expect(() => hostingerApiUrl("/api/billing/v1/orders")).toThrow(/billing/);
	});

	it("refuses to remove a VPS, because that cancels a paid plan", async () => {
		const fake = fakeTransport(vpsApi([runningMachine()]));
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).delete(
				request(VPS_REQUEST),
				fake.transport,
			),
		);
		expect(message).toContain("cancelling a paid plan");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("treats an already-absent VPS as nothing to do", async () => {
		const fake = fakeTransport(vpsApi());
		await expect(
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).delete(
				request(VPS_REQUEST),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("VPS adopt-and-converge", () => {
	it("adopts a machine you already own without mutating it", async () => {
		const fake = fakeTransport(vpsApi([runningMachine()]));
		const outcome = checked(
			await resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request(VPS_REQUEST),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.physicalId).toBe("12345");
		expect(outcome.outputs.ipv4).toBe("203.0.113.9");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("matches the adopt-twice interaction the pact records", async () => {
		const interactions = pact.interactions;
		if (!isJsonArray(interactions)) {
			throw new Error("the pact file is malformed");
		}
		const interaction = interactions.find(
			(entry) =>
				isJsonObject(entry) &&
				entry.description ===
					"adopt an already-purchased VPS by hostname, twice, without mutating it",
		);
		if (!isJsonObject(interaction) || !isJsonObject(interaction.request)) {
			throw new Error("the pact is missing the adopt-twice interaction");
		}
		const body = isJsonObject(interaction.request.body)
			? interaction.request.body
			: {};
		const productId = isJsonString(body.productId) ? body.productId : "";
		const logicalId = isJsonString(body.logicalId) ? body.logicalId : "";
		const desired = isJsonObject(body.desired) ? body.desired : {};
		const fake = fakeTransport(vpsApi([runningMachine()]));
		const resolver = resolverFor(productId);
		const first = checked(
			await resolver.reconcile(
				request({
					slot: "web",
					productId,
					logicalId,
					desired,
				}),
				fake.transport,
			),
		);
		const second = checked(
			await resolver.reconcile(
				request({
					slot: "web",
					productId,
					logicalId,
					physicalId: first.physicalId,
					desired,
				}),
				fake.transport,
			),
		);
		const response = isJsonObject(interaction.response)
			? interaction.response
			: {};
		const recorded = isJsonObject(response.body) ? response.body : {};
		expect(first.contract).toBe(recorded.contract);
		expect(first.action).toBe(recorded.action);
		expect(fake.mutating()).toHaveLength(
			isJsonNumber(recorded.mutatingCalls) ? recorded.mutatingCalls : 0,
		);
		expect(second.action).toBe(recorded.reconcileTwiceAction);
		expect(second.physicalId).toBe(first.physicalId);
	});

	it("sets up a machine that was bought but never provisioned", async () => {
		const fake = fakeTransport(
			vpsApi([{ id: 999, hostname: null, state: "initial", ipv4: [] }]),
		);
		const outcome = checked(
			await resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request({
					...VPS_REQUEST,
					desired: {
						template: "ubuntu-24-04",
						virtualMachineId: "999",
						publicKeyId: 7,
						templateId: 1002,
						dataCenterId: 4,
					},
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("999");
		const setup = fake.calls.find((call) => call.path.endsWith("/setup"));
		if (setup === undefined) {
			throw new Error("expected a setup call");
		}
		expect(bodyOf(setup).hostname).toBe("api-1");
		expect(bodyOf(setup).public_key).toEqual({ id: 7 });
		expect(outcome.diagnostics.join(" ")).toContain("accepted, not confirmed");
	});

	/**
	 * The whole reason setup takes a public-key id: a ResolveRequest is recorded
	 * in the event log, so a password in it is a password in the log.
	 */
	it("refuses a root password in desired, before any call is made", async () => {
		const fake = fakeTransport(vpsApi());
		const code = await codeOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request({
					...VPS_REQUEST,
					desired: { virtualMachineId: "999", password: "hunter2" },
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses setup without a public-key id rather than inventing access", async () => {
		const fake = fakeTransport(
			vpsApi([{ id: 999, hostname: null, state: "initial", ipv4: [] }]),
		);
		const code = await codeOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request({
					...VPS_REQUEST,
					desired: { virtualMachineId: "999" },
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("renames a provisioned machine adopted by id, and leaves its OS alone", async () => {
		const fake = fakeTransport(
			vpsApi([runningMachine({ id: 999, hostname: "old-name" })]),
		);
		const outcome = checked(
			await resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request({
					...VPS_REQUEST,
					desired: { template: "ubuntu-24-04", virtualMachineId: "999" },
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.hostname).toBe("api-1");
		expect(fake.calls.some((call) => call.path.endsWith("/setup"))).toBe(false);
		expect(outcome.diagnostics.join(" ")).toContain("wipes the disk");
	});

	it("reports a template drift rather than recreating the machine", async () => {
		const fake = fakeTransport(vpsApi([runningMachine()]));
		const outcome = checked(
			await resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request({ ...VPS_REQUEST, desired: { template: "debian-12" } }),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.diagnostics.join(" ")).toContain("wipes the disk");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("refuses when a hostname matches more than one machine", async () => {
		const fake = fakeTransport(
			vpsApi([runningMachine(), runningMachine({ id: 12346 })]),
		);
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request(VPS_REQUEST),
				fake.transport,
			),
		);
		expect(message).toContain("more than one machine");
	});

	it("refuses a virtualMachineId that is not in the account", async () => {
		const fake = fakeTransport(vpsApi());
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request({
					...VPS_REQUEST,
					desired: { virtualMachineId: "404", publicKeyId: 7 },
				}),
				fake.transport,
			),
		);
		expect(message).toContain("is not a machine in this account");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("read answers undefined for a machine that is not there", async () => {
		const fake = fakeTransport(vpsApi());
		await expect(
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).read(
				request(VPS_REQUEST),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("DNS zones converge", () => {
	it("makes no write when the zone already matches, key order aside", async () => {
		const fake = fakeTransport(
			dnsApi([
				{
					ttl: 300,
					records: [{ content: "203.0.113.9" }],
					type: "A",
					name: "@",
				},
			]),
		);
		const outcome = checked(
			await resolverFor(HOSTINGER_DNS_ZONE_PRODUCT_ID).reconcile(
				request(ZONE_REQUEST),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.outputs.recordTypes).toEqual(["A"]);
		expect(fake.mutating()).toHaveLength(0);
	});

	/**
	 * Hostinger's zone PUT drops any record the body omits, so the whole
	 * authored set is sent — a partial body would silently delete records.
	 */
	it("replaces the zone in full rather than patching it", async () => {
		const fake = fakeTransport(
			dnsApi([
				{
					name: "@",
					type: "A",
					ttl: 300,
					records: [{ content: "198.51.100.1" }],
				},
			]),
		);
		const outcome = checked(
			await resolverFor(HOSTINGER_DNS_ZONE_PRODUCT_ID).reconcile(
				request(ZONE_REQUEST),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		const put = fake.calls.find((call) => call.method === "PUT");
		if (put === undefined) {
			throw new Error("expected a PUT call");
		}
		expect(bodyOf(put).overwrite).toBe(true);
		expect(bodyOf(put).zone).toEqual(ZONE_RECORDS);
		expect(outcome.diagnostics.join(" ")).toContain("drops any record");
	});

	it("refuses to invent records", async () => {
		const fake = fakeTransport(dnsApi([]));
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_DNS_ZONE_PRODUCT_ID).reconcile(
				request({ ...ZONE_REQUEST, desired: {} }),
				fake.transport,
			),
		);
		expect(message).toContain("desired.records");
	});

	it("refuses a domain the account does not hold", async () => {
		const fake = fakeTransport(dnsApi(undefined));
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_DNS_ZONE_PRODUCT_ID).reconcile(
				request(ZONE_REQUEST),
				fake.transport,
			),
		);
		expect(message).toContain("not a domain in this Hostinger account");
		expect(fake.mutating()).toHaveLength(0);
	});

	it("resets the zone on remove and treats an absent domain as success", async () => {
		const fake = fakeTransport(dnsApi([]));
		await expect(
			resolverFor(HOSTINGER_DNS_ZONE_PRODUCT_ID).delete(
				request(ZONE_REQUEST),
				fake.transport,
			),
		).resolves.toBeUndefined();
		const absent = fakeTransport(dnsApi(undefined));
		await expect(
			resolverFor(HOSTINGER_DNS_ZONE_PRODUCT_ID).delete(
				request(ZONE_REQUEST),
				absent.transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("credentials are locators and never leak", () => {
	it("sends the token in exactly one place: the authorization header", async () => {
		const fake = fakeTransport(vpsApi([runningMachine()]));
		const outcome = checked(
			await resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request(VPS_REQUEST),
				fake.transport,
			),
		);
		for (const call of fake.calls) {
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(call.body ?? "").not.toContain(TOKEN);
			expect(call.path).not.toContain(TOKEN);
		}
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
	});

	it("refuses a credentialRef that is the token itself", async () => {
		const fake = fakeTransport(vpsApi());
		const code = await codeOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				parseResolveRequest({
					ref: {
						slot: "web",
						productId: HOSTINGER_VPS_PRODUCT_ID,
						logicalId: "api-1",
					},
					desired: { template: "ubuntu-24-04" },
					credentialRef: "a".repeat(40),
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses when the host resolves the locator to nothing", async () => {
		const fake = fakeTransport(vpsApi());
		const code = await codeOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID, {
				resolveCredential: async () => "",
			}).reconcile(request(VPS_REQUEST), fake.transport),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("redacts token-shaped text out of provider error messages", async () => {
		const fake = fakeTransport(() =>
			json(422, { message: `request ${LEAKED_TOKEN} was rejected` }),
		);
		const message = await messageOf(() =>
			resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
				request(VPS_REQUEST),
				fake.transport,
			),
		);
		expect(message).not.toContain(LEAKED_TOKEN);
		expect(message).toContain("[redacted]");
	});

	it("redactHostingerText truncates as well as scrubs", () => {
		expect(redactHostingerText(LEAKED_TOKEN)).toBe("[redacted]");
		const chatty = "x ".repeat(25);
		expect(redactHostingerText(chatty, 10)).toBe(`${chatty.slice(0, 10)}…`);
	});
});

describe("the transport guard bounds where a token can be sent", () => {
	it("refuses a host that is not developers.hostinger.com", async () => {
		const guarded = guardedHostingerTransport(async () => json(200, {}));
		await expect(
			guarded({
				method: "GET",
				url: "https://developers.hostinger.example/api/vps/v1/virtual-machines",
				headers: {},
			}),
		).rejects.toThrow();
	});

	it("refuses the billing namespace even on the right host", async () => {
		const guarded = guardedHostingerTransport(async () => json(200, {}));
		await expect(
			guarded({
				method: "POST",
				url: `https://${HOSTINGER_API_HOST}/api/billing/v1/orders`,
				headers: {},
			}),
		).rejects.toThrow();
	});

	it("keeps every real call on an allowlisted namespace", async () => {
		const fake = fakeTransport(vpsApi([runningMachine()]));
		await resolverFor(HOSTINGER_VPS_PRODUCT_ID).reconcile(
			request(VPS_REQUEST),
			fake.transport,
		);
		for (const call of fake.calls) {
			expect(call.host).toBe(HOSTINGER_API_HOST);
			expect(
				HOSTINGER_ALLOWED_PATH_PREFIXES.some((prefix) =>
					call.path.startsWith(prefix),
				),
			).toBe(true);
		}
	});
});
