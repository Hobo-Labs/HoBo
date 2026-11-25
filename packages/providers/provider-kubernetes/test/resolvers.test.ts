/**
 * Kubernetes resolver tests, driven entirely through an injected fake
 * `HttpTransport`.
 *
 * The fake is the whole apiserver: that is what lets a test assert "reconcile
 * twice made exactly one create call" at all, which is the property the
 * resolvers exist to have. Nothing here touches a network, a credential, or a
 * cluster — see the HONEST SCOPE section of `src/resolvers.ts`.
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
	type ResolverError,
	type ResourceResolver,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	guardedKubernetesTransport,
	KUBERNETES_CRONJOB_PRODUCT_ID,
	KUBERNETES_DEFAULT_BINDINGS,
	KUBERNETES_DEPLOYMENT_PRODUCT_ID,
	KUBERNETES_JOB_PRODUCT_ID,
	KUBERNETES_PVC_PRODUCT_ID,
	KUBERNETES_RESOLVED_PRODUCT_IDS,
	KUBERNETES_SECRET_PRODUCT_ID,
	KUBERNETES_SERVICE_PRODUCT_ID,
	KUBERNETES_UNRESOLVED_PRODUCT_IDS,
	type KubernetesResolverOptions,
	kubernetesResolverRegistry,
	kubernetesResolvers,
	RESOLVER_ALLOWED_PATH_PREFIXES,
} from "../src/index.js";
import { isJsonString, type JsonObject, type JsonValue } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/provider-kubernetes-boundary.pact.json"),
		"utf8",
	),
);

const API_SERVER = "https://cluster.example:6443";
const CREDENTIAL_REF = "secret://camp/cluster-token";
/** A compact JWS, as a projected ServiceAccount token looks. */
const TOKEN =
	"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQ6c2hvcDpob2JvIn0.c2lnbmF0dXJlLXZhbHVl";

type Rec = JsonObject;

