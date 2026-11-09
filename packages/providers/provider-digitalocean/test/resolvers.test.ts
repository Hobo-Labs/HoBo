/**
 * DigitalOcean resolver tests, driven entirely through an injected fake
 * `HttpTransport`.
 *
 * The fake is the whole provider: that is what lets a test assert "reconcile
 * twice made exactly one create call" at all, which is the property the
 * resolvers exist to have. Nothing here touches a network, a credential, or a
 * DigitalOcean account — see the HONEST SCOPE section of `src/resolvers.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	HttpTransport,
	ResolveOutcome,
	ResolveRequest,
	ResourceResolver,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	parseResolveOutcome,
	parseResolveRequest,
	ResolverError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	DIGITALOCEAN_API_HOST,
	DIGITALOCEAN_APP_JOB_PRODUCT_ID,
	DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
	DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
	DIGITALOCEAN_DEFAULT_BINDINGS,
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
	DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
	DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
	DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID,
	DIGITALOCEAN_RESOLVED_PRODUCT_IDS,
	DIGITALOCEAN_SPACES_PRODUCT_ID,
	DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS,
	type DigitalOceanResolverOptions,
	digitaloceanResolverRegistry,
	digitaloceanResolvers,
	guardedDigitalOceanTransport,
	guardedSpacesTransport,
	redactDigitalOceanText,
} from "../src/index.js";
import {
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/provider-digitalocean-boundary.pact.json"),
		"utf8",
	),
);

const CREDENTIAL_REF = "env://DIGITALOCEAN_TOKEN";
/** A token-shaped PAT. Never expected anywhere but one header. */
const TOKEN = "dop_v1_fakepersonalaccesstoken0123456789abcdef";
// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
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
	countOf(method: string, path: string): number;
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

function noContent(): TransportResponse {
	return { status: 204, headers: {}, body: "" };
}

function unexpected(call: RecordedCall): TransportResponse {
	return json(500, {
		id: "internal",
		message: `the fake received an unexpected ${call.method} ${call.path}${call.search}`,
	});
}

function bodyOf(call: RecordedCall): Rec {
	return call.body === undefined ? {} : parseJsonObject(call.body);
}

/** A Spaces key pair. Never the control-plane token — that is the point. */
const SPACES_KEYS = Object.freeze({
	accessKeyId: "DO00FAKEACCESSKEYID12",
	secretAccessKey: "fake-spaces-secret-access-key-0123456789",
});

/** A fixed signing instant, so a SigV4 signature is reproducible in a test. */
const NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");

