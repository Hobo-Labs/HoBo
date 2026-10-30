/**
 * GCP resolver tests, driven entirely through an injected fake `HttpTransport`.
 *
 * The fake is the whole provider: that is what lets a test assert "reconcile
 * twice made exactly one create call" at all, which is the property the
 * resolvers exist to have. Nothing here touches a network, a credential, or a
 * Google Cloud project — see the HONEST SCOPE section of `src/resolvers.ts`.
 */

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
	GCP_API_ALLOWED_HOSTS,
	GCP_CLOUD_RUN_JOB_PRODUCT_ID,
	GCP_CLOUD_RUN_PRODUCT_ID,
	GCP_CLOUD_SQL_MYSQL_PRODUCT_ID,
	GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID,
	GCP_CLOUD_STORAGE_PRODUCT_ID,
	GCP_CLOUD_TASKS_PRODUCT_ID,
	GCP_DEFAULT_BINDINGS,
	GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
	GCP_PUBSUB_TOPIC_PRODUCT_ID,
	GCP_RESOLVED_PRODUCT_IDS,
	GCP_SECRET_MANAGER_PRODUCT_ID,
	GCP_UNRESOLVED_PRODUCT_IDS,
	type GcpResolverOptions,
	gcpResolverRegistry,
	gcpResolvers,
	guardedGcpTransport,
	redactGcpText,
} from "../src/index.js";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const PROJECT_ID = "hobo-demo";
const CREDENTIAL_REF = "env://GOOGLE_OAUTH_ACCESS_TOKEN";
/** A token-shaped access token. Never expected anywhere but one header. */
const TOKEN = "ya29fakeaccesstokenvalue0123456789ABCDEF";
/** A 40-character token-shaped string, as Google echoes them in error text. */
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

function notFound(): TransportResponse {
	return json(404, {
		error: { code: 404, message: "Not found", status: "NOT_FOUND" },
	});
}

function noContent(): TransportResponse {
	return { status: 204, headers: {}, body: "" };
}

function unexpected(call: RecordedCall): TransportResponse {
	return json(500, {
		error: {
			code: 500,
			message: `the fake received an unexpected ${call.method} ${call.path}${call.search}`,
			status: "INTERNAL",
		},
	});
}

function bodyOf(call: RecordedCall): Rec {
	return call.body === undefined ? {} : parseJsonObject(call.body);
}

function options(
	overrides: Partial<GcpResolverOptions> = {},
): GcpResolverOptions {
	return {
		projectId: PROJECT_ID,
		resolveCredential: async () => TOKEN,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<GcpResolverOptions> = {},
): ResourceResolver {
	const resolver = gcpResolverRegistry(options(overrides)).get(productId);
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
// Fake Google services
// ---------------------------------------------------------------------------

const BUCKET_PATH = "/storage/v1/b/hobo-assets";
const BUCKET_COLLECTION = "/storage/v1/b";

function bucketApi(initial?: Rec): (call: RecordedCall) => TransportResponse {
	let bucket = initial;
	return (call) => {
		if (call.method === "GET" && call.path === BUCKET_PATH) {
			return bucket === undefined ? notFound() : json(200, bucket);
		}
		if (call.method === "POST" && call.path === BUCKET_COLLECTION) {
			const sent = bodyOf(call);
			bucket = {
				kind: "storage#bucket",
				id: "hobo-assets",
				name: "hobo-assets",
				location: sent.location ?? "US",
				storageClass: sent.storageClass ?? "STANDARD",
				versioning: sent.versioning ?? { enabled: false },
				iamConfiguration: sent.iamConfiguration ?? {},
			};
			return json(200, bucket);
		}
		if (call.method === "PATCH" && call.path === BUCKET_PATH) {
			bucket =
				bucket === undefined ? bodyOf(call) : { ...bucket, ...bodyOf(call) };
			return json(200, bucket);
		}
		if (call.method === "DELETE" && call.path === BUCKET_PATH) {
			if (bucket === undefined) return notFound();
			bucket = undefined;
			return noContent();
		}
		return unexpected(call);
	};
}

const TOPIC_PATH = "/v1/projects/hobo-demo/topics/orders";

function topicApi(config: { readonly conflictOnCreate?: boolean } = {}) {
	let topic: Rec | undefined;
	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === TOPIC_PATH) {
			return topic === undefined ? notFound() : json(200, topic);
		}
		if (call.method === "PUT" && call.path === TOPIC_PATH) {
			if (config.conflictOnCreate === true && topic === undefined) {
				// Another writer won the race and the topic is now there.
				topic = { name: "projects/hobo-demo/topics/orders" };
				return json(409, {
					error: {
						code: 409,
						message: "Resource already exists",
						status: "ALREADY_EXISTS",
					},
				});
			}
			topic = { name: "projects/hobo-demo/topics/orders", ...bodyOf(call) };
			return json(200, topic);
		}
		if (call.method === "PATCH" && call.path === TOPIC_PATH) {
			const sent = bodyOf(call);
			const patch = isJsonObject(sent.topic) ? sent.topic : {};
			topic = topic === undefined ? { ...patch } : { ...topic, ...patch };
			return json(200, topic);
		}
		if (call.method === "DELETE" && call.path === TOPIC_PATH) {
			if (topic === undefined) return notFound();
			topic = undefined;
			return json(200, {});
		}
		return unexpected(call);
	};
}

const SECRET_PATH = "/v1/projects/hobo-demo/secrets/session-signing";
const SECRET_COLLECTION = "/v1/projects/hobo-demo/secrets";

function secretApi() {
	let secret: Rec | undefined;
	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === SECRET_PATH) {
			return secret === undefined ? notFound() : json(200, secret);
		}
		if (call.method === "POST" && call.path === SECRET_COLLECTION) {
			secret = {
				name: "projects/hobo-demo/secrets/session-signing",
				...bodyOf(call),
			};
			return json(200, secret);
		}
		if (call.method === "DELETE" && call.path === SECRET_PATH) {
			if (secret === undefined) return notFound();
			secret = undefined;
			return json(200, {});
		}
		return unexpected(call);
	};
}

const QUEUE_COLLECTION = "/v2/projects/hobo-demo/locations/us-central1/queues";
const QUEUE_PATH = `${QUEUE_COLLECTION}/mailers`;