interface RecordedCall {
	readonly method: string;
	readonly host: string;
	readonly path: string;
	readonly body: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

interface Fake {
	readonly transport: HttpTransport;
	readonly calls: readonly RecordedCall[];
	countOf(method: string): number;
}

function record(request: TransportRequest): RecordedCall {
	const url = new URL(request.url);
	return {
		method: request.method,
		host: url.host,
		path: url.pathname,
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
		countOf(method) {
			return calls.filter((call) => call.method === method).length;
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

function status(
	code: number,
	reason: string,
	message: string,
): TransportResponse {
	return json(code, {
		kind: "Status",
		apiVersion: "v1",
		status: "Failure",
		reason,
		message,
		code,
	});
}

function notFound(): TransportResponse {
	return status(
		404,
		"NotFound",
		"the server could not find the requested resource",
	);
}

function bodyOf(call: RecordedCall): Rec {
	// SAFETY: assertion to `ON.parse(call.body) as Rec);` is required at this boundary.
	return call.body === undefined ? {} : (JSON.parse(call.body) as Rec);
}

function options(
	overrides: Partial<KubernetesResolverOptions> = {},
): KubernetesResolverOptions {
	return {
		apiServerUrl: API_SERVER,
		resolveCredential: async () => TOKEN,
		resolveSecretData: async () => SECRET_MATERIAL,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<KubernetesResolverOptions> = {},
): ResourceResolver {
	const resolver = kubernetesResolverRegistry(options(overrides)).get(
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
		// SAFETY: assertion to `ror as ResolverError).` is required at this boundary.
		return (error as ResolverError).code ?? "NO_CODE";
	}
	return "NO_ERROR_THROWN";
}

it("never retargets a known physical resource through changed desired name or namespace", async () => {
	const fake = fakeTransport(() =>
		json(200, { metadata: { name: "victim", namespace: "other" } }),
	);
	const resolver = resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID);
	const moved = request({
		slot: "service",
		productId: KUBERNETES_DEPLOYMENT_PRODUCT_ID,
		logicalId: "app",
		physicalId: "owned/app",
		desired: { namespace: "other", name: "victim", spec: {} },
	});
	await expect(resolver.delete(moved, fake.transport)).rejects.toThrow(
		/physical identity/u,
	);
	expect(fake.calls).toHaveLength(0);
});

async function messageOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		// SAFETY: assertion to `ror as Error).` is required at this boundary.
		return (error as Error).message;
	}
	return "NO_ERROR_THROWN";
}

/** Every outcome must survive core's outcome parse boundary. */
function checked(outcome: ResolveOutcome): ResolveOutcome {
	return parseResolveOutcome(outcome);
}

// ---------------------------------------------------------------------------
// A fake apiserver holding one namespaced collection
// ---------------------------------------------------------------------------

/**
 * Models one kind's collection under one namespace: GET/POST/PATCH/DELETE at
 * the paths the resolvers compose, and 404 for anything not stored.
 */
function collection(
	collectionPath: string,
	initial?: Rec,
): (call: RecordedCall) => TransportResponse {
	let object = initial;
	const itemPath = `${collectionPath}/api`;
	return (call) => {
		if (call.method === "GET" && call.path === itemPath) {
			return object === undefined ? notFound() : json(200, object);
		}
		if (call.method === "POST" && call.path === collectionPath) {
			const sent = bodyOf(call);
			object = {
				...sent,
				metadata: {
					// SAFETY: assertion to `nt.metadata as Rec) ` is required at this boundary.
					...(sent.metadata as Rec),
					uid: "11111111-2222-3333-4444-555555555555",
				},
			};
			return json(201, object);
		}
		if (call.method === "PATCH" && call.path === itemPath) {
			const sent = bodyOf(call);
			// SAFETY: assertion to `ject as Rec),` is required at this boundary.
			object = { ...(object as Rec), spec: sent.spec };
			return json(200, object);
		}
		if (call.method === "DELETE" && call.path === itemPath) {
			if (object === undefined) return notFound();
			object = undefined;
			return json(200, { kind: "Status", status: "Success" });
		}
		return status(
			500,
			"InternalError",
			`unexpected ${call.method} ${call.path}`,
		);
	};
}

const DEPLOYMENTS = "/apis/apps/v1/namespaces/shop/deployments";
const SERVICES = "/api/v1/namespaces/shop/services";
const JOBS = "/apis/batch/v1/namespaces/shop/jobs";
const CRONJOBS = "/apis/batch/v1/namespaces/shop/cronjobs";
const PVCS = "/api/v1/namespaces/shop/persistentvolumeclaims";

const DEPLOYMENT_REQUEST = {
	slot: "web",
	productId: KUBERNETES_DEPLOYMENT_PRODUCT_ID,
	logicalId: "api",
	desired: { namespace: "shop", spec: { replicas: 2 } },
} as const;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

const SECRET_NAMESPACE = "shop";
const SECRET_PATH = `/api/v1/namespaces/${SECRET_NAMESPACE}/secrets`;
const SECRET_OBJECT_PATH = `${SECRET_PATH}/api-credentials`;
/** Material the host's custody hands over. Never expected outside one body. */
const SECRET_MATERIAL = Object.freeze({
	password: "c0rrect-horse-battery-staple",
	// Non-ASCII on purpose: latin1 base64 would corrupt it.
	note: "naïve-café-😀",
});

function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function secretRecord(data: Rec, overrides: Rec = {}): Rec {
	return {
		apiVersion: "v1",
		kind: "Secret",
		metadata: {
			name: "api-credentials",
			namespace: SECRET_NAMESPACE,
			uid: "11111111-2222-3333-4444-555555555555",
		},
		type: "Opaque",
		data,
		...overrides,
	};
}

function secretRequest(desired: Rec = {}): ResolveRequest {
	return request({
		slot: "secretRef",
		productId: KUBERNETES_SECRET_PRODUCT_ID,
		logicalId: "api-credentials",
		desired: { namespace: SECRET_NAMESPACE, ...desired },
	});
}

/** A cluster that starts without the Secret and remembers what was written. */
function secretWorld(): Fake {
	let existing: Rec | undefined;
	return fakeTransport((call) => {
		if (call.method === "GET" && call.path === SECRET_OBJECT_PATH) {
			return existing === undefined ? notFound() : json(200, existing);
		}
		if (call.method === "POST" && call.path === SECRET_PATH) {
			existing = bodyOf(call);
			return json(201, existing);
		}
		if (call.method === "PATCH" && call.path === SECRET_OBJECT_PATH) {
			existing = { ...existing, ...bodyOf(call) };
			return json(200, existing);
		}
		if (call.method === "DELETE" && call.path === SECRET_OBJECT_PATH) {
			existing = undefined;
			return json(200, { kind: "Status", status: "Success" });
		}
		return json(500, { message: `unexpected ${call.method} ${call.path}` });
	});
}

/** Every place a value could escape: outputs, diagnostics, and the URL. */
function leaks(outcome: ResolveOutcome, fake: Fake): boolean {
	const surfaces = [
		JSON.stringify(outcome.outputs),
		JSON.stringify(outcome.diagnostics),
		...fake.calls.map((call) => call.path),
	];
	return Object.values(SECRET_MATERIAL).some((value) =>
		surfaces.some((surface) => surface.includes(value)),
	);
}

describe("the Secret resolver converges material that never reaches the log", () => {
	it("creates a Secret from the host's custody", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(secretRequest(), fake.transport),
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe(`${SECRET_NAMESPACE}/api-credentials`);
		const create = fake.calls.find((call) => call.method === "POST");
		// SAFETY: assertion to ` as RecordedCall).data` is required at this boundary.
		const data = bodyOf(create as RecordedCall).data as Rec;
		expect(data.password).toBe(base64Utf8(SECRET_MATERIAL.password));
	});

	/** `btoa` alone is latin1 and would corrupt this. */
	it("base64-encodes UTF-8, not latin1", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		await resolver.reconcile(secretRequest(), fake.transport);
		const create = fake.calls.find((call) => call.method === "POST");
		// SAFETY: assertion to ` as RecordedCall).data` is required at this boundary.
		const data = bodyOf(create as RecordedCall).data as Rec;
		expect(data.note).toBe(base64Utf8(SECRET_MATERIAL.note));
	});

	/** The property the whole design exists to have. */
	it("reconciles twice into one Secret and one create", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		const first = await resolver.reconcile(secretRequest(), fake.transport);
		const second = parseResolveOutcome(
			await resolver.reconcile(secretRequest(), fake.transport),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(fake.countOf("POST")).toBe(1);
		expect(fake.countOf("PATCH")).toBe(0);
	});

	/** The load-bearing test: material goes in the body and nowhere else. */
	it("publishes key names and never a value", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		const created = parseResolveOutcome(
			await resolver.reconcile(secretRequest(), fake.transport),
		);
		expect(created.outputs.keys).toEqual(["note", "password"]);
		expect(created.outputs.locator).toBe(
			`k8s://${SECRET_NAMESPACE}/api-credentials`,
		);
		expect(leaks(created, fake)).toBe(false);
		const rotated = parseResolveOutcome(
			await resolver.reconcile(secretRequest(), fake.transport),
		);
		expect(leaks(rotated, fake)).toBe(false);
	});

