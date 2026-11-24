/**
 * Azure ARM resolver tests, driven entirely through an injected fake transport
 * that models one subscription. Nothing here touches a network, and that is the
 * point: the fake *is* the provider, which is what makes "exactly one create
 * call" and "the same physicalId twice" assertable at all.
 *
 * HONEST SCOPE: passing this file proves the request/response shapes this
 * package composes and accepts. It proves nothing about a live Azure deploy —
 * that additionally needs real credentials, real egress, a real subscription,
 * and api-versions verified against the running service.
 */

import {
	type CapabilitySlot,
	type HttpTransport,
	ResolverError,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	AZURE_BLOB_STORAGE_PRODUCT_ID,
	AZURE_CACHE_API_VERSION,
	AZURE_CONTAINER_APPS_API_VERSION,
	AZURE_CONTAINER_APPS_PRODUCT_ID,
	AZURE_COSMOS_API_VERSION,
	AZURE_COSMOS_DB_PRODUCT_ID,
	AZURE_COSMOS_TABLE_PRODUCT_ID,
	AZURE_KEY_VAULT_API_VERSION,
	AZURE_KEY_VAULT_PRODUCT_ID,
	AZURE_REDIS_CACHE_PRODUCT_ID,
	AZURE_RESOLVED_PRODUCT_IDS,
	AZURE_SERVICE_BUS_API_VERSION,
	AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
	AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
	AZURE_STORAGE_API_VERSION,
	AZURE_STORAGE_QUEUE_PRODUCT_ID,
	AZURE_UNRESOLVED_PRODUCT_IDS,
	azureArmUrl,
	azureOperationUrl,
	azureResolverRegistry,
	azureResolvers,
	azureYardSpec,
	guardedAzureTransport,
	redactAzureText,
} from "../src/index.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const SUBSCRIPTION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const RESOURCE_GROUP = "hobo-rg";
const CREDENTIAL_REF = "owner://AZURE_ARM_ACCESS_TOKEN";
/** The resolved material. It must appear in exactly one place: a header. */
const TOKEN = "hobo.arm.bearer.token.0123456789abcdefghij";
/** A 40-character token-shaped string, as ARM echoes request context. */
const LEAKED_SECRET = "abcdefghij0123456789ABCDEFGHIJ0123456789";

const STORAGE_ACCOUNT = "hobostorage";
const SERVICE_BUS_NAMESPACE = "hobo-bus";

const GROUP_PREFIX = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`;
const STORAGE_ACCOUNT_PATH = `${GROUP_PREFIX}/providers/Microsoft.Storage/storageAccounts/${STORAGE_ACCOUNT}`;
const SERVICE_BUS_NAMESPACE_PATH = `${GROUP_PREFIX}/providers/Microsoft.ServiceBus/namespaces/${SERVICE_BUS_NAMESPACE}`;

/** Where the fake parks its long-running operations. Subscription-scoped, so
 *  the guard's `/subscriptions/` prefix admits it exactly as ARM's own are. */
const OPERATION_PATH = `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.Test/locations/eastus/asyncOperations/op-1`;
const OPERATION_URL = `https://management.azure.com${OPERATION_PATH}?api-version=2023-05-01`;

// ---------------------------------------------------------------------------
// The fake subscription
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly apiVersion: string | null;
	readonly body: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

type WriteMode =
	| "sync"
	| "async-operation"
	| "location"
	| "provisioning"
	| "bare-202"
	| "foreign-operation";

interface ArmOptions {
	/** Resources that already exist, keyed by ARM resource id (the URL path). */
	readonly seed?: Readonly<Record<string, JsonObject>>;
	readonly writeMode?: WriteMode;
	/** How many operation polls answer `InProgress` before `Succeeded`. */
	readonly inProgressPolls?: number;
	/** When set, the operation settles into this terminal state instead. */
	readonly operationFailure?: string;
	/** Force a response for any call, bypassing the store. */
	readonly override?: (call: RecordedCall) => TransportResponse | undefined;
}

interface Arm {
	readonly transport: HttpTransport;
	readonly calls: readonly RecordedCall[];
	countOf(method: string, path: string): number;
	has(path: string): boolean;
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
		error: { code: "ResourceNotFound", message: "resource was not found" },
	});
}

function lastSegment(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? "";
}

/**
 * A fake ARM. `PUT` stores the resource under the id it was addressed by, which
 * is what makes idempotent-PUT-plus-deterministic-name observable: a second
 * reconcile GETs the same id and finds it.
 */
function createArm(options: ArmOptions = {}): Arm {
	const store = new Map<string, JsonObject>(Object.entries(options.seed ?? {}));
	const calls: RecordedCall[] = [];
	const writeMode: WriteMode = options.writeMode ?? "sync";
	let inProgressPolls = options.inProgressPolls ?? 0;

	function applyWrite(call: RecordedCall, merge: boolean): JsonObject {
		const payload =
			call.body === undefined ? undefined : parseJsonObject(call.body);
		const previous = store.get(call.path);
		const previousProperties =
			merge && previous !== undefined && isJsonObject(previous.properties)
				? previous.properties
				: {};
		const payloadProperties =
			payload !== undefined && isJsonObject(payload.properties)
				? payload.properties
				: {};
		const location = isJsonString(payload?.location)
			? payload.location
			: isJsonString(previous?.location)
				? previous.location
				: undefined;
		const body: JsonObject = {
			id: call.path,
			name: lastSegment(call.path),
			...(location === undefined ? undefined : { location }),
			properties: {
				...previousProperties,
				...payloadProperties,
				provisioningState: "Succeeded",
			},
		};
		store.set(call.path, body);
		return body;
	}

	function writeResponse(body: JsonObject): TransportResponse {
		switch (writeMode) {
			case "async-operation":
				return {
					status: 202,
					headers: { "azure-asyncoperation": OPERATION_URL },
					body: "",
				};
			case "location":
				return {
					status: 202,
					headers: {
						location: `https://management.azure.com${String(body.id)}?api-version=${AZURE_COSMOS_API_VERSION}`,
					},
					body: "",
				};
			case "provisioning": {
				const properties = isJsonObject(body.properties) ? body.properties : {};
				return json(200, {
					...body,
					properties: { ...properties, provisioningState: "Creating" },
				});
			}
			case "bare-202":
				return { status: 202, headers: {}, body: "" };
			case "foreign-operation":
				return {
					status: 202,
					headers: {
						"azure-asyncoperation":
							"https://attacker.example.com/subscriptions/steal",
					},
					body: "",
				};
			default:
				return json(201, body);
		}
	}

	function handle(call: RecordedCall): TransportResponse {
		const forced = options.override?.(call);
		if (forced !== undefined) return forced;

		if (call.path === OPERATION_PATH) {
			if (inProgressPolls > 0) {
				inProgressPolls -= 1;
				return json(200, { status: "InProgress" });
			}
			if (options.operationFailure !== undefined) {
				return json(200, {
					status: options.operationFailure,
					error: {
						code: "DeploymentFailed",
						message: `quota exceeded for ${LEAKED_SECRET}`,
					},
				});
			}
			return json(200, { status: "Succeeded" });
		}

		switch (call.method) {
			case "GET": {
				const found = store.get(call.path);
				return found === undefined ? notFound() : json(200, found);
			}
			case "PUT":
				return writeResponse(applyWrite(call, false));
			case "PATCH":
				return writeResponse(applyWrite(call, true));
			case "DELETE": {
				if (!store.has(call.path)) return notFound();
				store.delete(call.path);
				return { status: 200, headers: {}, body: "" };
			}
			default:
				return notFound();
		}
	}

	const transport: HttpTransport = async (request: TransportRequest) => {
		const url = new URL(request.url);
		const call: RecordedCall = {
			method: request.method,
			path: url.pathname,
			apiVersion: url.searchParams.get("api-version"),
			body: request.body,
			headers: request.headers,
		};
		calls.push(call);
		return handle(call);
	};

	return {
		transport: guardedAzureTransport(transport),
		calls,
		countOf(method, path) {
			return calls.filter(
				(call) => call.method === method && call.path === path,
			).length;
		},
		has(path) {
			return store.has(path);
		},
	};
}