function queueApi() {
	let queue: Rec | undefined;
	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === QUEUE_PATH) {
			return queue === undefined ? notFound() : json(200, queue);
		}
		if (call.method === "POST" && call.path === QUEUE_COLLECTION) {
			queue = { state: "RUNNING", ...bodyOf(call) };
			return json(200, queue);
		}
		if (call.method === "PATCH" && call.path === QUEUE_PATH) {
			queue =
				queue === undefined ? bodyOf(call) : { ...queue, ...bodyOf(call) };
			return json(200, queue);
		}
		if (call.method === "DELETE" && call.path === QUEUE_PATH) {
			if (queue === undefined) return notFound();
			queue = undefined;
			return json(200, {});
		}
		return unexpected(call);
	};
}

const SQL_COLLECTION = "/v1/projects/hobo-demo/instances";
const SQL_PATH = `${SQL_COLLECTION}/orders-db`;
const SQL_OPERATION_PATH = "/v1/projects/hobo-demo/operations/op-sql-1";

interface SqlApiConfig {
	/** How many operation reads it takes to reach DONE. 0 = done immediately. */
	readonly pollsUntilDone?: number;
	/** When set, the terminal operation carries this error message. */
	readonly failWith?: string;
	readonly instance?: Rec;
}

function sqlApi(config: SqlApiConfig = {}) {
	const pollsUntilDone = config.pollsUntilDone ?? 0;
	let instance = config.instance;
	let polls = 0;
	let pending: "create" | "patch" | "delete" | undefined;

	function operation(): TransportResponse {
		const done = polls >= pollsUntilDone;
		// A failed operation leaves nothing behind, so a retry sees the same miss.
		if (done && pending === "create" && config.failWith === undefined) {
			instance = {
				name: "orders-db",
				region: "us-central1",
				databaseVersion: "POSTGRES_15",
				state: "RUNNABLE",
				connectionName: "hobo-demo:us-central1:orders-db",
				settings: { tier: "db-custom-1-3840", dataDiskSizeGb: 20 },
			};
		}
		if (done && pending === "delete") instance = undefined;
		return json(200, {
			kind: "sql#operation",
			name: "op-sql-1",
			status: done ? "DONE" : "RUNNING",
			...(done && config.failWith !== undefined
				? {
						error: {
							errors: [{ code: "PERMISSION", message: config.failWith }],
						},
					}
				: undefined),
		});
	}

	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === SQL_PATH) {
			return instance === undefined ? notFound() : json(200, instance);
		}
		if (call.method === "POST" && call.path === SQL_COLLECTION) {
			pending = "create";
			return operation();
		}
		if (call.method === "PATCH" && call.path === SQL_PATH) {
			pending = "patch";
			const sent = bodyOf(call);
			instance = {
				...(instance === undefined ? undefined : instance),
				settings: {
					...(isJsonObject(instance?.settings) ? instance.settings : undefined),
					...(isJsonObject(sent.settings) ? sent.settings : undefined),
				},
			};
			return operation();
		}
		if (call.method === "DELETE" && call.path === SQL_PATH) {
			if (instance === undefined) return notFound();
			pending = "delete";
			return operation();
		}
		if (call.method === "GET" && call.path === SQL_OPERATION_PATH) {
			polls += 1;
			return operation();
		}
		return unexpected(call);
	};
}

const REDIS_COLLECTION =
	"/v1/projects/hobo-demo/locations/us-central1/instances";
const REDIS_PATH = `${REDIS_COLLECTION}/session-cache`;
const REDIS_OPERATION_PATH =
	"/v1/projects/hobo-demo/locations/us-central1/operations/op-redis-1";
const REDIS_OPERATION_NAME =
	"projects/hobo-demo/locations/us-central1/operations/op-redis-1";

interface RedisApiConfig {
	/** How many operation reads it takes to reach `done`. 0 = done immediately. */
	readonly pollsUntilDone?: number;
	readonly instance?: Rec;
	/** When set, the operation name is this instead of the documented shape. */
	readonly operationName?: string;
}

function redisApi(config: RedisApiConfig = {}) {
	const pollsUntilDone = config.pollsUntilDone ?? 0;
	let instance = config.instance;
	let polls = 0;
	let pending: "create" | "patch" | "delete" | undefined;
	let sent: Rec = {};

	function operation(): TransportResponse {
		const done = polls >= pollsUntilDone;
		if (done && pending === "create") {
			instance = {
				name: "projects/hobo-demo/locations/us-central1/instances/session-cache",
				tier: sent.tier ?? "BASIC",
				memorySizeGb: sent.memorySizeGb ?? 1,
				redisVersion: sent.redisVersion ?? "REDIS_7_0",
				locationId: "us-central1-a",
				host: "10.0.0.3",
				port: 6379,
				state: "READY",
			};
		}
		if (done && pending === "patch") {
			instance =
				instance === undefined ? { ...sent } : { ...instance, ...sent };
		}
		if (done && pending === "delete") instance = undefined;
		return json(200, {
			name: config.operationName ?? REDIS_OPERATION_NAME,
			done,
			...(done ? { response: instance ?? {} } : undefined),
		});
	}

	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === REDIS_PATH) {
			return instance === undefined ? notFound() : json(200, instance);
		}
		if (call.method === "POST" && call.path === REDIS_COLLECTION) {
			pending = "create";
			sent = bodyOf(call);
			return operation();
		}
		if (call.method === "PATCH" && call.path === REDIS_PATH) {
			pending = "patch";
			sent = bodyOf(call);
			return operation();
		}
		if (call.method === "DELETE" && call.path === REDIS_PATH) {
			if (instance === undefined) return notFound();
			pending = "delete";
			return operation();
		}
		if (call.method === "GET" && call.path === REDIS_OPERATION_PATH) {
			polls += 1;
			return operation();
		}
		return unexpected(call);
	};
}

const RUN_COLLECTION = "/v2/projects/hobo-demo/locations/us-central1/services";
const RUN_PATH = `${RUN_COLLECTION}/storefront`;
const RUN_OPERATION_PATH =
	"/v2/projects/hobo-demo/locations/us-central1/operations/op-run-1";