	it("converges a rotation without naming what changed", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		await resolver.reconcile(secretRequest(), fake.transport);
		const rotated = "a-completely-different-secret";
		const withNewMaterial = resolverFor(KUBERNETES_SECRET_PRODUCT_ID, {
			resolveSecretData: async () => ({
				...SECRET_MATERIAL,
				password: rotated,
			}),
		});
		const outcome = parseResolveOutcome(
			await withNewMaterial.reconcile(secretRequest(), fake.transport),
		);
		expect(outcome.action).toBe("update");
		const patch = fake.calls.find((call) => call.method === "PATCH");
		// SAFETY: assertion to `as RecordedCall).data` is required at this boundary.
		expect((bodyOf(patch as RecordedCall).data as Rec).password).toBe(
			base64Utf8(rotated),
		);
		// Neither the old nor the new value is named anywhere readable.
		expect(JSON.stringify(outcome.diagnostics)).not.toContain(rotated);
		expect(JSON.stringify(outcome.outputs)).not.toContain(rotated);
	});

	it("reports drift rather than attempting an immutable type change", async () => {
		const fake = fakeTransport((call) =>
			call.method === "GET"
				? json(
						200,
						secretRecord(
							{ password: base64Utf8(SECRET_MATERIAL.password) },
							{ type: "kubernetes.io/dockerconfigjson" },
						),
					)
				: json(500, { message: "the resolver should not have written" }),
		);
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		const outcome = parseResolveOutcome(
			await resolver.reconcile(secretRequest(), fake.transport),
		);
		expect(outcome.diagnostics.join(" ")).toContain("immutable");
		expect(fake.countOf("PATCH")).toBe(0);
	});

	it("refuses to create when the host wired no Secret custody", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID, {
			resolveSecretData: undefined,
		});
		expect(
			await codeOf(() => resolver.reconcile(secretRequest(), fake.transport)),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(fake.countOf("POST")).toBe(0);
	});

	it("refuses an empty Secret rather than failing at mount time", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID, {
			resolveSecretData: async () => ({}),
		});
		expect(
			await codeOf(() => resolver.reconcile(secretRequest(), fake.transport)),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(fake.countOf("POST")).toBe(0);
	});

	/** A read needs no material, so the host's custody is never touched. */
	it("never asks for material on a read", async () => {
		let asked = 0;
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID, {
			resolveSecretData: async () => {
				asked += 1;
				return SECRET_MATERIAL;
			},
		});
		await resolver.reconcile(secretRequest(), fake.transport);
		await resolver.read(secretRequest(), fake.transport);
		expect(asked).toBe(1);
	});

	it("cannot express material in desired at all", () => {
		expect(() => secretRequest({ data: { password: "hunter2" } })).toThrow(
			/credential/i,
		);
		expect(() => secretRequest({ stringData: { token: "abc" } })).toThrow(
			/credential/i,
		);
	});

	it("treats an already-absent Secret as a successful delete", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		await expect(
			resolver.delete(secretRequest(), fake.transport),
		).resolves.toBeUndefined();
	});

	it("deletes a Secret it created, and reads back absent afterwards", async () => {
		const fake = secretWorld();
		const resolver = resolverFor(KUBERNETES_SECRET_PRODUCT_ID);
		await resolver.reconcile(secretRequest(), fake.transport);
		await resolver.delete(secretRequest(), fake.transport);
		expect(
			await resolver.read(secretRequest(), fake.transport),
		).toBeUndefined();
	});
});