// ---------------------------------------------------------------------------
// Resolver construction
// ---------------------------------------------------------------------------

function registry(overrides?: {
	readonly resolveCredential?: (ref: string) => Promise<string>;
	readonly pollBudget?: number;
	readonly waitBetweenPolls?: (attempt: number) => Promise<void>;
}) {
	return azureResolverRegistry({
		subscriptionId: SUBSCRIPTION_ID,
		resourceGroup: RESOURCE_GROUP,
		resolveCredential:
			overrides?.resolveCredential ??
			((): Promise<string> => Promise.resolve(TOKEN)),
		...(overrides?.pollBudget !== undefined
			? { pollBudget: overrides.pollBudget }
			: undefined),
		...(overrides?.waitBetweenPolls !== undefined
			? { waitBetweenPolls: overrides.waitBetweenPolls }
			: undefined),
	});
}

function resolverFor(
	productId: string,
	overrides?: Parameters<typeof registry>[0],
) {
	const resolver = registry(overrides).get(productId);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

interface ProductCase {
	readonly label: string;
	readonly productId: string;
	readonly slot: CapabilitySlot;
	readonly logicalId: string;
	readonly desired: Readonly<JsonObject>;
	readonly resourcePath: string;
	readonly apiVersion: string;
	readonly seed: Readonly<Record<string, JsonObject>>;
}

const STORAGE_SEED: Readonly<Record<string, JsonObject>> = Object.freeze({
	[STORAGE_ACCOUNT_PATH]: {
		id: STORAGE_ACCOUNT_PATH,
		name: STORAGE_ACCOUNT,
		location: "eastus",
		properties: { provisioningState: "Succeeded" },
	},
});

const SERVICE_BUS_SEED: Readonly<Record<string, JsonObject>> = Object.freeze({
	[SERVICE_BUS_NAMESPACE_PATH]: {
		id: SERVICE_BUS_NAMESPACE_PATH,
		name: SERVICE_BUS_NAMESPACE,
		location: "eastus",
		properties: { provisioningState: "Succeeded" },
	},
});

/** A Table API account: the capability is fixed at account creation, and the
 *  table resolver refuses an account that does not carry it. */
const TABLE_ACCOUNT = "hobo-tables";
const TABLE_ACCOUNT_PATH = `${GROUP_PREFIX}/providers/Microsoft.DocumentDB/databaseAccounts/${TABLE_ACCOUNT}`;

function cosmosAccountSeed(
	capabilities: readonly string[],
): Readonly<Record<string, JsonObject>> {
	return Object.freeze({
		[TABLE_ACCOUNT_PATH]: {
			id: TABLE_ACCOUNT_PATH,
			name: TABLE_ACCOUNT,
			location: "eastus",
			properties: {
				capabilities: capabilities.map((name) => ({ name })),
				provisioningState: "Succeeded",
			},
		},
	});
}

const TABLE_ACCOUNT_SEED = cosmosAccountSeed(["EnableTable"]);

const CASES: readonly ProductCase[] = Object.freeze([
	{
		label: "blob container",
		productId: AZURE_BLOB_STORAGE_PRODUCT_ID,
		slot: "bucket",
		logicalId: "assets",
		desired: { publicAccessBlocked: true, storageAccount: STORAGE_ACCOUNT },
		resourcePath: `${STORAGE_ACCOUNT_PATH}/blobServices/default/containers/assets`,
		apiVersion: AZURE_STORAGE_API_VERSION,
		seed: STORAGE_SEED,
	},
	{
		label: "storage queue",
		productId: AZURE_STORAGE_QUEUE_PRODUCT_ID,
		slot: "queue",
		logicalId: "jobs",
		desired: { storageAccount: STORAGE_ACCOUNT },
		resourcePath: `${STORAGE_ACCOUNT_PATH}/queueServices/default/queues/jobs`,
		apiVersion: AZURE_STORAGE_API_VERSION,
		seed: STORAGE_SEED,
	},
	{
		label: "service bus queue",
		productId: AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		slot: "queue",
		logicalId: "orders",
		desired: {
			lockDurationSeconds: 60,
			maxDeliveryCount: 5,
			namespace: SERVICE_BUS_NAMESPACE,
		},
		resourcePath: `${SERVICE_BUS_NAMESPACE_PATH}/queues/orders`,
		apiVersion: AZURE_SERVICE_BUS_API_VERSION,
		seed: SERVICE_BUS_SEED,
	},
	{
		label: "service bus topic",
		productId: AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
		slot: "topic",
		logicalId: "events",
		desired: { maxSizeMb: 1024, namespace: SERVICE_BUS_NAMESPACE },
		resourcePath: `${SERVICE_BUS_NAMESPACE_PATH}/topics/events`,
		apiVersion: AZURE_SERVICE_BUS_API_VERSION,
		seed: SERVICE_BUS_SEED,
	},
	{
		label: "key vault",
		productId: AZURE_KEY_VAULT_PRODUCT_ID,
		slot: "secretRef",
		logicalId: "hobo-vault",
		desired: {
			location: "eastus",
			rbacAuthorization: true,
			tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
		},
		resourcePath: `${GROUP_PREFIX}/providers/Microsoft.KeyVault/vaults/hobo-vault`,
		apiVersion: AZURE_KEY_VAULT_API_VERSION,
		seed: {},
	},
	{
		label: "cosmos account",
		productId: AZURE_COSMOS_DB_PRODUCT_ID,
		slot: "data",
		logicalId: "hobo-cosmos",
		desired: { consistencyLevel: "session", location: "eastus" },
		resourcePath: `${GROUP_PREFIX}/providers/Microsoft.DocumentDB/databaseAccounts/hobo-cosmos`,
		apiVersion: AZURE_COSMOS_API_VERSION,
		seed: {},
	},
	{
		label: "cosmos table",
		productId: AZURE_COSMOS_TABLE_PRODUCT_ID,
		slot: "kv",
		logicalId: "sessions",
		desired: { databaseAccount: TABLE_ACCOUNT, throughputRu: 400 },
		resourcePath: `${TABLE_ACCOUNT_PATH}/tables/sessions`,
		apiVersion: AZURE_COSMOS_API_VERSION,
		seed: TABLE_ACCOUNT_SEED,
	},
	{
		label: "redis cache",
		productId: AZURE_REDIS_CACHE_PRODUCT_ID,
		slot: "kv",
		logicalId: "hobo-cache",
		desired: { capacity: 1, location: "eastus", skuName: "Standard" },
		resourcePath: `${GROUP_PREFIX}/providers/Microsoft.Cache/redis/hobo-cache`,
		apiVersion: AZURE_CACHE_API_VERSION,
		seed: {},
	},
	{
		label: "container app",
		productId: AZURE_CONTAINER_APPS_PRODUCT_ID,
		slot: "web",
		logicalId: "hobo-web",
		desired: {
			image: "ghcr.io/hobo/web:1",
			ingress: "external",
			location: "eastus",
			managedEnvironmentId: `${GROUP_PREFIX}/providers/Microsoft.App/managedEnvironments/hobo-env`,
			maxReplicas: 3,
			minReplicas: 1,
			targetPort: 8080,
		},
		resourcePath: `${GROUP_PREFIX}/providers/Microsoft.App/containerApps/hobo-web`,
		apiVersion: AZURE_CONTAINER_APPS_API_VERSION,
		seed: {},
	},
]);

function productFor(productId: string): ProductCase {
	const product = CASES.find((entry) => entry.productId === productId);
	if (product === undefined) {
		throw new Error(`expected product ${productId}`);
	}
	return product;
}

function omitKey(record: JsonObject, key: string): JsonObject {
	const out = {};
	for (const [name, value] of Object.entries(record)) {
		if (name !== key) Object.assign(out, { [name]: value });
	}
	return out;
}

function jsonBody(call: RecordedCall | undefined): JsonObject {
	return call?.body === undefined ? {} : parseJsonObject(call.body);
}

function jsonProperties(call: RecordedCall | undefined): JsonObject {
	const properties = jsonBody(call).properties;
	return isJsonObject(properties) ? properties : {};
}

function requestFor(
	product: ProductCase,
	overrides?: {
		readonly credentialRef?: string;
		readonly physicalId?: string;
		readonly desired?: Readonly<JsonObject>;
	},
) {
	return {
		ref: {
			slot: product.slot,
			productId: product.productId,
			logicalId: product.logicalId,
			...(overrides?.physicalId !== undefined
				? { physicalId: overrides.physicalId }
				: undefined),
		},
		desired: overrides?.desired ?? product.desired,
		credentialRef: overrides?.credentialRef ?? CREDENTIAL_REF,
	};
}

async function codeOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ResolverError) return error.code;
		throw error;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