function runApi(config: { readonly pollsUntilDone?: number } = {}) {
	const pollsUntilDone = config.pollsUntilDone ?? 0;
	let service: Rec | undefined;
	let polls = 0;
	let pending: "apply" | "delete" | undefined;
	let sentBody: Rec = {};

	function operation(): TransportResponse {
		const done = polls >= pollsUntilDone;
		if (done && pending === "apply") {
			service = {
				name: "projects/hobo-demo/locations/us-central1/services/storefront",
				generation: "1",
				observedGeneration: "1",
				terminalCondition: { state: "CONDITION_SUCCEEDED" },
				uri: "https://storefront-abc.a.run.app",
				ingress: sentBody.ingress ?? "INGRESS_TRAFFIC_ALL",
				template: sentBody.template ?? {},
			};
		}
		if (done && pending === "delete") service = undefined;
		return json(200, {
			name: "projects/hobo-demo/locations/us-central1/operations/op-run-1",
			done,
			...(done ? { response: service ?? {} } : undefined),
		});
	}

	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === RUN_PATH) {
			return service === undefined ? notFound() : json(200, service);
		}
		if (
			(call.method === "POST" && call.path === RUN_COLLECTION) ||
			(call.method === "PATCH" && call.path === RUN_PATH)
		) {
			pending = "apply";
			sentBody = bodyOf(call);
			return operation();
		}
		if (call.method === "DELETE" && call.path === RUN_PATH) {
			if (service === undefined) return notFound();
			pending = "delete";
			return operation();
		}
		if (call.method === "GET" && call.path === RUN_OPERATION_PATH) {
			polls += 1;
			return operation();
		}
		return unexpected(call);
	};
}

const JOB_COLLECTION = "/v2/projects/hobo-demo/locations/us-central1/jobs";
const JOB_PATH = `${JOB_COLLECTION}/nightly-report`;

function jobApi() {
	let job: Rec | undefined;
	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === JOB_PATH) {
			return job === undefined ? notFound() : json(200, job);
		}
		if (call.method === "POST" && call.path === JOB_COLLECTION) {
			job = {
				name: "projects/hobo-demo/locations/us-central1/jobs/nightly-report",
				...bodyOf(call),
			};
			return json(200, {
				name: "projects/hobo-demo/locations/us-central1/operations/op-run-1",
				done: true,
				response: job,
			});
		}
		if (call.method === "DELETE" && call.path === JOB_PATH) {
			if (job === undefined) return notFound();
			job = undefined;
			return json(200, {
				name: "projects/hobo-demo/locations/us-central1/operations/op-run-1",
				done: true,
			});
		}
		return unexpected(call);
	};
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const BUCKET_REQUEST = request({
	slot: "bucket",
	productId: GCP_CLOUD_STORAGE_PRODUCT_ID,
	logicalId: "hobo-assets",
	desired: {
		location: "US",
		storageClass: "standard",
		versioning: true,
		uniformBucketLevelAccess: true,
	},
});

const TOPIC_REQUEST = request({
	slot: "topic",
	productId: GCP_PUBSUB_TOPIC_PRODUCT_ID,
	logicalId: "orders",
	desired: { messageRetentionSeconds: 600 },
});

const SECRET_REQUEST = request({
	slot: "secretRef",
	productId: GCP_SECRET_MANAGER_PRODUCT_ID,
	logicalId: "session-signing",
	desired: { replication: "automatic" },
});

const QUEUE_REQUEST = request({
	slot: "queue",
	productId: GCP_CLOUD_TASKS_PRODUCT_ID,
	logicalId: "mailers",
	desired: {
		location: "us-central1",
		maxConcurrentDispatches: 10,
		maxAttempts: 5,
	},
});

const SQL_REQUEST = request({
	slot: "data",
	productId: GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID,
	logicalId: "orders-db",
	desired: {
		region: "us-central1",
		tier: "db-custom-1-3840",
		storageGb: 20,
		engineVersion: "POSTGRES_15",
	},
});

const REDIS_REQUEST = request({
	slot: "kv",
	productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
	logicalId: "session-cache",
	desired: {
		location: "us-central1",
		memoryGb: 1,
		tier: "basic",
		engineVersion: "REDIS_7_0",
	},
});

const RUN_REQUEST = request({
	slot: "web",
	productId: GCP_CLOUD_RUN_PRODUCT_ID,
	logicalId: "storefront",
	desired: {
		location: "us-central1",
		image: "us-docker.pkg.dev/hobo-demo/app/storefront:v1",
		ingress: "all",
		maxInstances: 4,
	},
});

const JOB_REQUEST = request({
	slot: "service",
	productId: GCP_CLOUD_RUN_JOB_PRODUCT_ID,
	logicalId: "nightly-report",
	desired: {
		location: "us-central1",
		image: "us-docker.pkg.dev/hobo-demo/app/report:v1",
		tasks: 2,
		maxRetries: 1,
	},
});

// ---------------------------------------------------------------------------
// Registry and declared coverage
// ---------------------------------------------------------------------------

describe("gcp resolver registry", () => {
	it("registers exactly the products it can converge", () => {
		const registry = gcpResolverRegistry(options());
		expect(registry.list().map((entry) => entry.productId)).toEqual([
			...GCP_RESOLVED_PRODUCT_IDS,
		]);
		for (const resolver of registry.list()) {
			expect(resolver.providerId).toBe("gcp");
		}
		for (const productId of GCP_UNRESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)).toBeUndefined();
		}
	});

	it("leaves uncovered exactly the declared unresolved product ids", () => {
		const catalogued = new Set<string>();
		for (const bindings of Object.values(GCP_DEFAULT_BINDINGS)) {
			for (const binding of bindings ?? []) {
				if (binding.productId !== undefined) catalogued.add(binding.productId);
			}
		}
		const registry = gcpResolverRegistry(options());
		const uncovered = [...catalogued]
			.filter((productId) => registry.get(productId) === undefined)
			.sort();
		expect(uncovered).toEqual([...GCP_UNRESOLVED_PRODUCT_IDS]);
		// And nothing is claimed twice: resolved and unresolved are disjoint.
		for (const productId of GCP_RESOLVED_PRODUCT_IDS) {
			expect(GCP_UNRESOLVED_PRODUCT_IDS).not.toContain(productId);
		}
	});

	it("refuses a request routed to the wrong resolver", async () => {
		const fake = fakeTransport(bucketApi());
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
					TOPIC_REQUEST,
					fake.transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses construction without a projectId or with an unbounded poll budget", () => {
		expect(() => gcpResolvers(options({ projectId: "" }))).toThrow(
			/projectId/u,
		);
		expect(() =>
			gcpResolvers(
				options({
					operationPoll: { attempts: Number.POSITIVE_INFINITY },
				}),
			),
		).toThrow(/bounded/u);
	});
});