describe("the registry covers the built-in objects and only those", () => {
	it("registers a resolver for every resolved product id", () => {
		const registry = kubernetesResolverRegistry(options());
		for (const productId of KUBERNETES_RESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)?.productId).toBe(productId);
		}
	});

	/**
	 * The Secret used to be excluded on the grounds that creating one means
	 * putting material in `desired`. It does not: the contents arrive through
	 * an injected resolver, the same way every other credential in this repo
	 * does, so `desired` stays clean and the object still converges.
	 */
	it("leaves no catalogued object without a resolver", () => {
		const registry = kubernetesResolverRegistry(options());
		expect(KUBERNETES_UNRESOLVED_PRODUCT_IDS).toEqual([]);
		expect(registry.get(KUBERNETES_SECRET_PRODUCT_ID)?.productId).toBe(
			KUBERNETES_SECRET_PRODUCT_ID,
		);
	});

	it("accounts for every catalogued product exactly once", () => {
		const catalogued = new Set(
			Object.values(KUBERNETES_DEFAULT_BINDINGS)
				.flatMap((entries) => [...(entries ?? [])])
				.map((entry) => entry.productId)
				.filter((id): id is string => isJsonString(id)),
		);
		const accounted = [
			...KUBERNETES_RESOLVED_PRODUCT_IDS,
			...KUBERNETES_UNRESOLVED_PRODUCT_IDS,
		].sort();
		expect(accounted).toEqual([...catalogued].sort());
		expect(new Set(accounted).size).toBe(accounted.length);
	});

	it("lists resolvers in id order and stamps the provider target", () => {
		const resolvers = kubernetesResolvers(options());
		const productIds = resolvers.map((entry) => entry.productId);
		expect(productIds).toEqual(productIds.toSorted());
		for (const resolver of resolvers) {
			expect(resolver.providerId).toBe("kubernetes");
		}
	});
});