function options(
	overrides: Partial<DigitalOceanResolverOptions> = {},
): DigitalOceanResolverOptions {
	return {
		resolveCredential: async () => TOKEN,
		resolveSpacesCredential: async () => SPACES_KEYS,
		nowMs: NOW_MS,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<DigitalOceanResolverOptions> = {},
): ResourceResolver {
	const resolver = digitaloceanResolverRegistry(options(overrides)).get(
		productId,
	);
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
// Fake DigitalOcean services
// ---------------------------------------------------------------------------

const DATABASES = "/v2/databases";
const DROPLETS = "/v2/droplets";
const LOAD_BALANCERS = "/v2/load_balancers";
const APPS = "/v2/apps";

/** A `/v2/databases` account holding zero or more clusters. */
function databaseApi(
	initial: Rec[] = [],
): (call: RecordedCall) => TransportResponse {
	let clusters = [...initial];
	let nextId = initial.length + 1;
	return (call) => {
		if (call.method === "GET" && call.path === DATABASES) {
			return json(200, {
				databases: clusters,
				meta: { total: clusters.length },
			});
		}
		if (call.method === "GET" && call.path.startsWith(`${DATABASES}/`)) {
			const id = decodeURIComponent(call.path.slice(DATABASES.length + 1));
			const found = clusters.find((cluster) => cluster.id === id);
			return found === undefined
				? json(404, { id: "not_found" })
				: json(200, { database: found });
		}
		if (call.method === "POST" && call.path === DATABASES) {
			const sent = bodyOf(call);
			const created = {
				id: `db-${nextId++}`,
				name: sent.name,
				engine: sent.engine,
				version: sent.version ?? "16",
				region: sent.region,
				size: sent.size,
				num_nodes: sent.num_nodes ?? 1,
				status: "creating",
				connection: {
					host: `${String(sent.name)}.db.ondigitalocean.com`,
					port: 25060,
					database: "defaultdb",
					user: "doadmin",
					uri: "postgresql://doadmin:SUPERSECRETPASSWORD@host:25060/defaultdb",
				},
			};
			clusters.push(created);
			return json(201, { database: created });
		}
		if (call.method === "PUT" && call.path.endsWith("/resize")) {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const id = call.path.split("/")[3] as string;
			clusters = clusters.map((cluster) =>
				cluster.id === id
					? {
							...cluster,
							size: bodyOf(call).size,
							num_nodes: bodyOf(call).num_nodes,
							status: "resizing",
						}
					: cluster,
			);
			return json(202, {});
		}
		if (call.method === "DELETE" && call.path.startsWith(`${DATABASES}/`)) {
			const id = call.path.slice(DATABASES.length + 1);
			clusters = clusters.filter((cluster) => cluster.id !== id);
			return noContent();
		}
		return unexpected(call);
	};
}

function dropletApi(
	initial: Rec[] = [],
): (call: RecordedCall) => TransportResponse {
	let droplets = [...initial];
	let nextId = 100 + initial.length;
	return (call) => {
		if (call.method === "GET" && call.path === DROPLETS) {
			return json(200, { droplets, meta: { total: droplets.length } });
		}
		if (call.method === "POST" && call.path === DROPLETS) {
			const sent = bodyOf(call);
			const created = {
				id: nextId++,
				name: sent.name,
				status: "new",
				size_slug: sent.size,
				region: { slug: sent.region },
				networks: { v4: [] },
			};
			droplets.push(created);
			return json(202, { droplet: created });
		}
		if (call.method === "DELETE" && call.path.startsWith(`${DROPLETS}/`)) {
			const id = Number(call.path.slice(DROPLETS.length + 1));
			droplets = droplets.filter((entry) => entry.id !== id);
			return noContent();
		}
		return unexpected(call);
	};
}

function loadBalancerApi(
	initial: Rec[] = [],
): (call: RecordedCall) => TransportResponse {
	let balancers = [...initial];
	let nextId = initial.length + 1;
	return (call) => {
		if (call.method === "GET" && call.path === LOAD_BALANCERS) {
			return json(200, {
				load_balancers: balancers,
				meta: { total: balancers.length },
			});
		}
		if (call.method === "POST" && call.path === LOAD_BALANCERS) {
			const sent = bodyOf(call);
			const created = {
				id: `lb-${nextId++}`,
				name: sent.name,
				ip: "203.0.113.10",
				status: "new",
				algorithm: sent.algorithm ?? "round_robin",
				redirect_http_to_https: sent.redirect_http_to_https ?? false,
				region: { slug: sent.region },
				forwarding_rules: sent.forwarding_rules,
			};
			balancers.push(created);
			return json(202, { load_balancer: created });
		}
		if (call.method === "PUT" && call.path.startsWith(`${LOAD_BALANCERS}/`)) {
			const id = call.path.slice(LOAD_BALANCERS.length + 1);
			const sent = bodyOf(call);
			balancers = balancers.map((entry) =>
				entry.id === id
					? {
							...entry,
							algorithm: sent.algorithm ?? entry.algorithm,
							redirect_http_to_https:
								sent.redirect_http_to_https ?? entry.redirect_http_to_https,
							status: "active",
						}
					: entry,
			);
			const updated = balancers.find((entry) => entry.id === id);
			return json(200, { load_balancer: updated });
		}
		if (
			call.method === "DELETE" &&
			call.path.startsWith(`${LOAD_BALANCERS}/`)
		) {
			const id = call.path.slice(LOAD_BALANCERS.length + 1);
			balancers = balancers.filter((entry) => entry.id !== id);
			return noContent();
		}
		return unexpected(call);
	};
}

function appApi(
	initial: Rec[] = [],
): (call: RecordedCall) => TransportResponse {
	let apps = [...initial];
	let nextId = initial.length + 1;
	return (call) => {
		if (call.method === "GET" && call.path === APPS) {
			return json(200, { apps, meta: { total: apps.length } });
		}
		if (call.method === "POST" && call.path === APPS) {
			const sent = bodyOf(call);
			const created = {
				id: `app-${nextId++}`,
				spec: sent.spec,
				live_url: undefined,
				active_deployment: { phase: "PENDING_BUILD" },
			};
			apps.push(created);
			return json(201, { app: created });
		}
		if (call.method === "PUT" && call.path.startsWith(`${APPS}/`)) {
			const id = call.path.slice(APPS.length + 1);
			const sent = bodyOf(call);
			apps = apps.map((entry) =>
				entry.id === id ? { ...entry, spec: sent.spec } : entry,
			);
			return json(200, { app: apps.find((entry) => entry.id === id) });
		}
		if (call.method === "DELETE" && call.path.startsWith(`${APPS}/`)) {
			const id = call.path.slice(APPS.length + 1);
			apps = apps.filter((entry) => entry.id !== id);
			return noContent();
		}
		return unexpected(call);
	};
}

const POSTGRES_REQUEST = {
	slot: "data",
	productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
	logicalId: "ledger",
	desired: { region: "nyc3", size: "db-s-1vcpu-1gb" },
} as const;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App Platform components
// ---------------------------------------------------------------------------

const APPS_PATH = "/v2/apps";
const APP_NAME = "shop";
const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const WORKER_COMPONENT = Object.freeze({
	image: { registry_type: "DOCR", repository: "worker", tag: "v1" },
	instance_size_slug: "apps-s-1vcpu-1gb",
	instance_count: 2,
});

/** An app carrying whatever components the test wants, plus a sibling service. */
function appRecord(spec: Rec = {}): Rec {
	return {
		id: APP_ID,
		live_url: `https://${APP_NAME}.ondigitalocean.app`,
		active_deployment: { phase: "ACTIVE" },
		spec: {
			name: APP_NAME,
			region: "nyc",
			// A sibling nobody in these tests owns. It must survive every write.
			services: [{ name: "web", instance_count: 1 }],
			...spec,
		},
	};
}

function componentRequest(
	productId: string,
	logicalId: string,
	desired: Rec = {},
): ResolveRequest {
	return request({
		slot: "service",
		productId,
		logicalId,
		desired: {
			appName: APP_NAME,
			component: WORKER_COMPONENT,
			...desired,
		},
	});
}

/** A DigitalOcean account with one app, whose spec the fake keeps. */
function appWorld(initial: Rec = {}): Fake {
	let app = appRecord(initial);
	return fakeTransport((call) => {
		if (call.method === "GET" && call.path === APPS_PATH) {
			return json(200, { apps: [app], meta: { total: 1 } });
		}
		if (call.method === "PUT" && call.path === `${APPS_PATH}/${APP_ID}`) {
			app = { ...app, spec: bodyOf(call).spec };
			return json(200, { app });
		}
		return unexpected(call);
	});
}

/** An account with no app at all. */
function emptyWorld(): Fake {
	return fakeTransport((call) =>
		call.method === "GET" && call.path === APPS_PATH
			? json(200, { apps: [], meta: { total: 0 } })
			: unexpected(call),
	);
}

function specOf(fake: Fake): Rec {
	const writes = fake.calls.filter((call) => call.method === "PUT");
	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	return bodyOf(writes[writes.length - 1] as RecordedCall).spec as Rec;
}

describe("App Platform components converge inside the app that owns them", () => {
	it.each([
		["worker", DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "workers"],
		["job", DIGITALOCEAN_APP_JOB_PRODUCT_ID, "jobs"],
	] as const)("adds a %s to an existing app", async (noun, productId, key) => {
		const fake = appWorld();
		const resolver = resolverFor(productId);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(
				componentRequest(productId, `${noun}-one`),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(`${APP_ID}/${key}/${noun}-one`);
		expect(outcome.outputs.componentKind).toBe(noun);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const written = specOf(fake)[key] as Rec[];
		expect(written.map((item) => item.name)).toEqual([`${noun}-one`]);
	});

	/** The property the whole design exists to have. */
	it("reconciles twice into one component and one write", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		const first = await resolver.reconcile(
			componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
			fake.transport,
		);
		const second = parseResolveOutcome(
			await resolver.reconcile(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
				fake.transport,
			),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(fake.countOf("PUT", `${APPS_PATH}/${APP_ID}`)).toBe(1);
	});

	/**
	 * The load-bearing rule. A component resolver rewrites the whole spec, so
	 * everything it does not own has to survive the round trip — otherwise
	 * adding a worker would silently delete the app's services.
	 */
	it("carries every part of the spec it does not own through the write", async () => {
		const fake = appWorld({
			databases: [{ name: "db", engine: "PG" }],
			domains: [{ domain: "shop.example" }],
		});
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		await resolver.reconcile(
			componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
			fake.transport,
		);
		const spec = specOf(fake);
		expect(spec.name).toBe(APP_NAME);
		expect(spec.region).toBe("nyc");
		expect(spec.services).toEqual([{ name: "web", instance_count: 1 }]);
		expect(spec.databases).toEqual([{ name: "db", engine: "PG" }]);
		expect(spec.domains).toEqual([{ domain: "shop.example" }]);
	});

	it("leaves a sibling component of the same kind alone", async () => {
		const fake = appWorld({
			workers: [{ name: "other-worker", instance_count: 5 }],
		});
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		await resolver.reconcile(
			componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
			fake.transport,
		);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const workers = specOf(fake).workers as Rec[];
		expect(workers.map((item) => item.name).sort()).toEqual([
			"other-worker",
			"worker-one",
		]);
		expect(workers.find((item) => item.name === "other-worker")).toEqual({
			name: "other-worker",
			instance_count: 5,
		});
	});

	it("updates a component in place when its body changed", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		await resolver.reconcile(
			componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
			fake.transport,
		);
		const scaled = parseResolveOutcome(
			await resolver.reconcile(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one", {
					component: { ...WORKER_COMPONENT, instance_count: 4 },
				}),
				fake.transport,
			),
		);
		expect(scaled.action).toBe("update");
		expect(scaled.outputs.instanceCount).toBe(4);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const workers = specOf(fake).workers as Rec[];
		expect(workers).toHaveLength(1);
	});

	/**
	 * The refusal that keeps this resolver from racing the one that owns the
	 * app. A component cannot bring an app into being.
	 */
	it("refuses to create the app it would live in", async () => {
		const fake = emptyWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		const message = await messageOf(() =>
			resolver.reconcile(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
				fake.transport,
			),
		);
		expect(message).toContain("app-platform-service");
		expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	});

	it("refuses a request that names no app", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		const bare = request({
			slot: "service",
			productId: DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
			logicalId: "worker-one",
			desired: { component: WORKER_COMPONENT },
		});
		expect(await codeOf(() => resolver.reconcile(bare, fake.transport))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("refuses a request that carries no component body", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		const bare = request({
			slot: "service",
			productId: DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
			logicalId: "worker-one",
			desired: { appName: APP_NAME },
		});
		expect(await codeOf(() => resolver.reconcile(bare, fake.transport))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("says out loud that concurrent component writes would race", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
				fake.transport,
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("read-modify-write");
	});

	it("removes only its own component, leaving the app standing", async () => {
		const fake = appWorld({
			workers: [{ name: "other-worker", instance_count: 5 }],
		});
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		await resolver.reconcile(
			componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
			fake.transport,
		);
		await resolver.delete(
			componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
			fake.transport,
		);
		const spec = specOf(fake);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		expect((spec.workers as Rec[]).map((item) => item.name)).toEqual([
			"other-worker",
		]);
		expect(spec.services).toEqual([{ name: "web", instance_count: 1 }]);
		// Never the app itself.
		expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(
			0,
		);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats an already-absent component as a successful delete", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		await expect(
			resolver.delete(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
				fake.transport,
			),
		).resolves.toBeUndefined();
		expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats a missing app as an already-successful delete", async () => {
		const fake = emptyWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		await expect(
			resolver.delete(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});

	it("reads back nothing when the component is not in the app", async () => {
		const fake = appWorld();
		const resolver = resolverFor(DIGITALOCEAN_APP_WORKER_PRODUCT_ID);
		expect(
			await resolver.read(
				componentRequest(DIGITALOCEAN_APP_WORKER_PRODUCT_ID, "worker-one"),
				fake.transport,
			),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

const NAMESPACE_ID = "cccccccc-dddd-eeee-ffff-000000000000";
const NAMESPACE = "fn-cccccccc-dddd-eeee-ffff-000000000000";
const FAAS_HOST = "faas-nyc1-2ef2e6cc.doserverless.co";
const NAMESPACE_PATH = `/v2/functions/namespaces/${NAMESPACE_ID}`;
const ACTION_PATH = `/api/v1/namespaces/${NAMESPACE}/actions/greet`;
/** The namespace key is material: it belongs in one header and nowhere else. */
const NAMESPACE_KEY = "d1zcd455h01mqjfs4s2eaewyejehi5f2uj4etqq3h7cera8iwkub";

const ACTION = Object.freeze({
	exec: Object.freeze({
		kind: "nodejs:default",
		code: "function main(){return{body:'hi'}}",
	}),
	limits: Object.freeze({ timeout: 3000, memory: 256 }),
	annotations: Object.freeze([
		Object.freeze({ key: "web-export", value: true }),
	]),
});

function namespaceRecord(): Rec {
	return {
		namespace: {
			api_host: `https://${FAAS_HOST}`,
			namespace: NAMESPACE,
			uuid: NAMESPACE_ID,
			key: NAMESPACE_KEY,
			label: "prod",
			region: "nyc1",
		},
	};
}

/** What OpenWhisk answers with: what was sent, plus fields it owns. */
function actionRecord(sent: Rec): Rec {
	return {
		name: "greet",
		namespace: NAMESPACE,
		version: "0.0.1",
		publish: false,
		updated: 1_755_600_000_000,
		exec: sent.exec,
		limits: sent.limits,
		parameters: [],
		annotations: [
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			...((sent.annotations as Rec[] | undefined) ?? []),
			// Platform-added: must not read as drift.
			{ key: "exec", value: "nodejs:20" },
			{ key: "provide-api-key", value: false },
		],
	};
}

function functionRequest(desired: Rec = {}): ResolveRequest {
	return request({
		slot: "service",
		productId: DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		logicalId: "greet",
		desired: { namespaceId: NAMESPACE_ID, action: ACTION, ...desired },
	});
}

/** A namespace that starts with no action and keeps whatever is PUT to it. */
function functionsWorld(): Fake {
	let stored: Rec | undefined;
	return fakeTransport((call) => {
		if (call.method === "GET" && call.path === NAMESPACE_PATH) {
			return json(200, namespaceRecord());
		}
		if (call.method === "GET" && call.path === ACTION_PATH) {
			return stored === undefined
				? json(404, { error: "The requested resource does not exist." })
				: json(200, stored);
		}
		if (call.method === "PUT" && call.path === ACTION_PATH) {
			stored = actionRecord(bodyOf(call));
			return json(200, stored);
		}
		if (call.method === "DELETE" && call.path === ACTION_PATH) {
			stored = undefined;
			return json(200, { name: "greet" });
		}
		return unexpected(call);
	});
}

describe("the Functions resolver converges an action on its namespace host", () => {
	it("creates a function that is not there", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(functionRequest(), fake.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(`${NAMESPACE}/greet`);
		expect(outcome.outputs.runtime).toBe("nodejs:default");
		expect(outcome.outputs.url).toContain(`https://${FAAS_HOST}/api/v1/web/`);
	});

	/**
	 * The property the whole design exists to have, and the one an earlier
	 * revision said was unobtainable here. `PUT ?overwrite=true` is
	 * create-or-replace, so the second pass finds the action equal and writes
	 * nothing.
	 */
	it("reconciles twice into one function and one write", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		const first = await resolver.reconcile(functionRequest(), fake.transport);
		const second = parseResolveOutcome(
			await resolver.reconcile(functionRequest(), fake.transport),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(fake.countOf("PUT", ACTION_PATH)).toBe(1);
	});

	it("writes with overwrite=true, which is what makes the PUT convergent", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await resolver.reconcile(functionRequest(), fake.transport);
		const put = fake.calls.find((call) => call.method === "PUT");
		expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			new URLSearchParams((put as RecordedCall).search).get("overwrite"),
		).toBe("true");
	});

	/**
	 * The two credentials never cross. The personal access token addresses the
	 * control plane; the namespace key addresses the namespace host.
	 */
	it("keeps the control-plane token off the namespace host, and the key off the control plane", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await resolver.reconcile(functionRequest(), fake.transport);
		const controlPlane = fake.calls.filter(
			(call) => call.host === "api.digitalocean.com",
		);
		const namespaceHost = fake.calls.filter((call) => call.host === FAAS_HOST);
		expect(controlPlane.length).toBeGreaterThan(0);
		expect(namespaceHost.length).toBeGreaterThan(0);
		for (const call of controlPlane) {
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(JSON.stringify(call)).not.toContain(NAMESPACE_KEY);
		}
		for (const call of namespaceHost) {
			expect(call.headers.authorization).toMatch(/^Basic /u);
			expect(call.headers.authorization).not.toContain(TOKEN);
		}
	});

	it("never publishes the namespace key", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(functionRequest(), fake.transport),
		);
		expect(JSON.stringify(outcome.outputs)).not.toContain(NAMESPACE_KEY);
		expect(JSON.stringify(outcome.diagnostics)).not.toContain(NAMESPACE_KEY);
		for (const call of fake.calls) {
			expect(`${call.path}${call.search}`).not.toContain(NAMESPACE_KEY);
		}
	});

	/** Platform-added annotations are not drift, or every pass would re-PUT. */
	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("does not read the platform's own annotations as drift", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await resolver.reconcile(functionRequest(), fake.transport);
		await resolver.reconcile(functionRequest(), fake.transport);
		await resolver.reconcile(functionRequest(), fake.transport);
		expect(fake.countOf("PUT", ACTION_PATH)).toBe(1);
	});

	it("rewrites the action when the code actually changed", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await resolver.reconcile(functionRequest(), fake.transport);
		const changed = parseResolveOutcome(
			await resolver.reconcile(
				functionRequest({
					action: {
						...ACTION,
						exec: {
							...ACTION.exec,
							code: "function main(){return{body:'yo'}}",
						},
					},
				}),
				fake.transport,
			),
		);
		expect(changed.action).toBe("update");
		expect(fake.countOf("PUT", ACTION_PATH)).toBe(2);
	});

	it("refuses a request that names no namespace", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		const bare = request({
			slot: "service",
			productId: DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
			logicalId: "greet",
			desired: { action: ACTION },
		});
		expect(await codeOf(() => resolver.reconcile(bare, fake.transport))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses a request that carries no exec block", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		expect(
			await codeOf(() =>
				resolver.reconcile(
					functionRequest({ action: { limits: { memory: 256 } } }),
					fake.transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	});

	it("refuses to create the namespace it would live in", async () => {
		const fake = fakeTransport((call) =>
			call.method === "GET" && call.path === NAMESPACE_PATH
				? json(404, { id: "not_found", message: "namespace not found" })
				: unexpected(call),
		);
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		const message = await messageOf(() =>
			resolver.reconcile(functionRequest(), fake.transport),
		);
		expect(message).toContain("billed and region-pinned");
		expect(fake.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
	});

	/**
	 * The namespace host is not a constant, so the guard cannot allowlist it
	 * ahead of time. It comes from DigitalOcean's own control plane, and a host
	 * that is not shaped like a Functions host is refused rather than dialled
	 * with the namespace's credentials.
	 */
	it("refuses a control-plane answer pointing somewhere that is not a Functions host", async () => {
		const fake = fakeTransport((call) =>
			call.method === "GET" && call.path === NAMESPACE_PATH
				? json(200, {
						namespace: {
							// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
							...(namespaceRecord().namespace as Rec),
							api_host: "https://evil.example.com",
						},
					})
				: unexpected(call),
		);
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await expect(
			resolver.reconcile(functionRequest(), fake.transport),
		).rejects.toThrow(/doserverless/u);
		expect(
			fake.calls.every((call) => call.host === "api.digitalocean.com"),
		).toBe(true);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats an already-absent function as a successful delete", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await expect(
			resolver.delete(functionRequest(), fake.transport),
		).resolves.toBeUndefined();
	});

	it("deletes a function it created, and reads back absent afterwards", async () => {
		const fake = functionsWorld();
		const resolver = resolverFor(DIGITALOCEAN_FUNCTIONS_PRODUCT_ID);
		await resolver.reconcile(functionRequest(), fake.transport);
		await resolver.delete(functionRequest(), fake.transport);
		expect(
			await resolver.read(functionRequest(), fake.transport),
		).toBeUndefined();
	});
});

describe("the registry covers exactly the products that can converge", () => {
	it("registers a resolver for every resolved product id", () => {
		const registry = digitaloceanResolverRegistry(options());
		for (const productId of DIGITALOCEAN_RESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)?.productId).toBe(productId);
		}
	});

	it("registers nothing for a product with no convergent path", () => {
		const registry = digitaloceanResolverRegistry(options());
		for (const productId of DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)).toBeUndefined();
		}
		expect(DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS).toEqual([]);
	});

	it("accounts for every catalogued product exactly once", () => {
		const catalogued = new Set(
			Object.values(DIGITALOCEAN_DEFAULT_BINDINGS)
				.flatMap((entries) => [...(entries ?? [])])
				.flatMap((entry) =>
					entry.productId === undefined ? [] : [entry.productId],
				),
		);
		const accounted = [
			...DIGITALOCEAN_RESOLVED_PRODUCT_IDS,
			...DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS,
		].sort();
		expect(accounted).toEqual([...catalogued].sort());
		expect(new Set(accounted).size).toBe(accounted.length);
	});

	it("lists resolvers in id order, not construction order", () => {
		const ids = digitaloceanResolvers(options()).map(
			(resolver) => resolver.productId,
		);
		expect(ids).toEqual([...ids].sort());
	});

	it("stamps the provider target on every resolver", () => {
		for (const resolver of digitaloceanResolvers(options())) {
			expect(resolver.providerId).toBe("digitalocean");
		}
	});
});