async function messageOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

// ---------------------------------------------------------------------------
// Registry surface
// ---------------------------------------------------------------------------

describe("azure resolver registry", () => {
	it("registers exactly the declared resolved product ids", () => {
		const listed = registry()
			.list()
			.map((resolver) => resolver.productId);
		expect(listed).toEqual([...AZURE_RESOLVED_PRODUCT_IDS]);
	});

	it("stamps every resolver with the azure provider target", () => {
		for (const resolver of azureResolvers({
			subscriptionId: SUBSCRIPTION_ID,
			resourceGroup: RESOURCE_GROUP,
			resolveCredential: () => Promise.resolve(TOKEN),
		})) {
			expect(resolver.providerId).toBe("azure");
		}
	});

	it("leaves exactly the declared unresolved set uncovered", () => {
		const index = registry();
		const catalogued = new Set(
			azureYardSpec().bindings.flatMap((row) =>
				row.productId === undefined ? [] : [row.productId],
			),
		);
		const uncovered = [...catalogued]
			.filter((productId) => index.get(productId) === undefined)
			.sort();
		expect(uncovered).toEqual([...AZURE_UNRESOLVED_PRODUCT_IDS]);
	});

	it("declares nothing unresolved that actually has a resolver", () => {
		const index = registry();
		for (const productId of AZURE_UNRESOLVED_PRODUCT_IDS) {
			expect(index.get(productId)).toBeUndefined();
		}
	});

	it("refuses a malformed subscription id rather than pasting it into a path", async () => {
		const code = await codeOf(async () =>
			azureResolverRegistry({
				subscriptionId: "not-a-guid",
				resourceGroup: RESOURCE_GROUP,
				resolveCredential: () => Promise.resolve(TOKEN),
			}),
		);
		expect(code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses an unbounded poll budget", async () => {
		const code = await codeOf(async () =>
			azureResolverRegistry({
				subscriptionId: SUBSCRIPTION_ID,
				resourceGroup: RESOURCE_GROUP,
				resolveCredential: () => Promise.resolve(TOKEN),
				pollBudget: 100_000,
			}),
		);
		expect(code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

// ---------------------------------------------------------------------------
// Per-product convergence
// ---------------------------------------------------------------------------

describe.each(CASES)("$label", (product) => {
	it("creates the resource at its deterministic ARM id", async () => {
		const arm = createArm({ seed: product.seed });
		const outcome = await resolverFor(product.productId).reconcile(
			requestFor(product),
			arm.transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(product.resourcePath);
		expect(arm.countOf("PUT", product.resourcePath)).toBe(1);
		expect(arm.has(product.resourcePath)).toBe(true);
	});

	it("reconciles twice into one resource with one create call", async () => {
		const arm = createArm({ seed: product.seed });
		const resolver = resolverFor(product.productId);
		const first = await resolver.reconcile(requestFor(product), arm.transport);
		const second = await resolver.reconcile(
			requestFor(product, { physicalId: first.physicalId }),
			arm.transport,
		);

		expect(second.physicalId).toBe(first.physicalId);
		expect(second.action).toBe("noop");
		expect(arm.countOf("PUT", product.resourcePath)).toBe(1);
		expect(arm.countOf("PATCH", product.resourcePath)).toBe(0);
	});

	it("adopts a pre-existing resource the request did not know about", async () => {
		const arm = createArm({ seed: product.seed });
		const resolver = resolverFor(product.productId);
		await resolver.reconcile(requestFor(product), arm.transport);
		const adopted = await resolver.reconcile(
			requestFor(product),
			arm.transport,
		);
		expect(adopted.action).toBe("adopt");
	});

	it("reads back the resource it created", async () => {
		const arm = createArm({ seed: product.seed });
		const resolver = resolverFor(product.productId);
		expect(await resolver.read?.(requestFor(product), arm.transport)).toBe(
			undefined,
		);
		await resolver.reconcile(requestFor(product), arm.transport);
		const view = await resolver.read?.(requestFor(product), arm.transport);
		expect(view?.physicalId).toBe(product.resourcePath);
	});

	it("deletes the resource", async () => {
		const arm = createArm({ seed: product.seed });
		const resolver = resolverFor(product.productId);
		await resolver.reconcile(requestFor(product), arm.transport);
		await resolver.delete(requestFor(product), arm.transport);
		expect(arm.has(product.resourcePath)).toBe(false);
	});

	it("treats deleting an absent resource as success", async () => {
		const arm = createArm({ seed: product.seed });
		await expect(
			resolverFor(product.productId).delete(requestFor(product), arm.transport),
		).resolves.toBeUndefined();
	});

	it("carries the pinned api-version on every call", async () => {
		const arm = createArm({ seed: product.seed });
		const resolver = resolverFor(product.productId);
		await resolver.reconcile(requestFor(product), arm.transport);
		await resolver.reconcile(requestFor(product), arm.transport);
		await resolver.delete(requestFor(product), arm.transport);

		expect(arm.calls.length).toBeGreaterThan(0);
		for (const call of arm.calls) {
			expect(call.apiVersion).toBe(product.apiVersion);
		}
	});

	it("puts the token in the authorization header and nowhere else", async () => {
		const arm = createArm({ seed: product.seed });
		const outcome = await resolverFor(product.productId).reconcile(
			requestFor(product),
			arm.transport,
		);

		for (const call of arm.calls) {
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(call.path).not.toContain(TOKEN);
			expect(call.body ?? "").not.toContain(TOKEN);
		}
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
	});

	it("refuses a credentialRef that is not a locator", async () => {
		const arm = createArm({ seed: product.seed });
		const code = await codeOf(() =>
			resolverFor(product.productId).reconcile(
				requestFor(product, { credentialRef: "AZURE_ARM_ACCESS_TOKEN_VALUE" }),
				arm.transport,
			),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(arm.calls).toHaveLength(0);
	});

	it("refuses when the host cannot resolve the credential", async () => {
		const arm = createArm({ seed: product.seed });
		const code = await codeOf(() =>
			resolverFor(product.productId, {
				resolveCredential: () => Promise.resolve(""),
			}).reconcile(requestFor(product), arm.transport),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(arm.calls).toHaveLength(0);
	});

	it("turns an ARM error body into a redacted provider rejection", async () => {
		const arm = createArm({
			seed: product.seed,
			override: (call) =>
				call.path === product.resourcePath
					? json(500, {
							error: {
								code: "InternalServerError",
								message: `request ${LEAKED_SECRET} failed`,
							},
						})
					: undefined,
		});
		const message = await messageOf(() =>
			resolverFor(product.productId).reconcile(
				requestFor(product),
				arm.transport,
			),
		);
		expect(message).toContain("status 500");
		expect(message).not.toContain(LEAKED_SECRET);
		expect(message).toContain("[redacted]");
	});

	it("reports a non-JSON response as unparseable rather than assuming it worked", async () => {
		const arm = createArm({
			seed: product.seed,
			override: (call) =>
				call.path === product.resourcePath
					? { status: 200, headers: {}, body: "<html>gateway</html>" }
					: undefined,
		});
		const code = await codeOf(() =>
			resolverFor(product.productId).reconcile(
				requestFor(product),
				arm.transport,
			),
		);
		expect(code).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("never emits replace", async () => {
		const arm = createArm({ seed: product.seed });
		const resolver = resolverFor(product.productId);
		const first = await resolver.reconcile(requestFor(product), arm.transport);
		const second = await resolver.reconcile(requestFor(product), arm.transport);
		expect(first.action).not.toBe("replace");
		expect(second.action).not.toBe("replace");
	});
});

// ---------------------------------------------------------------------------
// Long-running operations
// ---------------------------------------------------------------------------

const COSMOS = productFor(AZURE_COSMOS_DB_PRODUCT_ID);

describe("long-running operations", () => {
	it("follows an Azure-AsyncOperation to terminal success before reporting a create", async () => {
		const polls: number[] = [];
		const arm = createArm({
			seed: COSMOS.seed,
			writeMode: "async-operation",
			inProgressPolls: 2,
		});
		const outcome = await resolverFor(COSMOS.productId, {
			pollBudget: 5,
			waitBetweenPolls: (attempt) => {
				polls.push(attempt);
				return Promise.resolve();
			},
		}).reconcile(requestFor(COSMOS), arm.transport);

		expect(outcome.action).toBe("create");
		// Two InProgress answers, then Succeeded: the operation was actually
		// followed rather than assumed from the 202.
		expect(arm.countOf("GET", OPERATION_PATH)).toBe(3);
		expect(polls).toEqual([1, 2, 3]);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
		expect(outcome.outputs.provisioningState).toBe("Succeeded");
	});

	it("follows a Location header to the settled resource", async () => {
		const arm = createArm({ seed: COSMOS.seed, writeMode: "location" });
		const outcome = await resolverFor(COSMOS.productId).reconcile(
			requestFor(COSMOS),
			arm.transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("polls a non-terminal provisioningState instead of trusting the 200", async () => {
		const arm = createArm({ seed: COSMOS.seed, writeMode: "provisioning" });
		const outcome = await resolverFor(COSMOS.productId).reconcile(
			requestFor(COSMOS),
			arm.transport,
		);
		expect(outcome.action).toBe("create");
		// One GET before the PUT, one poll after it.
		expect(arm.countOf("GET", COSMOS.resourcePath)).toBe(2);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("reports accepted-but-not-confirmed when the poll budget runs out", async () => {
		const arm = createArm({
			seed: COSMOS.seed,
			writeMode: "async-operation",
			inProgressPolls: 999,
		});
		const outcome = await resolverFor(COSMOS.productId, {
			pollBudget: 3,
		}).reconcile(requestFor(COSMOS), arm.transport);

		expect(arm.countOf("GET", OPERATION_PATH)).toBe(3);
		expect(outcome.diagnostics.join(" ")).toContain("NOT confirmed complete");
		expect(outcome.diagnostics.join(" ")).toContain("3-poll budget");
		// The honest report is a diagnostic, not a silent success.
		expect(outcome.diagnostics).not.toHaveLength(0);
	});

	it("reports a bare 202 with no operation header as unconfirmed", async () => {
		const arm = createArm({ seed: COSMOS.seed, writeMode: "bare-202" });
		const outcome = await resolverFor(COSMOS.productId).reconcile(
			requestFor(COSMOS),
			arm.transport,
		);
		expect(outcome.diagnostics.join(" ")).toContain("NOT confirmed complete");
		expect(outcome.diagnostics.join(" ")).toContain(
			"neither an Azure-AsyncOperation nor a Location header",
		);
	});

	it("refuses to follow an operation URL off the allowlisted ARM origin", async () => {
		const arm = createArm({
			seed: COSMOS.seed,
			writeMode: "foreign-operation",
		});
		const outcome = await resolverFor(COSMOS.productId).reconcile(
			requestFor(COSMOS),
			arm.transport,
		);
		expect(outcome.diagnostics.join(" ")).toContain("NOT confirmed complete");
		expect(outcome.diagnostics.join(" ")).toContain("outside the allowlisted");
		for (const call of arm.calls) {
			expect(call.path).not.toContain("steal");
		}
	});

	it("turns a failed operation into a redacted provider rejection", async () => {
		const arm = createArm({
			seed: COSMOS.seed,
			writeMode: "async-operation",
			operationFailure: "Failed",
		});
		const message = await messageOf(() =>
			resolverFor(COSMOS.productId).reconcile(
				requestFor(COSMOS),
				arm.transport,
			),
		);
		expect(message).toContain("failed");
		expect(message).not.toContain(LEAKED_SECRET);
	});

	it("reports an unconfirmed delete rather than letting it read as done", async () => {
		const arm = createArm({
			seed: {
				...COSMOS.seed,
				[COSMOS.resourcePath]: {
					id: COSMOS.resourcePath,
					name: "hobo-cosmos",
					location: "eastus",
					properties: { provisioningState: "Succeeded" },
				},
			},
			writeMode: "async-operation",
			inProgressPolls: 999,
			override: (call) =>
				call.method === "DELETE"
					? {
							status: 202,
							headers: { "azure-asyncoperation": OPERATION_URL },
							body: "",
						}
					: undefined,
		});
		const message = await messageOf(() =>
			resolverFor(COSMOS.productId, { pollBudget: 2 }).delete(
				requestFor(COSMOS),
				arm.transport,
			),
		);
		expect(message).toContain("NOT confirmed complete");
		expect(message).toContain("re-run delete");
	});
});

// ---------------------------------------------------------------------------
// Deltas, drift, and preconditions
// ---------------------------------------------------------------------------

describe("deltas and drift", () => {
	it("applies a mutable service bus delta as an update, then settles", async () => {
		const queuePath = `${SERVICE_BUS_NAMESPACE_PATH}/queues/orders`;
		const arm = createArm({
			seed: {
				...SERVICE_BUS_SEED,
				[queuePath]: {
					id: queuePath,
					name: "orders",
					properties: {
						createdAt: "2024-01-01T00:00:00Z",
						lockDuration: "PT30S",
						maxDeliveryCount: 10,
						messageCount: 4,
						requiresSession: false,
					},
				},
			},
		});
		const outcome = await resolverFor(
			AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		).reconcile(
			requestFor(productFor(AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID)),
			arm.transport,
		);

		expect(outcome.action).toBe("update");
		expect(outcome.outputs.lockDuration).toBe("PT60S");
		const write = arm.calls.find(
			(call) => call.method === "PUT" && call.path === queuePath,
		);
		const properties = jsonProperties(write);
		// Read-only fields are stripped; everything else the provider reported is
		// carried forward so the delta does not reset it.
		expect(properties.createdAt).toBeUndefined();
		expect(properties.messageCount).toBeUndefined();
		expect(properties.requiresSession).toBe(false);
		expect(properties.lockDuration).toBe("PT60S");
	});

	it("treats an equivalent ISO-8601 duration as settled rather than permanent drift", async () => {
		const queuePath = `${SERVICE_BUS_NAMESPACE_PATH}/queues/orders`;
		const arm = createArm({
			seed: {
				...SERVICE_BUS_SEED,
				[queuePath]: {
					id: queuePath,
					name: "orders",
					// ARM answers PT1M to a PT60S request.
					properties: { lockDuration: "PT1M", maxDeliveryCount: 5 },
				},
			},
		});
		const outcome = await resolverFor(
			AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		).reconcile(
			requestFor(productFor(AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID)),
			arm.transport,
		);
		expect(outcome.action).toBe("adopt");
		expect(arm.countOf("PUT", queuePath)).toBe(0);
	});

	it("reports immutable session drift as a diagnostic and never replaces", async () => {
		const queuePath = `${SERVICE_BUS_NAMESPACE_PATH}/queues/orders`;
		const arm = createArm({
			seed: {
				...SERVICE_BUS_SEED,
				[queuePath]: {
					id: queuePath,
					name: "orders",
					properties: {
						lockDuration: "PT60S",
						maxDeliveryCount: 5,
						requiresSession: false,
					},
				},
			},
		});
		const base = productFor(AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID);
		const outcome = await resolverFor(
			AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		).reconcile(
			requestFor(base, {
				desired: { ...base.desired, sessionsEnabled: true },
			}),
			arm.transport,
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.diagnostics.join(" ")).toContain("requiresSession");
		expect(arm.countOf("DELETE", queuePath)).toBe(0);
	});

	it("reports account-level blob options it cannot apply to a container", async () => {
		const arm = createArm({ seed: STORAGE_SEED });
		const base = productFor(AZURE_BLOB_STORAGE_PRODUCT_ID);
		const outcome = await resolverFor(AZURE_BLOB_STORAGE_PRODUCT_ID).reconcile(
			requestFor(base, {
				desired: {
					...base.desired,
					accessTier: "cool",
					redundancy: "zrs",
					versioning: true,
				},
			}),
			arm.transport,
		);
		const text = outcome.diagnostics.join(" ");
		expect(text).toContain("accessTier is declared but not applied");
		expect(text).toContain("redundancy is declared but not applied");
		expect(text).toContain("versioning is declared but not applied");
	});

	it("refuses a blob container when the named storage account is absent", async () => {
		const arm = createArm();
		const base = productFor(AZURE_BLOB_STORAGE_PRODUCT_ID);
		const message = await messageOf(() =>
			resolverFor(AZURE_BLOB_STORAGE_PRODUCT_ID).reconcile(
				requestFor(base),
				arm.transport,
			),
		);
		expect(message).toContain("storage account");
		expect(message).toContain("does not exist");
		expect(arm.countOf("PUT", base.resourcePath)).toBe(0);
	});

	it("refuses a blob container when no storage account is named at all", async () => {
		const arm = createArm();
		const base = productFor(AZURE_BLOB_STORAGE_PRODUCT_ID);
		const message = await messageOf(() =>
			resolverFor(AZURE_BLOB_STORAGE_PRODUCT_ID).reconcile(
				requestFor(base, { desired: {} }),
				arm.transport,
			),
		);
		expect(message).toContain("desired.storageAccount is required");
	});

	it("refuses container-app ingress without a target port", async () => {
		const arm = createArm();
		const base = productFor(AZURE_CONTAINER_APPS_PRODUCT_ID);
		const withoutPort = omitKey(base.desired, "targetPort");
		const message = await messageOf(() =>
			resolverFor(AZURE_CONTAINER_APPS_PRODUCT_ID).reconcile(
				requestFor(base, { desired: withoutPort }),
				arm.transport,
			),
		);
		expect(message).toContain("desired.targetPort is required");
	});

	it("refuses cosmos bounded staleness without its bounds", async () => {
		const arm = createArm();
		const base = productFor(AZURE_COSMOS_DB_PRODUCT_ID);
		const message = await messageOf(() =>
			resolverFor(AZURE_COSMOS_DB_PRODUCT_ID).reconcile(
				requestFor(base, {
					desired: { ...base.desired, consistencyLevel: "bounded-staleness" },
				}),
				arm.transport,
			),
		);
		expect(message).toContain("maxStalenessPrefix");
	});

	it("says out loud when it had to choose the Key Vault base tier", async () => {
		const arm = createArm();
		const base = productFor(AZURE_KEY_VAULT_PRODUCT_ID);
		const outcome = await resolverFor(AZURE_KEY_VAULT_PRODUCT_ID).reconcile(
			requestFor(base),
			arm.transport,
		);
		expect(outcome.diagnostics.join(" ")).toContain("skuName was not declared");
		expect(outcome.diagnostics.join(" ")).toContain("soft-delete");
	});

	it("refuses to turn Key Vault purge protection back off", async () => {
		const vaultPath = `${GROUP_PREFIX}/providers/Microsoft.KeyVault/vaults/hobo-vault`;
		const arm = createArm({
			seed: {
				[vaultPath]: {
					id: vaultPath,
					name: "hobo-vault",
					location: "eastus",
					properties: {
						enablePurgeProtection: true,
						enableRbacAuthorization: true,
						tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
					},
				},
			},
		});
		const base = productFor(AZURE_KEY_VAULT_PRODUCT_ID);
		const outcome = await resolverFor(AZURE_KEY_VAULT_PRODUCT_ID).reconcile(
			requestFor(base, {
				desired: { ...base.desired, purgeProtection: false },
			}),
			arm.transport,
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.diagnostics.join(" ")).toContain("permanent");
		expect(arm.countOf("PATCH", vaultPath)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Transport guard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Azure Cache for Redis
// ---------------------------------------------------------------------------

const REDIS = productFor(AZURE_REDIS_CACHE_PRODUCT_ID);

describe("azure cache for redis", () => {
	it("sends the sku family that goes with the tier, not the tier's first letter", async () => {
		// Basic and Standard are both family C; only Premium is P. A family
		// derived by initial letter would send "S" and ARM would reject it in a
		// way that does not say which field was wrong.
		for (const [skuName, family] of [
			["Basic", "C"],
			["Standard", "C"],
			["Premium", "P"],
		] as const) {
			const arm = createArm();
			await resolverFor(REDIS.productId).reconcile(
				requestFor(REDIS, {
					desired: { capacity: 1, location: "eastus", skuName },
				}),
				arm.transport,
			);
			const put = arm.calls.find((call) => call.method === "PUT");
			expect(jsonProperties(put).sku).toEqual({
				capacity: 1,
				family,
				name: skuName,
			});
		}
	});

	it("refuses to choose a tier, and says why", async () => {
		const arm = createArm();
		const message = await messageOf(() =>
			resolverFor(REDIS.productId).reconcile(
				requestFor(REDIS, { desired: { location: "eastus" } }),
				arm.transport,
			),
		);
		expect(message).toContain("desired.skuName is required");
		expect(message).toMatch(/differ by an order of magnitude/u);
	});

	it("defaults capacity within the named tier, visibly", async () => {
		// The tier is the bill decision and is refused above; the size *within*
		// a tier the caller already chose has a documented floor, so it defaults
		// and says so rather than refusing a second time.
		const arm = createArm();
		const outcome = await resolverFor(REDIS.productId).reconcile(
			requestFor(REDIS, {
				desired: { location: "eastus", skuName: "Standard" },
			}),
			arm.transport,
		);
		expect(outcome.diagnostics.join(" ")).toMatch(/capacity was not declared/u);
		const put = arm.calls.find((call) => call.method === "PUT");
		expect(jsonProperties(put).sku).toEqual({
			capacity: 0,
			family: "C",
			name: "Standard",
		});
	});

	it("refuses an unknown tier rather than passing it through", async () => {
		const arm = createArm();
		expect(
			await messageOf(() =>
				resolverFor(REDIS.productId).reconcile(
					requestFor(REDIS, {
						desired: { location: "eastus", skuName: "Enterprise" },
					}),
					arm.transport,
				),
			),
		).toMatch(/is not one of Basic, Premium, Standard/u);
	});

	it("refuses clustering on a tier that cannot host it", async () => {
		const arm = createArm();
		expect(
			await messageOf(() =>
				resolverFor(REDIS.productId).reconcile(
					requestFor(REDIS, {
						desired: { clustered: true, location: "eastus", skuName: "Basic" },
					}),
					arm.transport,
				),
			),
		).toMatch(/only on the Premium tier/u);
		expect(arm.calls.some((call) => call.method === "PUT")).toBe(false);
	});

	it("scales capacity within the observed tier and reports a tier change instead of making one", async () => {
		const arm = createArm();
		const resolver = resolverFor(REDIS.productId);
		await resolver.reconcile(
			requestFor(REDIS, {
				desired: { capacity: 1, location: "eastus", skuName: "Standard" },
			}),
			arm.transport,
		);
		const scaled = await resolver.reconcile(
			requestFor(REDIS, {
				desired: { capacity: 3, location: "eastus", skuName: "Premium" },
			}),
			arm.transport,
		);
		expect(scaled.action).toBe("update");
		const patch = arm.calls.find((call) => call.method === "PATCH");
		// Scaled within Standard — the declared Premium is *not* applied, because
		// a tier change is a migration with a service interruption.
		expect(jsonProperties(patch).sku).toEqual({
			capacity: 3,
			family: "C",
			name: "Standard",
		});
		expect(scaled.diagnostics.join(" ")).toMatch(
			/on the Standard tier but skuName asks for Premium/u,
		);
	});

	it("reports un-clustering as impossible rather than attempting it", async () => {
		const arm = createArm();
		const resolver = resolverFor(REDIS.productId);
		await resolver.reconcile(
			requestFor(REDIS, {
				desired: {
					capacity: 1,
					clustered: true,
					location: "eastus",
					skuName: "Premium",
				},
			}),
			arm.transport,
		);
		const outcome = await resolver.reconcile(
			requestFor(REDIS, {
				desired: {
					capacity: 1,
					clustered: false,
					location: "eastus",
					skuName: "Premium",
				},
			}),
			arm.transport,
		);
		expect(outcome.action).not.toBe("replace");
		expect(outcome.diagnostics.join(" ")).toMatch(/no path back/u);
	});

	it("reports a location change rather than moving the cache", async () => {
		const arm = createArm();
		const resolver = resolverFor(REDIS.productId);
		await resolver.reconcile(
			requestFor(REDIS, {
				desired: { capacity: 1, location: "eastus", skuName: "Standard" },
			}),
			arm.transport,
		);
		const outcome = await resolver.reconcile(
			requestFor(REDIS, {
				desired: { capacity: 1, location: "westeurope", skuName: "Standard" },
			}),
			arm.transport,
		);
		expect(outcome.diagnostics.join(" ")).toMatch(
			/location is immutable and this resolver never replaces a cache/u,
		);
	});
});

// ---------------------------------------------------------------------------
// Cosmos DB Table API
// ---------------------------------------------------------------------------

const TABLE = productFor(AZURE_COSMOS_TABLE_PRODUCT_ID);

const TABLE_THROUGHPUT_PATH = `${TABLE_ACCOUNT_PATH}/tables/sessions/throughputSettings/default`;

describe("azure cosmos table", () => {
	it("refuses an account that does not exist rather than creating one", async () => {
		const arm = createArm();
		const message = await messageOf(() =>
			resolverFor(TABLE.productId).reconcile(requestFor(TABLE), arm.transport),
		);
		expect(message).toMatch(/does not exist in resource group/u);
		expect(message).toMatch(/never creates an account/u);
		expect(arm.calls.some((call) => call.method === "PUT")).toBe(false);
	});

	it("refuses an account without the EnableTable capability", async () => {
		// Capabilities are fixed at account creation, so this is not something a
		// resolver can fix — and without the check the table PUT fails at ARM with
		// an error that does not say which of the two resources is wrong.
		const arm = createArm({ seed: cosmosAccountSeed([]) });
		const message = await messageOf(() =>
			resolverFor(TABLE.productId).reconcile(requestFor(TABLE), arm.transport),
		);
		expect(message).toMatch(/does not carry the EnableTable capability/u);
		expect(arm.calls.some((call) => call.method === "PUT")).toBe(false);
	});

	it("refuses to guess which account the table lives in", async () => {
		const arm = createArm({ seed: TABLE_ACCOUNT_SEED });
		expect(
			await messageOf(() =>
				resolverFor(TABLE.productId).reconcile(
					requestFor(TABLE, { desired: {} }),
					arm.transport,
				),
			),
		).toContain("desired.databaseAccount is required");
	});

	it("sends the table id and the declared throughput on the create", async () => {
		const arm = createArm({ seed: TABLE_ACCOUNT_SEED });
		await resolverFor(TABLE.productId).reconcile(
			requestFor(TABLE),
			arm.transport,
		);
		const put = arm.calls.find(
			(call) => call.method === "PUT" && call.path === TABLE.resourcePath,
		);
		expect(jsonBody(put)).toEqual({
			properties: {
				options: { throughput: 400 },
				resource: { id: "sessions" },
			},
		});
	});

	it("omits options entirely on a serverless account", async () => {
		// An empty options bag is not the same as no options: ARM rejects a
		// throughput on an account that has none.
		const arm = createArm({
			seed: cosmosAccountSeed(["EnableTable", "EnableServerless"]),
		});
		await resolverFor(TABLE.productId).reconcile(
			requestFor(TABLE, { desired: { databaseAccount: TABLE_ACCOUNT } }),
			arm.transport,
		);
		const put = arm.calls.find(
			(call) => call.method === "PUT" && call.path === TABLE.resourcePath,
		);
		expect(jsonBody(put)).toEqual({
			properties: { resource: { id: "sessions" } },
		});
	});

	it("refuses a throughput on a serverless account", async () => {
		const arm = createArm({
			seed: cosmosAccountSeed(["EnableTable", "EnableServerless"]),
		});
		expect(
			await messageOf(() =>
				resolverFor(TABLE.productId).reconcile(
					requestFor(TABLE),
					arm.transport,
				),
			),
		).toMatch(/the account is serverless/u);
	});

	it("refuses serverless mode on an account that is not serverless", async () => {
		const arm = createArm({ seed: TABLE_ACCOUNT_SEED });
		expect(
			await messageOf(() =>
				resolverFor(TABLE.productId).reconcile(
					requestFor(TABLE, {
						desired: {
							databaseAccount: TABLE_ACCOUNT,
							throughputMode: "serverless",
						},
					}),
					arm.transport,
				),
			),
		).toMatch(/fixed at creation, so it cannot be set per table/u);
	});

	it("scales through throughputSettings/default, never by re-PUTting the table", async () => {
		const arm = createArm({
			seed: {
				...TABLE_ACCOUNT_SEED,
				[TABLE.resourcePath]: {
					id: TABLE.resourcePath,
					name: "sessions",
					properties: { resource: { id: "sessions" } },
				},
				[TABLE_THROUGHPUT_PATH]: {
					id: TABLE_THROUGHPUT_PATH,
					name: "default",
					properties: { resource: { throughput: 400 } },
				},
			},
		});
		const outcome = await resolverFor(TABLE.productId).reconcile(
			requestFor(TABLE, {
				desired: { databaseAccount: TABLE_ACCOUNT, throughputRu: 1000 },
			}),
			arm.transport,
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.throughput).toBe(1000);
		expect(arm.countOf("PUT", TABLE_THROUGHPUT_PATH)).toBe(1);
		// The table definition itself is untouched: re-PUTting it to change a
		// throughput would rewrite the table.
		expect(arm.countOf("PUT", TABLE.resourcePath)).toBe(0);
		expect(outcome.diagnostics.join(" ")).toMatch(/1000 RU\/s \(was 400\)/u);
	});

	it("reports a declared throughput it cannot compare against, rather than writing it every run", async () => {
		// A blind PUT with nothing to compare to is a PUT on every reconcile,
		// which is exactly the non-convergence this module refuses.
		const arm = createArm({
			seed: {
				...TABLE_ACCOUNT_SEED,
				[TABLE.resourcePath]: {
					id: TABLE.resourcePath,
					name: "sessions",
					properties: { resource: { id: "sessions" } },
				},
			},
		});
		const outcome = await resolverFor(TABLE.productId).reconcile(
			requestFor(TABLE),
			arm.transport,
		);
		expect(outcome.action).toBe("adopt");
		expect(arm.calls.every((call) => call.method === "GET")).toBe(true);
		expect(outcome.diagnostics.join(" ")).toMatch(
			/no throughputSettings\/default for this table/u,
		);
	});

	it("refuses a throughputMode outside the binding's vocabulary", async () => {
		const arm = createArm({ seed: TABLE_ACCOUNT_SEED });
		expect(
			await messageOf(() =>
				resolverFor(TABLE.productId).reconcile(
					requestFor(TABLE, {
						desired: {
							databaseAccount: TABLE_ACCOUNT,
							throughputMode: "autoscale",
						},
					}),
					arm.transport,
				),
			),
		).toMatch(/is not one of provisioned, serverless/u);
	});
});

describe("azureOperationUrl: the one URL ARM chooses for us", () => {
	// Every other URL in this package is composed from a subscription, a
	// resource group and a name this repo controls. This one comes out of an
	// `Azure-AsyncOperation` or `Location` *response header*, which makes the
	// next URL the client calls attacker-influenced by construction — and it is
	// called with the bearer token attached. Returning `undefined` is how the
	// resolver refuses to follow; the resolver then reports the write as
	// accepted-but-unconfirmed rather than chasing it.
	const API_VERSION = "2023-05-01";

	it("accepts an operation URL on the allowlisted ARM surface", () => {
		const url = azureOperationUrl(
			`https://management.azure.com${GROUP_PREFIX}/providers/Microsoft.Test/operations/op-1`,
			API_VERSION,
		);
		expect(url).toContain("management.azure.com");
		expect(url).toContain(`api-version=${API_VERSION}`);
	});

	it("refuses a foreign host, however plausible it looks", () => {
		for (const hostile of [
			"https://management.azure.com.evil.example/subscriptions/x",
			"https://attacker.example.com/subscriptions/steal",
			"https://management-azure.com/subscriptions/x",
		]) {
			expect(azureOperationUrl(hostile, API_VERSION)).toBeUndefined();
		}
	});

	it("refuses plain http even on the right host", () => {
		expect(
			azureOperationUrl(
				"http://management.azure.com/subscriptions/x/operations/op-1",
				API_VERSION,
			),
		).toBeUndefined();
	});

	it("refuses a path off the subscription-scoped prefix", () => {
		expect(
			azureOperationUrl(
				"https://management.azure.com/tenants/steal",
				API_VERSION,
			),
		).toBeUndefined();
	});

	it("refuses text that is not a URL at all", () => {
		for (const junk of [
			"",
			"not-a-url",
			"//management.azure.com/subscriptions/x",
		]) {
			expect(azureOperationUrl(junk, API_VERSION)).toBeUndefined();
		}
	});

	it("supplies the api-version ARM omitted, and keeps one it sent", () => {
		const supplied = azureOperationUrl(
			"https://management.azure.com/subscriptions/x/operations/op-1",
			API_VERSION,
		);
		expect(supplied).toContain(`api-version=${API_VERSION}`);
		const kept = azureOperationUrl(
			"https://management.azure.com/subscriptions/x/operations/op-1?api-version=2021-01-01",
			API_VERSION,
		);
		expect(kept).toContain("api-version=2021-01-01");
		expect(kept).not.toContain(API_VERSION);
	});

	it("refuses to build an ARM url without an explicit api-version", () => {
		// ARM serializes a *different* resource model for the wrong version, so
		// a defaulted one is how a declared field quietly stops applying.
		expect(() => azureArmUrl("/subscriptions/x", "")).toThrow(/api-version/u);
		expect(() => azureArmUrl("/subscriptions/x", "   ")).toThrow(
			/api-version/u,
		);
	});
});

describe("azure transport guard", () => {
	it("refuses a host that is not management.azure.com", async () => {
		const guarded = guardedAzureTransport(() =>
			Promise.resolve({ status: 200, headers: {}, body: "{}" }),
		);
		await expect(
			guarded({
				method: "GET",
				url: "https://attacker.example.com/subscriptions/x",
				headers: {},
				timeoutMs: 1_000,
				maxResponseBytes: 1_000,
			}),
		).rejects.toThrow(/not exactly one of the allowlisted/u);
	});

	it("refuses a path outside the subscription scope", async () => {
		const guarded = guardedAzureTransport(() =>
			Promise.resolve({ status: 200, headers: {}, body: "{}" }),
		);
		await expect(
			guarded({
				method: "GET",
				url: "https://management.azure.com/tenants",
				headers: {},
				timeoutMs: 1_000,
				maxResponseBytes: 1_000,
			}),
		).rejects.toThrow(/outside the allowlisted prefixes/u);
	});
});

describe("redactAzureText", () => {
	it("scrubs token-shaped runs and bounds the length", () => {
		expect(redactAzureText(`token ${LEAKED_SECRET} used`)).toBe(
			"token [redacted] used",
		);
		expect(redactAzureText("x".repeat(600), 40).length).toBeLessThanOrEqual(41);
	});
});