// ---------------------------------------------------------------------------
// Cloud Storage
// ---------------------------------------------------------------------------

describe("cloud storage bucket resolver", () => {
	it("creates, then converges to one bucket with one create call", async () => {
		const fake = fakeTransport(bucketApi());
		const resolver = resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(BUCKET_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe("hobo-assets");
		expect(first.outputs.bucketName).toBe("hobo-assets");

		const second = checked(
			await resolver.reconcile(BUCKET_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", BUCKET_COLLECTION)).toBe(1);
	});

	it("reports a noop when the caller already knows the physical id", async () => {
		const fake = fakeTransport(
			bucketApi({
				name: "hobo-assets",
				location: "US",
				storageClass: "STANDARD",
				versioning: { enabled: true },
				iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
				request({
					slot: "bucket",
					productId: GCP_CLOUD_STORAGE_PRODUCT_ID,
					logicalId: "hobo-assets",
					physicalId: "hobo-assets",
					desired: { location: "US", versioning: true },
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("noop");
		expect(fake.countOf("POST", BUCKET_COLLECTION)).toBe(0);
	});

	it("applies a mutable delta as an update rather than a replace", async () => {
		const fake = fakeTransport(
			bucketApi({
				name: "hobo-assets",
				location: "US",
				storageClass: "STANDARD",
				versioning: { enabled: false },
				iamConfiguration: {},
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
				BUCKET_REQUEST,
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(fake.countOf("PATCH", BUCKET_PATH)).toBe(1);
		const patched = fake.calls.at(-1);
		if (patched === undefined) {
			throw new Error("expected a PATCH call");
		}
		expect(bodyOf(patched)).toMatchObject({
			versioning: { enabled: true },
		});
	});

	it("reports immutable location drift as a diagnostic and never replaces", async () => {
		const fake = fakeTransport(
			bucketApi({
				name: "hobo-assets",
				location: "EU",
				storageClass: "STANDARD",
				versioning: { enabled: true },
				iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
				BUCKET_REQUEST,
				fake.transport,
			),
		);
		expect(outcome.action).not.toBe("replace");
		expect(outcome.diagnostics.join(" ")).toMatch(/location is EU/u);
		expect(fake.countOf("DELETE", BUCKET_PATH)).toBe(0);
	});

	it("deletes, and treats an absent bucket as already deleted", async () => {
		const fake = fakeTransport(bucketApi({ name: "hobo-assets" }));
		const resolver = resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID);
		await expect(
			resolver.delete(BUCKET_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(BUCKET_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		expect(fake.countOf("DELETE", BUCKET_PATH)).toBe(2);
	});

	it("reads an absent bucket as undefined", async () => {
		const fake = fakeTransport(bucketApi());
		expect(
			await resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).read?.(
				BUCKET_REQUEST,
				fake.transport,
			),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Pub/Sub
// ---------------------------------------------------------------------------

describe("pubsub topic resolver", () => {
	it("creates, then converges with one PUT", async () => {
		const fake = fakeTransport(topicApi());
		const resolver = resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(TOPIC_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe("projects/hobo-demo/topics/orders");

		const second = checked(
			await resolver.reconcile(TOPIC_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("PUT", TOPIC_PATH)).toBe(1);
	});

	it("adopts on 409 ALREADY_EXISTS only after a re-read", async () => {
		const fake = fakeTransport(topicApi({ conflictOnCreate: true }));
		const outcome = checked(
			await resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).reconcile(
				TOPIC_REQUEST,
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.diagnostics.join(" ")).toMatch(/ALREADY_EXISTS/u);
		// GET (miss) → PUT (409) → GET (found): the 409 is never swallowed alone.
		expect(fake.countOf("GET", TOPIC_PATH)).toBe(2);
		expect(fake.countOf("PUT", TOPIC_PATH)).toBe(1);
	});

	it("reports declared-but-unapplied options rather than pretending", async () => {
		const fake = fakeTransport(topicApi());
		const outcome = checked(
			await resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).reconcile(
				request({
					slot: "topic",
					productId: GCP_PUBSUB_TOPIC_PRODUCT_ID,
					logicalId: "orders",
					desired: { messageOrdering: true, schemaId: "orders-v1" },
				}),
				fake.transport,
			),
		);
		expect(outcome.diagnostics.join(" ")).toMatch(/messageOrdering/u);
		expect(outcome.diagnostics.join(" ")).toMatch(/schemaId/u);
	});

	it("deletes, and treats an absent topic as already deleted", async () => {
		const fake = fakeTransport(topicApi());
		const resolver = resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID);
		await resolver.reconcile(TOPIC_REQUEST, fake.transport);
		await expect(
			resolver.delete(TOPIC_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(TOPIC_REQUEST, fake.transport),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Secret Manager
// ---------------------------------------------------------------------------

describe("secret manager resolver", () => {
	it("creates the container, converges, and never writes material", async () => {
		const fake = fakeTransport(secretApi());
		const resolver = resolverFor(GCP_SECRET_MANAGER_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(SECRET_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe("projects/hobo-demo/secrets/session-signing");
		expect(first.diagnostics.join(" ")).toMatch(/no version is ever written/u);

		const second = checked(
			await resolver.reconcile(SECRET_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", SECRET_COLLECTION)).toBe(1);
		// No call ever addresses a version subresource.
		for (const call of fake.calls) {
			expect(call.path).not.toMatch(/\/versions/u);
		}
	});

	it("refuses to choose a replication policy", async () => {
		const fake = fakeTransport(secretApi());
		expect(
			await codeOf(() =>
				resolverFor(GCP_SECRET_MANAGER_PRODUCT_ID).reconcile(
					request({
						slot: "secretRef",
						productId: GCP_SECRET_MANAGER_PRODUCT_ID,
						logicalId: "session-signing",
					}),
					fake.transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("deletes, and treats an absent secret as already deleted", async () => {
		const fake = fakeTransport(secretApi());
		const resolver = resolverFor(GCP_SECRET_MANAGER_PRODUCT_ID);
		await resolver.reconcile(SECRET_REQUEST, fake.transport);
		await expect(
			resolver.delete(SECRET_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(SECRET_REQUEST, fake.transport),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Cloud Tasks
// ---------------------------------------------------------------------------

describe("cloud tasks queue resolver", () => {
	it("creates, then converges with one create call", async () => {
		const fake = fakeTransport(queueApi());
		const resolver = resolverFor(GCP_CLOUD_TASKS_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(QUEUE_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe(
			"projects/hobo-demo/locations/us-central1/queues/mailers",
		);

		const second = checked(
			await resolver.reconcile(QUEUE_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", QUEUE_COLLECTION)).toBe(1);
	});

	it("refuses to pick a location", async () => {
		const fake = fakeTransport(queueApi());
		const message = await messageOf(() =>
			resolverFor(GCP_CLOUD_TASKS_PRODUCT_ID).reconcile(
				request({
					slot: "queue",
					productId: GCP_CLOUD_TASKS_PRODUCT_ID,
					logicalId: "mailers",
				}),
				fake.transport,
			),
		);
		expect(message).toMatch(/desired\.location/u);
		expect(fake.calls).toHaveLength(0);
	});

	it("deletes, and treats an absent queue as already deleted", async () => {
		const fake = fakeTransport(queueApi());
		const resolver = resolverFor(GCP_CLOUD_TASKS_PRODUCT_ID);
		await resolver.reconcile(QUEUE_REQUEST, fake.transport);
		await expect(
			resolver.delete(QUEUE_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(QUEUE_REQUEST, fake.transport),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Cloud SQL — the long-running Operation path
// ---------------------------------------------------------------------------

describe("cloud sql instance resolver", () => {
	it("creates through a terminal operation and converges", async () => {
		const fake = fakeTransport(sqlApi());
		const resolver = resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(SQL_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe("projects/hobo-demo/instances/orders-db");
		expect(first.outputs.operationConfirmed).toBe(true);
		expect(first.outputs.connectionName).toBe(
			"hobo-demo:us-central1:orders-db",
		);

		const second = checked(
			await resolver.reconcile(SQL_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", SQL_COLLECTION)).toBe(1);
	});

	it("polls a running operation to a terminal state", async () => {
		const fake = fakeTransport(sqlApi({ pollsUntilDone: 2 }));
		const outcome = checked(
			await resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID).reconcile(
				SQL_REQUEST,
				fake.transport,
			),
		);
		expect(fake.countOf("GET", SQL_OPERATION_PATH)).toBe(2);
		expect(outcome.outputs.operationConfirmed).toBe(true);
		expect(outcome.diagnostics.join(" ")).not.toMatch(/NOT confirmed/u);
	});

	it("waits between polls through the injected budget, never a clock", async () => {
		const waits: number[] = [];
		const fake = fakeTransport(sqlApi({ pollsUntilDone: 2 }));
		await resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID, {
			operationPoll: {
				attempts: 4,
				beforeAttempt: async (attempt) => {
					waits.push(attempt);
				},
			},
		}).reconcile(SQL_REQUEST, fake.transport);
		expect(waits).toEqual([1, 2]);
	});

	it("reports an unfinished operation honestly instead of as a finished create", async () => {
		const fake = fakeTransport(sqlApi({ pollsUntilDone: 99 }));
		const outcome = checked(
			await resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID, {
				operationPoll: { attempts: 1 },
			}).reconcile(SQL_REQUEST, fake.transport),
		);
		expect(fake.countOf("GET", SQL_OPERATION_PATH)).toBe(1);
		expect(outcome.outputs.operationConfirmed).toBe(false);
		expect(outcome.diagnostics.join(" ")).toMatch(/NOT confirmed/u);
		// The instance was never read as ready, so no provider outputs are invented.
		expect(outcome.outputs.connectionName).toBeUndefined();
	});

	it("turns an operation that finished with an error into a redacted refusal", async () => {
		const fake = fakeTransport(
			sqlApi({ failWith: `denied for ${LEAKED_TOKEN}` }),
		);
		const resolver = resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID);
		expect(
			await codeOf(() => resolver.reconcile(SQL_REQUEST, fake.transport)),
		).toBe("RESOLVER_PROVIDER_REJECTED");
		const message = await messageOf(() =>
			resolver.reconcile(SQL_REQUEST, fake.transport),
		);
		expect(message).not.toContain(LEAKED_TOKEN);
		expect(message).toContain("[redacted]");
	});

	it("patches a mutable settings delta rather than replacing the instance", async () => {
		const fake = fakeTransport(
			sqlApi({
				instance: {
					name: "orders-db",
					region: "us-central1",
					databaseVersion: "POSTGRES_15",
					settings: { tier: "db-custom-1-3840", dataDiskSizeGb: 10 },
				},
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID).reconcile(
				SQL_REQUEST,
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(fake.countOf("PATCH", SQL_PATH)).toBe(1);
		expect(fake.countOf("POST", SQL_COLLECTION)).toBe(0);
	});

	it("reports immutable region drift as a diagnostic, never a replace", async () => {
		const fake = fakeTransport(
			sqlApi({
				instance: {
					name: "orders-db",
					region: "europe-west1",
					databaseVersion: "POSTGRES_15",
					settings: { tier: "db-custom-1-3840", dataDiskSizeGb: 20 },
				},
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID).reconcile(
				SQL_REQUEST,
				fake.transport,
			),
		);
		expect(outcome.action).not.toBe("replace");
		expect(outcome.diagnostics.join(" ")).toMatch(/region is europe-west1/u);
		expect(fake.countOf("DELETE", SQL_PATH)).toBe(0);
	});

	it("refuses a tier-less create and a bare engine version", async () => {
		const fake = fakeTransport(sqlApi());
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_SQL_MYSQL_PRODUCT_ID).reconcile(
					request({
						slot: "data",
						productId: GCP_CLOUD_SQL_MYSQL_PRODUCT_ID,
						logicalId: "orders-db",
						desired: { region: "us-central1" },
					}),
					fake.transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(
			await messageOf(() =>
				resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID).reconcile(
					request({
						slot: "data",
						productId: GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID,
						logicalId: "orders-db",
						desired: {
							region: "us-central1",
							tier: "db-custom-1-3840",
							engineVersion: "15",
						},
					}),
					fake.transport,
				),
			),
		).toMatch(/POSTGRES_15/u);
	});

	it("deletes through a terminal operation and treats an absent instance as gone", async () => {
		const fake = fakeTransport(
			sqlApi({ instance: { name: "orders-db", region: "us-central1" } }),
		);
		const resolver = resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID);
		await expect(
			resolver.delete(SQL_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(SQL_REQUEST, fake.transport),
		).resolves.toBeUndefined();
	});

	it("refuses to report an unconfirmed delete as a success", async () => {
		const fake = fakeTransport(
			sqlApi({
				pollsUntilDone: 99,
				instance: { name: "orders-db", region: "us-central1" },
			}),
		);
		const resolver = resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID, {
			operationPoll: { attempts: 1 },
		});
		expect(
			await codeOf(() => resolver.delete(SQL_REQUEST, fake.transport)),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

// ---------------------------------------------------------------------------
// Cloud Run
// ---------------------------------------------------------------------------

describe("cloud run resolvers", () => {
	it("creates a service through a terminal operation and converges", async () => {
		const fake = fakeTransport(runApi());
		const resolver = resolverFor(GCP_CLOUD_RUN_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(RUN_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe(
			"projects/hobo-demo/locations/us-central1/services/storefront",
		);
		expect(first.outputs.uri).toBe("https://storefront-abc.a.run.app");

		const second = checked(
			await resolver.reconcile(RUN_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", RUN_COLLECTION)).toBe(1);
	});

	it("polls a running service operation and reports an unfinished one honestly", async () => {
		const polled = fakeTransport(runApi({ pollsUntilDone: 1 }));
		const confirmed = checked(
			await resolverFor(GCP_CLOUD_RUN_PRODUCT_ID).reconcile(
				RUN_REQUEST,
				polled.transport,
			),
		);
		expect(polled.countOf("GET", RUN_OPERATION_PATH)).toBe(1);
		expect(confirmed.outputs.operationConfirmed).toBe(true);

		const stuck = fakeTransport(runApi({ pollsUntilDone: 99 }));
		const unconfirmed = checked(
			await resolverFor(GCP_CLOUD_RUN_PRODUCT_ID, {
				operationPoll: { attempts: 2 },
			}).reconcile(RUN_REQUEST, stuck.transport),
		);
		expect(stuck.countOf("GET", RUN_OPERATION_PATH)).toBe(2);
		expect(unconfirmed.outputs.operationConfirmed).toBe(false);
		expect(unconfirmed.outputs.uri).toBeUndefined();
		expect(unconfirmed.diagnostics.join(" ")).toMatch(/NOT confirmed/u);
	});

	it("updates a drifted image through a PATCH, never a replace", async () => {
		const fake = fakeTransport(runApi());
		const resolver = resolverFor(GCP_CLOUD_RUN_PRODUCT_ID);
		await resolver.reconcile(RUN_REQUEST, fake.transport);
		const outcome = checked(
			await resolver.reconcile(
				request({
					slot: "web",
					productId: GCP_CLOUD_RUN_PRODUCT_ID,
					logicalId: "storefront",
					desired: {
						location: "us-central1",
						image: "us-docker.pkg.dev/hobo-demo/app/storefront:v2",
						ingress: "all",
					},
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.diagnostics.join(" ")).toMatch(/image/u);
		expect(fake.countOf("PATCH", RUN_PATH)).toBe(1);
		expect(fake.countOf("POST", RUN_COLLECTION)).toBe(1);
	});

	it("refuses a service create with no image", async () => {
		const fake = fakeTransport(runApi());
		expect(
			await messageOf(() =>
				resolverFor(GCP_CLOUD_RUN_PRODUCT_ID).reconcile(
					request({
						slot: "web",
						productId: GCP_CLOUD_RUN_PRODUCT_ID,
						logicalId: "storefront",
						desired: { location: "us-central1" },
					}),
					fake.transport,
				),
			),
		).toMatch(/desired\.image/u);
	});

	it("creates a job and converges", async () => {
		const fake = fakeTransport(jobApi());
		const resolver = resolverFor(GCP_CLOUD_RUN_JOB_PRODUCT_ID);
		const first = checked(
			await resolver.reconcile(JOB_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe(
			"projects/hobo-demo/locations/us-central1/jobs/nightly-report",
		);
		const second = checked(
			await resolver.reconcile(JOB_REQUEST, fake.transport),
		);
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", JOB_COLLECTION)).toBe(1);
	});

	it("deletes a service and treats an absent one as already deleted", async () => {
		const fake = fakeTransport(runApi());
		const resolver = resolverFor(GCP_CLOUD_RUN_PRODUCT_ID);
		await resolver.reconcile(RUN_REQUEST, fake.transport);
		await expect(
			resolver.delete(RUN_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		await expect(
			resolver.delete(RUN_REQUEST, fake.transport),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Credentials, redaction, transport reach
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Memorystore for Redis
// ---------------------------------------------------------------------------

describe("memorystore redis resolver", () => {
	it("creates through a terminal operation and converges", async () => {
		const fake = fakeTransport(redisApi());
		const resolver = resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID);

		const first = checked(
			await resolver.reconcile(REDIS_REQUEST, fake.transport),
		);
		expect(first.action).toBe("create");
		expect(first.physicalId).toBe(
			"projects/hobo-demo/locations/us-central1/instances/session-cache",
		);
		expect(first.outputs.host).toBe("10.0.0.3");
		expect(first.outputs.port).toBe(6379);
		expect(first.outputs.operationConfirmed).toBe(true);

		const second = checked(
			await resolver.reconcile(REDIS_REQUEST, fake.transport),
		);
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		// The property the resolver exists to have: two reconciles, one create.
		expect(fake.countOf("POST", REDIS_COLLECTION)).toBe(1);
	});

	it("names the instance through instanceId, which is what makes the read converge", async () => {
		const fake = fakeTransport(redisApi());
		await resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).reconcile(
			REDIS_REQUEST,
			fake.transport,
		);
		const create = fake.calls.find(
			(call) => call.method === "POST" && call.path === REDIS_COLLECTION,
		);
		expect(create?.search).toBe("?instanceId=session-cache");
		if (create === undefined) {
			throw new Error("expected a create call");
		}
		expect(bodyOf(create)).toEqual({
			memorySizeGb: 1,
			tier: "BASIC",
			redisVersion: "REDIS_7_0",
		});
	});

	it("reports an unfinished create as not confirmed rather than as done", async () => {
		const fake = fakeTransport(redisApi({ pollsUntilDone: 99 }));
		const outcome = checked(
			await resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID, {
				operationPoll: { attempts: 2 },
			}).reconcile(REDIS_REQUEST, fake.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.operationConfirmed).toBe(false);
		expect(outcome.diagnostics.join(" ")).toMatch(/NOT confirmed ready/u);
		// It did not invent provider outputs it never read.
		expect(outcome.outputs.host).toBeUndefined();
	});

	it("scales memory through the documented updateMask and nothing else", async () => {
		const fake = fakeTransport(
			redisApi({
				instance: {
					name: "projects/hobo-demo/locations/us-central1/instances/session-cache",
					tier: "BASIC",
					memorySizeGb: 1,
					redisVersion: "REDIS_7_0",
					locationId: "us-central1-a",
					host: "10.0.0.3",
					port: 6379,
					state: "READY",
				},
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).reconcile(
				request({
					slot: "kv",
					productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
					logicalId: "session-cache",
					desired: {
						location: "us-central1",
						memoryGb: 5,
						tier: "basic",
						engineVersion: "REDIS_7_0",
					},
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.memorySizeGb).toBe(5);
		const patch = fake.calls.find((call) => call.method === "PATCH");
		expect(patch?.search).toBe("?updateMask=memorySizeGb");
		if (patch === undefined) {
			throw new Error("expected a PATCH call");
		}
		expect(bodyOf(patch)).toEqual({ memorySizeGb: 5 });
	});

	it("reports tier and version drift instead of applying it", async () => {
		// Memorystore's updateMask covers memorySizeGb, displayName, labels,
		// redisConfig and replicaCount. Tier is fixed for the instance's life and
		// a version move is the separate upgrade method, which restarts the node.
		const fake = fakeTransport(
			redisApi({
				instance: {
					name: "projects/hobo-demo/locations/us-central1/instances/session-cache",
					tier: "BASIC",
					memorySizeGb: 1,
					redisVersion: "REDIS_6_X",
					locationId: "europe-west1-b",
					host: "10.0.0.3",
					port: 6379,
					state: "READY",
				},
			}),
		);
		const outcome = checked(
			await resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).reconcile(
				request({
					slot: "kv",
					productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
					logicalId: "session-cache",
					desired: {
						location: "us-central1",
						memoryGb: 1,
						tier: "standard-ha",
						engineVersion: "REDIS_7_0",
					},
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		const text = outcome.diagnostics.join(" | ");
		expect(text).toMatch(/tier is BASIC/u);
		expect(text).toMatch(/redisVersion is REDIS_6_X/u);
		expect(text).toMatch(/locationId is europe-west1-b/u);
		// Reported, never "fixed": no write went out at all.
		expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
	});

	it("refuses to guess the size, the tier vocabulary, or the version enum", async () => {
		const fake = fakeTransport(redisApi());
		const resolver = resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID);
		const sizeless = request({
			slot: "kv",
			productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
			logicalId: "session-cache",
			desired: { location: "us-central1" },
		});
		expect(
			await messageOf(() => resolver.reconcile(sizeless, fake.transport)),
		).toMatch(/memorySizeGb at creation/u);
		expect(
			await messageOf(() =>
				resolver.reconcile(
					request({
						slot: "kv",
						productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
						logicalId: "session-cache",
						desired: {
							location: "us-central1",
							memoryGb: 1,
							tier: "STANDARD_HA",
						},
					}),
					fake.transport,
				),
			),
		).toMatch(/is not one of basic, standard-ha/u);
		expect(
			await messageOf(() =>
				resolver.reconcile(
					request({
						slot: "kv",
						productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
						logicalId: "session-cache",
						desired: {
							location: "us-central1",
							memoryGb: 1,
							engineVersion: "7.0",
						},
					}),
					fake.transport,
				),
			),
		).toMatch(/redisVersion enum/u);
	});

	it("refuses to place the instance in a region nobody asked for", async () => {
		const fake = fakeTransport(redisApi());
		expect(
			await messageOf(() =>
				resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).reconcile(
					request({
						slot: "kv",
						productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
						logicalId: "session-cache",
						desired: { memoryGb: 1 },
					}),
					fake.transport,
				),
			),
		).toMatch(/names no location/u);
	});

	it("says so when the tier fell back to Google's own default", async () => {
		const fake = fakeTransport(redisApi());
		const outcome = checked(
			await resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).reconcile(
				request({
					slot: "kv",
					productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
					logicalId: "session-cache",
					desired: { location: "us-central1", memoryGb: 1 },
				}),
				fake.transport,
			),
		);
		expect(outcome.diagnostics.join(" ")).toMatch(/tier was not declared/u);
	});

	it("deletes idempotently and refuses to report an unconfirmed delete as done", async () => {
		const fake = fakeTransport(
			redisApi({
				instance: {
					name: "projects/hobo-demo/locations/us-central1/instances/session-cache",
					tier: "BASIC",
					memorySizeGb: 1,
				},
			}),
		);
		const resolver = resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID);
		await expect(
			resolver.delete(REDIS_REQUEST, fake.transport),
		).resolves.toBeUndefined();
		// "Already gone" is success, which is what makes a re-run safe.
		await expect(
			resolver.delete(REDIS_REQUEST, fake.transport),
		).resolves.toBeUndefined();

		const stuck = fakeTransport(
			redisApi({
				pollsUntilDone: 99,
				instance: {
					name: "projects/hobo-demo/locations/us-central1/instances/session-cache",
				},
			}),
		);
		expect(
			await codeOf(() =>
				resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID, {
					operationPoll: { attempts: 1 },
				}).delete(REDIS_REQUEST, stuck.transport),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("refuses an operation name that is not the documented shape", async () => {
		// The name is what the next poll URL is built from. An undocumented one
		// leaves the outcome unknown, and unknown is refused rather than assumed.
		const fake = fakeTransport(
			redisApi({ pollsUntilDone: 1, operationName: "op-redis-1" }),
		);
		expect(
			await codeOf(() =>
				resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).reconcile(
					REDIS_REQUEST,
					fake.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("reads an absent instance as absent, not as an error", async () => {
		const fake = fakeTransport(redisApi());
		expect(
			await resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).read(
				REDIS_REQUEST,
				fake.transport,
			),
		).toBeUndefined();
	});
});

describe("gcp resolver credentials", () => {
	it("refuses a credentialRef that carries material rather than a locator", async () => {
		const fake = fakeTransport(bucketApi());
		// SAFETY: fixture skips parseResolveRequest so the resolver still refuses
		// a material-shaped credentialRef.
		const raw = {
			...BUCKET_REQUEST,
			credentialRef: "ya29aVeryLongRawAccessTokenValue0123456789",
		} as ResolveRequest;
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
					raw,
					fake.transport,
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");

		// SAFETY: fixture skips parseResolveRequest so the resolver still refuses
		// a non-locator credentialRef.
		const bare = {
			...BUCKET_REQUEST,
			credentialRef: "not-a-locator",
		} as ResolveRequest;
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
					bare,
					fake.transport,
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses an empty or unresolvable credentialRef with remediation", async () => {
		const fake = fakeTransport(bucketApi());
		// SAFETY: fixture skips parseResolveRequest so the resolver still refuses
		// a blank credentialRef.
		const empty = { ...BUCKET_REQUEST, credentialRef: "  " } as ResolveRequest;
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
					empty,
					fake.transport,
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");

		const message = await messageOf(() =>
			resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID, {
				resolveCredential: async () => {
					throw new Error("no such reference");
				},
			}).reconcile(BUCKET_REQUEST, fake.transport),
		);
		expect(message).toMatch(/credential resolver/u);
	});

	it("puts the token in the authorization header and nowhere else", async () => {
		const fake = fakeTransport(sqlApi());
		const outcome = await resolverFor(
			GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID,
		).reconcile(SQL_REQUEST, fake.transport);
		expect(fake.calls.length).toBeGreaterThan(0);
		for (const call of fake.calls) {
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(call.path).not.toContain(TOKEN);
			expect(call.search).not.toContain(TOKEN);
			expect(call.body ?? "").not.toContain(TOKEN);
			for (const [name, value] of Object.entries(call.headers)) {
				if (name === "authorization") continue;
				expect(value).not.toContain(TOKEN);
			}
		}
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
	});
});

describe("gcp provider error handling", () => {
	it("turns a Google error body into a redacted provider refusal", async () => {
		const fake = fakeTransport(() =>
			json(403, {
				error: {
					code: 403,
					message: `caller does not have permission; token ${LEAKED_TOKEN}`,
					status: "PERMISSION_DENIED",
				},
			}),
		);
		const resolver = resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID);
		expect(
			await codeOf(() => resolver.reconcile(BUCKET_REQUEST, fake.transport)),
		).toBe("RESOLVER_PROVIDER_REJECTED");
		const message = await messageOf(() =>
			resolver.reconcile(BUCKET_REQUEST, fake.transport),
		);
		expect(message).toContain("PERMISSION_DENIED");
		expect(message).not.toContain(LEAKED_TOKEN);
		expect(message).not.toContain(TOKEN);
	});

	it("refuses a malformed success body rather than assuming an outcome", async () => {
		const notJson = fakeTransport(() => ({
			status: 200,
			headers: { "content-type": "text/html" },
			body: "<html>maintenance</html>",
		}));
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
					BUCKET_REQUEST,
					notJson.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");

		const notObject = fakeTransport(() => json(200, ["unexpected"]));
		expect(
			await codeOf(() =>
				resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).reconcile(
					TOPIC_REQUEST,
					notObject.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses an operation whose name it cannot poll", async () => {
		const fake = fakeTransport((call) =>
			call.method === "POST" && call.path === SQL_COLLECTION
				? json(200, { name: "../../admin", status: "RUNNING" })
				: notFound(),
		);
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID).reconcile(
					SQL_REQUEST,
					fake.transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("redacts token-shaped text and bounds its length", () => {
		expect(redactGcpText(`prefix ${LEAKED_TOKEN} suffix`)).toBe(
			"prefix [redacted] suffix",
		);
		expect(redactGcpText("x".repeat(500)).length).toBeLessThanOrEqual(401);
	});
});

describe("gcp guarded transport", () => {
	const request: TransportRequest = {
		method: "GET",
		url: "https://storage.googleapis.com/storage/v1/b/hobo-assets",
		headers: {},
		timeoutMs: 1_000,
		maxResponseBytes: 1_024,
	};
	const inner: HttpTransport = async () => json(200, { name: "hobo-assets" });

	it("allowlists exactly the seven service hosts it calls, never a wildcard", () => {
		expect([...GCP_API_ALLOWED_HOSTS]).toEqual([
			"cloudtasks.googleapis.com",
			"pubsub.googleapis.com",
			"redis.googleapis.com",
			"run.googleapis.com",
			"secretmanager.googleapis.com",
			"sqladmin.googleapis.com",
			"storage.googleapis.com",
		]);
		for (const host of GCP_API_ALLOWED_HOSTS) {
			expect(host).not.toContain("*");
		}
	});

	it("allows the service's own host and path", async () => {
		const guarded = guardedGcpTransport(inner, "cloudStorage");
		expect((await guarded(request)).status).toBe(200);
	});

	it("refuses another Google host, even a googleapis.com one", async () => {
		const guarded = guardedGcpTransport(inner, "cloudStorage");
		await expect(
			guarded({
				...request,
				url: "https://compute.googleapis.com/storage/v1/b/hobo-assets",
			}),
		).rejects.toThrow(/not exactly one of the allowlisted/u);
	});

	it("refuses another service's path on this service's host", async () => {
		const guarded = guardedGcpTransport(inner, "cloudStorage");
		await expect(
			guarded({
				...request,
				url: "https://storage.googleapis.com/v1/projects/hobo-demo/topics/orders",
			}),
		).rejects.toThrow(/outside the allowlisted prefixes/u);
	});

	it("refuses http and an over-budget timeout", async () => {
		const guarded = guardedGcpTransport(inner, "pubsub");
		await expect(
			guarded({
				...request,
				url: "http://pubsub.googleapis.com/v1/projects/hobo-demo/topics/orders",
			}),
		).rejects.toThrow(/https/u);
		await expect(
			guarded({
				...request,
				url: "https://pubsub.googleapis.com/v1/projects/hobo-demo/topics/orders",
				timeoutMs: 60_000,
			}),
		).rejects.toThrow(/exceeds the policy cap/u);
	});
});