describe("managed databases converge", () => {
	it("creates a cluster that is absent, then makes no second create", async () => {
		const fake = fakeTransport(databaseApi());
		const resolver = resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID);
		const first = checked(
			await resolver.reconcile(request(POSTGRES_REQUEST), fake.transport),
		);
		const second = checked(
			await resolver.reconcile(request(POSTGRES_REQUEST), fake.transport),
		);

		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", DATABASES)).toBe(1);
	});

	it("matches the reconcile-twice interaction the pact records", async () => {
		const interaction = pact.interactions.find(
			(entry: { description: string }) =>
				entry.description ===
				"reconcile a managed postgres cluster twice: one create call, one stable physicalId",
		);
		const fake = fakeTransport(databaseApi());
		const resolver = resolverFor(interaction.request.body.productId);
		const first = checked(
			await resolver.reconcile(
				request({
					slot: "data",
					productId: interaction.request.body.productId,
					logicalId: interaction.request.body.logicalId,
					desired: interaction.request.body.desired,
				}),
				fake.transport,
			),
		);
		const second = checked(
			await resolver.reconcile(
				request({
					slot: "data",
					productId: interaction.request.body.productId,
					logicalId: interaction.request.body.logicalId,
					physicalId: first.physicalId,
					desired: interaction.request.body.desired,
				}),
				fake.transport,
			),
		);
		expect(first.contract).toBe(interaction.response.body.contract);
		expect(first.action).toBe(interaction.response.body.action);
		expect(fake.countOf("POST", DATABASES)).toBe(
			interaction.response.body.createCalls,
		);
		expect(second.action).toBe(interaction.response.body.reconcileTwiceAction);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("reports 'creating' as accepted, not confirmed", async () => {
		const fake = fakeTransport(databaseApi());
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
				request(POSTGRES_REQUEST),
				fake.transport,
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("accepted, not confirmed");
	});

	it("never puts the connection URI (which carries the password) in outputs", async () => {
		const fake = fakeTransport(databaseApi());
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
				request(POSTGRES_REQUEST),
				fake.transport,
			),
		);
		expect(JSON.stringify(outcome.outputs)).not.toContain("SUPERSECRET");
		expect("uri" in outcome.outputs).toBe(false);
		expect(outcome.outputs.host).toBe("ledger.db.ondigitalocean.com");
	});

	it("resizes an existing cluster rather than replacing it", async () => {
		const fake = fakeTransport(
			databaseApi([
				{
					id: "db-1",
					name: "ledger",
					engine: "pg",
					region: "nyc3",
					size: "db-s-1vcpu-1gb",
					num_nodes: 1,
					status: "online",
					connection: { host: "ledger.db.ondigitalocean.com", port: 25060 },
				},
			]),
		);
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
				request({
					...POSTGRES_REQUEST,
					desired: { region: "nyc3", size: "db-s-2vcpu-4gb" },
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(fake.countOf("POST", DATABASES)).toBe(0);
		expect(
			fake.calls.some(
				(call) => call.method === "PUT" && call.path.endsWith("/resize"),
			),
		).toBe(true);
	});

	it("reports an immutable region drift instead of destroying the data", async () => {
		const fake = fakeTransport(
			databaseApi([
				{
					id: "db-1",
					name: "ledger",
					engine: "pg",
					region: "ams3",
					size: "db-s-1vcpu-1gb",
					num_nodes: 1,
					status: "online",
					connection: {},
				},
			]),
		);
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).read(
				request(POSTGRES_REQUEST),
				fake.transport,
			),
		);
		expect(outcome?.action).not.toBe("replace");
		expect(outcome?.diagnostics.join(" ")).toContain("immutable");
	});

	it("routes valkey through the same collection with its own engine slug", async () => {
		const fake = fakeTransport(databaseApi());
		await resolverFor(DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID).reconcile(
			request({
				slot: "kv",
				productId: DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID,
				logicalId: "hot",
				desired: { region: "nyc3", size: "db-s-1vcpu-1gb" },
			}),
			fake.transport,
		);
		const create = fake.calls.find(
			(call) => call.method === "POST" && call.path === DATABASES,
		);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		expect(bodyOf(create as RecordedCall).engine).toBe("valkey");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("deletes what exists and treats already-gone as success", async () => {
		const fake = fakeTransport(
			databaseApi([
				{
					id: "db-1",
					name: "ledger",
					engine: "pg",
					region: "nyc3",
					size: "db-s-1vcpu-1gb",
					status: "online",
					connection: {},
				},
			]),
		);
		const resolver = resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID);
		await resolver.delete(request(POSTGRES_REQUEST), fake.transport);
		await expect(
			resolver.delete(request(POSTGRES_REQUEST), fake.transport),
		).resolves.toBeUndefined();
		expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(
			1,
		);
	});

	it("read answers undefined for a cluster that is not there", async () => {
		const fake = fakeTransport(databaseApi());
		await expect(
			resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).read(
				request(POSTGRES_REQUEST),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("a name that matches twice is refused, never guessed", () => {
	it("refuses rather than picking the first record", async () => {
		const twin = {
			id: "db-1",
			name: "ledger",
			engine: "pg",
			region: "nyc3",
			size: "db-s-1vcpu-1gb",
			status: "online",
			connection: {},
		};
		const fake = fakeTransport(databaseApi([twin, { ...twin, id: "db-2" }]));
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
				request(POSTGRES_REQUEST),
				fake.transport,
			),
		);
		expect(message).toContain("more than one record");
		expect(fake.countOf("POST", DATABASES)).toBe(0);
	});
});

describe("droplets", () => {
	const dropletRequest = {
		slot: "web",
		productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
		logicalId: "edge-1",
		desired: {
			region: "nyc3",
			size: "s-1vcpu-1gb",
			image: "ubuntu-24-04-x64",
		},
	} as const;

	it("creates once and adopts thereafter", async () => {
		const fake = fakeTransport(dropletApi());
		const resolver = resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID);
		const first = checked(
			await resolver.reconcile(request(dropletRequest), fake.transport),
		);
		const second = checked(
			await resolver.reconcile(request(dropletRequest), fake.transport),
		);
		expect(first.action).toBe("create");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", DROPLETS)).toBe(1);
	});

	it("refuses to invent an image, because an unrequested OS is not a default", async () => {
		const fake = fakeTransport(dropletApi());
		const code = await codeOf(() =>
			resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID).reconcile(
				request({
					...dropletRequest,
					desired: { region: "nyc3", size: "s-1vcpu-1gb" },
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(fake.countOf("POST", DROPLETS)).toBe(0);
	});

	it("refuses to invent a region, because placement is a residency decision", async () => {
		const fake = fakeTransport(dropletApi());
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID).reconcile(
				request({
					...dropletRequest,
					desired: { size: "s-1vcpu-1gb", image: "ubuntu-24-04-x64" },
				}),
				fake.transport,
			),
		);
		expect(message).toContain("residency");
	});

	it("reports a size drift rather than powering off a running machine", async () => {
		const fake = fakeTransport(
			dropletApi([
				{
					id: 101,
					name: "edge-1",
					status: "active",
					size_slug: "s-1vcpu-1gb",
					region: { slug: "nyc3" },
					networks: {
						v4: [{ type: "public", ip_address: "203.0.113.7" }],
					},
				},
			]),
		);
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_DROPLET_PRODUCT_ID).reconcile(
				request({
					...dropletRequest,
					desired: {
						region: "nyc3",
						size: "s-2vcpu-4gb",
						image: "ubuntu-24-04-x64",
					},
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.outputs.publicIpv4).toBe("203.0.113.7");
		expect(outcome.diagnostics.join(" ")).toContain("power-off");
	});
});

describe("load balancers", () => {
	const lbRequest = {
		slot: "api",
		productId: DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
		logicalId: "public-lb",
		desired: { region: "nyc3" },
	} as const;

	it("creates with a stated default forwarding rule", async () => {
		const fake = fakeTransport(loadBalancerApi());
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID).reconcile(
				request(lbRequest),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("create");
		const create = fake.calls.find(
			(call) => call.method === "POST" && call.path === LOAD_BALANCERS,
		);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		expect(bodyOf(create as RecordedCall).forwarding_rules).toEqual([
			{
				entry_protocol: "http",
				entry_port: 80,
				target_protocol: "http",
				target_port: 80,
			},
		]);
	});

	it("sends the whole body on update, because DigitalOcean's PUT is a replace", async () => {
		const fake = fakeTransport(
			loadBalancerApi([
				{
					id: "lb-1",
					name: "public-lb",
					ip: "203.0.113.10",
					status: "active",
					algorithm: "round_robin",
					redirect_http_to_https: false,
					region: { slug: "nyc3" },
					forwarding_rules: [],
				},
			]),
		);
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID).reconcile(
				request({
					...lbRequest,
					desired: { region: "nyc3", algorithm: "least_connections" },
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		const put = fake.calls.find((call) => call.method === "PUT");
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const body = bodyOf(put as RecordedCall);
		expect(body.algorithm).toBe("least_connections");
		expect(body.forwarding_rules).toBeDefined();
		expect(body.region).toBe("nyc3");
	});
});

describe("App Platform apps", () => {
	const appRequest = {
		slot: "web",
		productId: DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
		logicalId: "storefront",
		desired: {
			spec: {
				region: "nyc",
				services: [{ name: "web", instance_size_slug: "basic-xxs" }],
			},
		},
	} as const;

	it("creates the app and forces the spec name to the resolver's name", async () => {
		const fake = fakeTransport(appApi());
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_APP_SERVICE_PRODUCT_ID).reconcile(
				request(appRequest),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("create");
		const create = fake.calls.find(
			(call) => call.method === "POST" && call.path === APPS,
		);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		expect((bodyOf(create as RecordedCall).spec as Rec).name).toBe(
			"storefront",
		);
	});

	it("makes no update call when the spec already matches, key order aside", async () => {
		const fake = fakeTransport(
			appApi([
				{
					id: "app-1",
					spec: {
						services: [{ instance_size_slug: "basic-xxs", name: "web" }],
						name: "storefront",
						region: "nyc",
					},
					live_url: "https://storefront.ondigitalocean.app",
					active_deployment: { phase: "ACTIVE" },
				},
			]),
		);
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_APP_SERVICE_PRODUCT_ID).reconcile(
				request(appRequest),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.outputs.url).toBe("https://storefront.ondigitalocean.app");
		expect(outcome.diagnostics).toEqual([]);
		expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
	});

	it("refuses to invent a spec", async () => {
		const fake = fakeTransport(appApi());
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_APP_SERVICE_PRODUCT_ID).reconcile(
				request({ ...appRequest, desired: {} }),
				fake.transport,
			),
		);
		expect(message).toContain("desired.spec");
	});
});

describe("credentials are locators and never leak", () => {
	it("sends the token in exactly one place: the authorization header", async () => {
		const fake = fakeTransport(databaseApi());
		const outcome = checked(
			await resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
				request(POSTGRES_REQUEST),
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
		const fake = fakeTransport(databaseApi());
		const resolver = resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID);
		const code = await codeOf(() =>
			resolver.reconcile(
				parseResolveRequest({
					ref: {
						slot: "data",
						productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
						logicalId: "ledger",
					},
					desired: { region: "nyc3", size: "db-s-1vcpu-1gb" },
					credentialRef: `dop_v1_${"a".repeat(40)}`,
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses when the host resolves the locator to nothing", async () => {
		const fake = fakeTransport(databaseApi());
		const code = await codeOf(() =>
			resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID, {
				resolveCredential: async () => "",
			}).reconcile(request(POSTGRES_REQUEST), fake.transport),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("redacts token-shaped text out of provider error messages", async () => {
		const fake = fakeTransport(() =>
			json(422, {
				id: "unprocessable_entity",
				message: `request ${LEAKED_TOKEN} was rejected`,
			}),
		);
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
				request(POSTGRES_REQUEST),
				fake.transport,
			),
		);
		expect(message).not.toContain(LEAKED_TOKEN);
		expect(message).toContain("[redacted]");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("redactDigitalOceanText truncates as well as scrubs", () => {
		expect(redactDigitalOceanText(LEAKED_TOKEN)).toBe("[redacted]");
		// Not token-shaped (no run of 20+ token characters), so this exercises
		// the truncation half rather than the scrubbing half.
		const chatty = "x ".repeat(25);
		expect(redactDigitalOceanText(chatty, 10)).toBe(`${chatty.slice(0, 10)}…`);
	});
});

describe("the transport guard bounds where a token can be sent", () => {
	it("refuses a host that is not api.digitalocean.com", async () => {
		const guarded = guardedDigitalOceanTransport(async () =>
			json(200, { ok: true }),
		);
		await expect(
			guarded({
				method: "GET",
				url: "https://api.digitalocean.example/v2/databases",
				headers: {},
			}),
		).rejects.toThrow();
	});

	it("keeps every real call on the allowlisted host", async () => {
		const fake = fakeTransport(databaseApi());
		await resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID).reconcile(
			request(POSTGRES_REQUEST),
			fake.transport,
		);
		for (const call of fake.calls) {
			expect(call.host).toBe(DIGITALOCEAN_API_HOST);
			expect(call.path.startsWith("/v2/")).toBe(true);
		}
	});
});

describe("a bounded listing refuses rather than concluding 'absent'", () => {
	it("refuses when the page budget runs out before the collection ends", async () => {
		// Every page comes back full, so the lookup never sees the end of the
		// collection and never finds the name.
		const page = Array.from({ length: 200 }, (_, index) => ({
			id: `db-${index}`,
			name: `other-${index}`,
			engine: "pg",
			region: "nyc3",
			size: "db-s-1vcpu-1gb",
			status: "online",
			connection: {},
		}));
		const fake = fakeTransport((call) =>
			call.method === "GET" && call.path === DATABASES
				? json(200, { databases: page })
				: unexpected(call),
		);
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID, {
				maxListPages: 2,
			}).reconcile(request(POSTGRES_REQUEST), fake.transport),
		);
		expect(message).toContain("refuses to adopt or create");
		expect(fake.countOf("POST", DATABASES)).toBe(0);
		expect(fake.countOf("GET", DATABASES)).toBe(2);
	});

	it("refuses an unbounded page budget at construction time", () => {
		expect(() => digitaloceanResolvers(options({ maxListPages: 0 }))).toThrow();
	});
});

describe("Spaces is S3, on its own host with its own credential", () => {
	const SPACES_BUCKET = "/hobo-assets";

	/** A fake Spaces origin: HEAD answers presence, PUT creates, DELETE removes. */
	function spacesApi(
		exists = false,
	): (call: RecordedCall) => TransportResponse {
		let present = exists;
		return (call) => {
			if (call.path !== SPACES_BUCKET) return unexpected(call);
			if (call.method === "HEAD") {
				return present
					? { status: 200, headers: {}, body: "" }
					: { status: 404, headers: {}, body: "" };
			}
			if (call.method === "PUT") {
				present = true;
				return { status: 200, headers: {}, body: "" };
			}
			if (call.method === "DELETE") {
				if (!present) return { status: 404, headers: {}, body: "" };
				present = false;
				return { status: 204, headers: {}, body: "" };
			}
			return unexpected(call);
		};
	}

	const spacesRequest = {
		slot: "bucket",
		productId: DIGITALOCEAN_SPACES_PRODUCT_ID,
		logicalId: "hobo-assets",
		desired: { region: "nyc3" },
	} as const;

	it("creates a bucket that is absent, then makes no second create", async () => {
		const fake = fakeTransport(spacesApi());
		const resolver = resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID);
		const first = checked(
			await resolver.reconcile(request(spacesRequest), fake.transport),
		);
		const second = checked(
			await resolver.reconcile(request(spacesRequest), fake.transport),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("PUT", SPACES_BUCKET)).toBe(1);
	});

	/**
	 * The load-bearing separation: Spaces gets a SigV4 signature computed from
	 * its own key pair, and the control-plane personal access token appears
	 * nowhere on this path.
	 */
	it("signs with SigV4 and never sends the control-plane token", async () => {
		const fake = fakeTransport(spacesApi());
		await resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID).reconcile(
			request(spacesRequest),
			fake.transport,
		);
		expect(fake.calls.length).toBeGreaterThan(0);
		for (const call of fake.calls) {
			expect(call.host).toBe("nyc3.digitaloceanspaces.com");
			const auth = call.headers.authorization ?? "";
			expect(auth).toContain("AWS4-HMAC-SHA256");
			expect(auth).toContain(SPACES_KEYS.accessKeyId);
			expect(auth).not.toContain(TOKEN);
			expect(auth).not.toContain(SPACES_KEYS.secretAccessKey);
			expect(call.headers["x-amz-content-sha256"]).toBeDefined();
		}
	});

	it("is byte-stable, because the signing clock is injected", async () => {
		const run = async () => {
			const fake = fakeTransport(spacesApi());
			await resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID).reconcile(
				request(spacesRequest),
				fake.transport,
			);
			return fake.calls.map((call) => call.headers.authorization);
		};
		expect(await run()).toEqual(await run());
	});

	/**
	 * The prerequisites are demanded on use, not on build: a registry is a
	 * catalog, and constructing one to reconcile a Postgres cluster must not
	 * fail for want of an object-storage key pair that will never be sent.
	 */
	it("builds the registry even without Spaces prerequisites", () => {
		const registry = digitaloceanResolverRegistry({
			resolveCredential: async () => TOKEN,
		});
		expect(
			registry.get(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID),
		).toBeDefined();
		expect(registry.get(DIGITALOCEAN_SPACES_PRODUCT_ID)).toBeDefined();
	});

	it("refuses on first use without an injected clock", async () => {
		const fake = fakeTransport(spacesApi());
		const resolver = digitaloceanResolverRegistry({
			resolveCredential: async () => TOKEN,
			resolveSpacesCredential: async () => SPACES_KEYS,
		}).get(DIGITALOCEAN_SPACES_PRODUCT_ID);
		if (resolver === undefined) {
			throw new Error("expected spaces resolver");
		}
		const message = await messageOf(() =>
			resolver.reconcile(request(spacesRequest), fake.transport),
		);
		expect(message).toContain("nowMs");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses on first use without a Spaces credential resolver", async () => {
		const fake = fakeTransport(spacesApi());
		const resolver = digitaloceanResolverRegistry({
			resolveCredential: async () => TOKEN,
			nowMs: NOW_MS,
		}).get(DIGITALOCEAN_SPACES_PRODUCT_ID);
		if (resolver === undefined) {
			throw new Error("expected spaces resolver");
		}
		const message = await messageOf(() =>
			resolver.reconcile(request(spacesRequest), fake.transport),
		);
		expect(message).toContain("resolveSpacesCredential");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses an incomplete key pair rather than half-signing", async () => {
		const fake = fakeTransport(spacesApi());
		const code = await codeOf(() =>
			resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID, {
				resolveSpacesCredential: async () => ({
					accessKeyId: "only-half",
					secretAccessKey: "",
				}),
			}).reconcile(request(spacesRequest), fake.transport),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(fake.calls).toHaveLength(0);
	});

	/**
	 * Bucket names are global per region, so a 409 is somebody else's bucket.
	 * Adopting it would be worse than failing.
	 */
	it("reports a taken bucket name rather than adopting it", async () => {
		const fake = fakeTransport((call) =>
			call.method === "HEAD"
				? { status: 404, headers: {}, body: "" }
				: { status: 409, headers: {}, body: "" },
		);
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID).reconcile(
				request(spacesRequest),
				fake.transport,
			),
		);
		expect(message).toContain("already taken");
	});

	it("refuses to empty a bucket to make a delete succeed", async () => {
		const fake = fakeTransport((call) =>
			call.method === "DELETE"
				? { status: 409, headers: {}, body: "" }
				: { status: 200, headers: {}, body: "" },
		);
		const message = await messageOf(() =>
			resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID).delete(
				request(spacesRequest),
				fake.transport,
			),
		);
		expect(message).toContain("unbounded data loss");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats an already-gone bucket as a successful delete", async () => {
		const fake = fakeTransport(spacesApi(false));
		await expect(
			resolverFor(DIGITALOCEAN_SPACES_PRODUCT_ID).delete(
				request(spacesRequest),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});

	it("refuses a Spaces host the guard does not name", async () => {
		const guarded = guardedSpacesTransport(
			async () => ({ status: 200, headers: {}, body: "" }),
			"nyc3",
		);
		await expect(
			guarded({
				method: "HEAD",
				url: "https://ams3.digitaloceanspaces.com/hobo-assets",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow();
	});
});