describe("built-in objects converge", () => {
	it("creates an object that is absent, then makes no second create", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const resolver = resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID);
		const first = checked(
			await resolver.reconcile(request(DEPLOYMENT_REQUEST), fake.transport),
		);
		const second = checked(
			await resolver.reconcile(request(DEPLOYMENT_REQUEST), fake.transport),
		);
		expect(first.action).toBe("create");
		expect(second.action).toBe("adopt");
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST")).toBe(1);
	});

	it("matches the reconcile-twice interaction the pact records", async () => {
		const interaction = pact.interactions.find(
			(entry: { description: string }) =>
				entry.description ===
				"reconcile a Deployment twice: one create call, one stable physicalId",
		);
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const resolver = resolverFor(interaction.request.body.productId);
		const first = checked(
			await resolver.reconcile(
				request({
					slot: "web",
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
					slot: "web",
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
		expect(first.physicalId).toBe(interaction.response.body.physicalId);
		expect(fake.countOf("POST")).toBe(interaction.response.body.createCalls);
		expect(second.action).toBe(interaction.response.body.reconcileTwiceAction);
	});

	it("sends the object the request authored, with name and namespace it owns", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		await resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
			request({
				...DEPLOYMENT_REQUEST,
				desired: {
					namespace: "shop",
					spec: { replicas: 2 },
					labels: { "app.kubernetes.io/name": "api" },
				},
			}),
			fake.transport,
		);
		const create = fake.calls.find((call) => call.method === "POST");
		// SAFETY: assertion to ` as RecordedCall); e` is required at this boundary.
		const sent = bodyOf(create as RecordedCall);
		expect(sent.apiVersion).toBe("apps/v1");
		expect(sent.kind).toBe("Deployment");
		expect(sent.metadata).toEqual({
			name: "api",
			namespace: "shop",
			labels: { "app.kubernetes.io/name": "api" },
		});
		expect(sent.spec).toEqual({ replicas: 2 });
	});

	it("patches a mutable spec with a merge patch, not a strategic one", async () => {
		const fake = fakeTransport(
			collection(DEPLOYMENTS, {
				apiVersion: "apps/v1",
				kind: "Deployment",
				metadata: { name: "api", namespace: "shop", uid: "abc" },
				spec: { replicas: 1 },
			}),
		);
		const outcome = checked(
			await resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				request(DEPLOYMENT_REQUEST),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("update");
		const patch = fake.calls.find((call) => call.method === "PATCH");
		expect(patch?.headers["content-type"]).toBe("application/merge-patch+json");
		// SAFETY: assertion to `as RecordedCall)).toE` is required at this boundary.
		expect(bodyOf(patch as RecordedCall)).toEqual({ spec: { replicas: 2 } });
	});

	it("publishes the in-cluster DNS name for a Service and no external URL", async () => {
		const fake = fakeTransport(collection(SERVICES));
		const outcome = checked(
			await resolverFor(KUBERNETES_SERVICE_PRODUCT_ID).reconcile(
				request({
					slot: "api",
					productId: KUBERNETES_SERVICE_PRODUCT_ID,
					logicalId: "api",
					desired: { namespace: "shop", spec: { ports: [{ port: 80 }] } },
				}),
				fake.transport,
			),
		);
		expect(outcome.outputs.clusterDns).toBe("api.shop.svc.cluster.local");
		expect(JSON.stringify(outcome.outputs)).not.toContain("http");
	});

	it("routes each kind to its own API root", async () => {
		for (const [productId, slot, path] of [
			[KUBERNETES_JOB_PRODUCT_ID, "service", JOBS],
			[KUBERNETES_CRONJOB_PRODUCT_ID, "service", CRONJOBS],
			[KUBERNETES_PVC_PRODUCT_ID, "bucket", PVCS],
		] as const) {
			const fake = fakeTransport(collection(path));
			await resolverFor(productId).reconcile(
				request({
					slot,
					productId,
					logicalId: "api",
					desired: { namespace: "shop", spec: {} },
				}),
				fake.transport,
			);
			expect(fake.calls.every((call) => call.path.startsWith(path))).toBe(true);
		}
	});

	it("deletes what exists and treats already-gone as success", async () => {
		const fake = fakeTransport(
			collection(DEPLOYMENTS, {
				apiVersion: "apps/v1",
				kind: "Deployment",
				metadata: { name: "api", namespace: "shop" },
				spec: { replicas: 2 },
			}),
		);
		const resolver = resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID);
		await resolver.delete(request(DEPLOYMENT_REQUEST), fake.transport);
		await expect(
			resolver.delete(request(DEPLOYMENT_REQUEST), fake.transport),
		).resolves.toBeUndefined();
	});

	it("read answers undefined for an object that is not there", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		await expect(
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).read(
				request(DEPLOYMENT_REQUEST),
				fake.transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("immutable specs are reported, never converged", () => {
	/**
	 * A Job's pod template is immutable and a PVC's storage class is fixed at
	 * creation; "converging" either means deleting the object, which for a PVC
	 * destroys data and for a Job discards a completed run.
	 */
	it.each([
		[KUBERNETES_JOB_PRODUCT_ID, "service", JOBS],
		[KUBERNETES_PVC_PRODUCT_ID, "bucket", PVCS],
	] as const)("reports drift on %s rather than patching it", async (productId, slot, path) => {
		const fake = fakeTransport(
			collection(path, {
				metadata: { name: "api", namespace: "shop" },
				spec: { parallelism: 1 },
			}),
		);
		const outcome = checked(
			await resolverFor(productId).reconcile(
				request({
					slot,
					productId,
					logicalId: "api",
					desired: { namespace: "shop", spec: { parallelism: 4 } },
				}),
				fake.transport,
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(fake.countOf("PATCH")).toBe(0);
		expect(outcome.diagnostics.join(" ")).toContain("fixed at creation");
	});
});

describe("the namespace is never defaulted", () => {
	it("refuses a request that names no namespace", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const message = await messageOf(() =>
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				request({
					...DEPLOYMENT_REQUEST,
					desired: { spec: { replicas: 2 } },
				}),
				fake.transport,
			),
		);
		expect(message).toContain('never falls back to "default"');
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses a name the apiserver would reject anyway", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const code = await codeOf(() =>
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				request({
					...DEPLOYMENT_REQUEST,
					desired: {
						name: "Not_A_Valid_Name",
						namespace: "shop",
						spec: {},
					},
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses to invent a spec", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const message = await messageOf(() =>
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				request({ ...DEPLOYMENT_REQUEST, desired: { namespace: "shop" } }),
				fake.transport,
			),
		);
		expect(message).toContain("desired.spec");
	});
});

describe("credentials are locators and never leak", () => {
	it("sends the token in exactly one place: the authorization header", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const outcome = checked(
			await resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				request(DEPLOYMENT_REQUEST),
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

	it("refuses a credentialRef that is the ServiceAccount token itself", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const code = await codeOf(() =>
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				parseResolveRequest({
					ref: {
						slot: "web",
						productId: KUBERNETES_DEPLOYMENT_PRODUCT_ID,
						logicalId: "api",
					},
					desired: { namespace: "shop", spec: {} },
					credentialRef: TOKEN,
				}),
				fake.transport,
			),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(fake.calls).toHaveLength(0);
	});

	it("refuses when the host resolves the locator to nothing", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		const code = await codeOf(() =>
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID, {
				resolveCredential: async () => "",
			}).reconcile(request(DEPLOYMENT_REQUEST), fake.transport),
		);
		expect(code).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	/**
	 * An apiserver `Status` routinely quotes the object that caused it, and
	 * those objects carry ServiceAccount tokens and imagePullSecrets.
	 */
	it("redacts a token the apiserver echoed back in a Status message", async () => {
		const fake = fakeTransport(() =>
			status(403, "Forbidden", `rejected object with token ${TOKEN}`),
		);
		const message = await messageOf(() =>
			resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
				request(DEPLOYMENT_REQUEST),
				fake.transport,
			),
		);
		expect(message).not.toContain(TOKEN);
		expect(message).toContain("[redacted]");
		expect(message).toContain("Forbidden");
	});
});

describe("the transport guard bounds where a token can be sent", () => {
	it("refuses a host that is not the configured apiserver", async () => {
		const guarded = guardedKubernetesTransport(
			async () => json(200, {}),
			API_SERVER,
		);
		await expect(
			guarded({
				method: "GET",
				url: "https://other.example:6443/api/v1/namespaces/shop/services",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow();
	});

	it("refuses an API root outside the allowlist on the right host", async () => {
		const guarded = guardedKubernetesTransport(
			async () => json(200, {}),
			API_SERVER,
		);
		await expect(
			guarded({
				method: "GET",
				url: `${API_SERVER}/apis/rbac.authorization.k8s.io/v1/clusterroles`,
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow();
	});

	/**
	 * The documented capability difference between this path and the driver's:
	 * `kubectl proxy` serves cleartext on loopback, the driver supports it
	 * behind an explicit opt-in, and the resolver path does not — because core's
	 * guard is HTTPS-only and a projected token is in every header here.
	 */
	it("refuses a kubectl-proxy apiserver at construction time, with the reason", () => {
		expect(() =>
			kubernetesResolvers(options({ apiServerUrl: "http://127.0.0.1:8001" })),
		).toThrow(/kubectl proxy/);
	});

	it("refuses an apiserver url that does not parse", () => {
		expect(() =>
			kubernetesResolvers(options({ apiServerUrl: "not a url" })),
		).toThrow();
	});

	it("keeps every real call on the apiserver and inside the allowlist", async () => {
		const fake = fakeTransport(collection(DEPLOYMENTS));
		await resolverFor(KUBERNETES_DEPLOYMENT_PRODUCT_ID).reconcile(
			request(DEPLOYMENT_REQUEST),
			fake.transport,
		);
		for (const call of fake.calls) {
			expect(call.host).toBe("cluster.example:6443");
			expect(
				RESOLVER_ALLOWED_PATH_PREFIXES.some((prefix) =>
					call.path.startsWith(prefix),
				),
			).toBe(true);
		}
	});
});
