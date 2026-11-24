/**
 * Block Storage volumes and DOKS clusters, through an injected fake transport.
 *
 * `resolvers.test.ts` covers the products the first pass shipped; these two had
 * no tests at all, and they are the two where getting it wrong costs the most.
 *
 * **A volume only grows.** DigitalOcean has no shrink, so a request for a
 * smaller size cannot be converged — and the only way to "converge" it would be
 * to replace the volume, which destroys the data on it. The resolver reports
 * the drift and does nothing, which is the same rule the rest of this package
 * follows for immutable fields, applied to the case where the alternative is
 * silent data loss.
 *
 * **No size is invented.** A volume is billed by the gigabyte, so a default
 * size is a recurring charge nobody asked for. `sizeGigabytes` is required on
 * create and refused rather than guessed.
 *
 * **A cluster's version and region are reported, never upgraded.** An upgrade
 * restarts every node in the cluster. Deciding to do that is a human's call,
 * made at a time they chose, not something a reconcile does because the
 * manifest said a different number.
 *
 * **Neither resolver polls.** A volume resize is accepted asynchronously and a
 * cluster comes back `provisioning`; both say so in diagnostics rather than
 * blocking a deploy on the provider's clock — and the resize diagnostic also
 * says the guest filesystem still needs extending, because a grown block device
 * with an unchanged filesystem is a disk that is still full.
 */
import type {
	HttpTransport,
	ResolveOutcome,
	ResolveRequest,
	ResourceResolver,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { parseResolveRequest, ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
	DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
	type DigitalOceanResolverOptions,
	digitaloceanResolverRegistry,
} from "../src/index.js";
import {
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

type Rec = JsonObject;

interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly body: string | undefined;
}

const VOLUMES = "/v2/volumes";
const CLUSTERS = "/v2/kubernetes/clusters";
const TOKEN = "dop_v1_fakepersonalaccesstoken0123456789abcdef";
const CREDENTIAL_REF = "owner://DIGITALOCEAN_TOKEN";

function json(status: number, payload: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	};
}

function fakeTransport(handler: (call: RecordedCall) => TransportResponse) {
	const calls: RecordedCall[] = [];
	const transport: HttpTransport = async (request: TransportRequest) => {
		const url = new URL(request.url);
		const call = {
			method: request.method,
			path: url.pathname,
			search: url.search,
			body: request.body,
		};
		calls.push(call);
		return handler(call);
	};
	return {
		transport,
		calls,
		countOf: (method: string, path: string) =>
			calls.filter((c) => c.method === method && c.path === path).length,
		bodyOf: (i: number) =>
			calls[i]?.body === undefined
				? {}
				: parseJsonObject(String(calls[i]?.body)),
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<DigitalOceanResolverOptions> = {},
): ResourceResolver {
	const resolver = digitaloceanResolverRegistry({
		resolveCredential: async () => TOKEN,
		nowMs: Date.parse("2026-08-19T12:00:00.000Z"),
		...overrides,
	}).get(productId);
	if (resolver === undefined) throw new Error(`no resolver for ${productId}`);
	return resolver;
}

function request(input: {
	readonly productId: string;
	readonly logicalId: string;
	readonly desired?: Rec;
}): ResolveRequest {
	return parseResolveRequest({
		ref: {
			slot: "data",
			productId: input.productId,
			logicalId: input.logicalId,
		},
		desired: input.desired ?? {},
		credentialRef: CREDENTIAL_REF,
	});
}

async function failureOf(
	run: () => Promise<void>,
): Promise<{ code: string; message: string }> {
	try {
		await run();
	} catch (error) {
		if (!(error instanceof ResolverError)) throw error;
		return { code: error.code, message: error.message };
	}
	throw new Error("expected a refusal, but the call succeeded");
}

function volumeApi(initial: Rec[] = []) {
	let volumes = [...initial];
	let nextId = 900 + initial.length;
	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === VOLUMES) {
			return json(200, { volumes, meta: { total: volumes.length } });
		}
		if (call.method === "POST" && call.path === VOLUMES) {
			const sent = JSON.parse(String(call.body)) as Rec;
			const created = {
				id: `vol-${nextId++}`,
				name: sent.name,
				size_gigabytes: sent.size_gigabytes,
				region: { slug: sent.region },
				...(sent.filesystem_type !== undefined
					? { filesystem_type: sent.filesystem_type }
					: undefined),
			};
			volumes.push(created);
			return json(201, { volume: created });
		}
		if (call.method === "POST" && call.path.endsWith("/actions")) {
			const id = call.path.slice(VOLUMES.length + 1, -"/actions".length);
			const sent = JSON.parse(String(call.body)) as Rec;
			volumes = volumes.map((v) =>
				v.id === id ? { ...v, size_gigabytes: sent.size_gigabytes } : v,
			);
			return json(201, { action: { status: "in-progress" } });
		}
		if (call.method === "DELETE" && call.path.startsWith(`${VOLUMES}/`)) {
			const id = call.path.slice(VOLUMES.length + 1);
			volumes = volumes.filter((v) => v.id !== id);
			return { status: 204, headers: {}, body: "" };
		}
		return json(500, { message: `unexpected ${call.method} ${call.path}` });
	};
}

const volume = (overrides: Rec = {}) => ({
	id: "vol-1",
	name: "data-1",
	size_gigabytes: 10,
	region: { slug: "nyc3" },
	...overrides,
});

const volumeRequest = {
	productId: DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
	logicalId: "data-1",
	desired: { region: "nyc3", sizeGigabytes: 10 },
} as const;

const asOutcome = (outcome: ResolveOutcome | undefined): ResolveOutcome => {
	if (outcome === undefined) throw new Error("expected an outcome");
	return outcome;
};

describe("block storage volumes", () => {
	it("creates a volume that does not exist", async () => {
		const fake = fakeTransport(volumeApi());
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(request(volumeRequest), fake.transport);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.sizeGigabytes).toBe(10);
	});

	it("creates once and adopts thereafter", async () => {
		const fake = fakeTransport(volumeApi());
		const resolver = resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID);
		const first = await resolver.reconcile(
			request(volumeRequest),
			fake.transport,
		);
		const second = await resolver.reconcile(
			request(volumeRequest),
			fake.transport,
		);
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", VOLUMES)).toBe(1);
	});

	it("names the volume deterministically, so the lookup can find it again", async () => {
		const fake = fakeTransport(volumeApi());
		await resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
			request(volumeRequest),
			fake.transport,
		);
		expect(String(fake.bodyOf(1).name)).toContain("data-1");
	});

	it("refuses to invent a size, because a volume is billed by the gigabyte", async () => {
		const fake = fakeTransport(volumeApi());
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
				request({ ...volumeRequest, desired: { region: "nyc3" } }),
				fake.transport,
			),
		);
		expect(failure.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(failure.message).toContain("sizeGigabytes");
		expect(fake.countOf("POST", VOLUMES)).toBe(0);
	});

	it("says what to set when it refuses a missing size", async () => {
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
				request({ ...volumeRequest, desired: { region: "nyc3" } }),
				fakeTransport(volumeApi()).transport,
			),
		);
		expect(failure.message).toMatch(/for example/u);
	});

	it("refuses to invent a region, because placement is a residency decision", async () => {
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
				request({ ...volumeRequest, desired: { sizeGigabytes: 10 } }),
				fakeTransport(volumeApi()).transport,
			),
		);
		expect(failure.message.toLowerCase()).toContain("region");
	});

	it("passes a requested filesystem type through", async () => {
		const fake = fakeTransport(volumeApi());
		await resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
			request({
				...volumeRequest,
				desired: { ...volumeRequest.desired, filesystemType: "ext4" },
			}),
			fake.transport,
		);
		expect(fake.bodyOf(1).filesystem_type).toBe("ext4");
	});

	it("omits the filesystem type when none was asked for", async () => {
		const fake = fakeTransport(volumeApi());
		await resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).reconcile(
			request(volumeRequest),
			fake.transport,
		);
		expect(fake.bodyOf(1)).not.toHaveProperty("filesystem_type");
	});

	it("reports the volume's observed shape", async () => {
		const fake = fakeTransport(
			volumeApi([volume({ filesystem_type: "ext4" })]),
		);
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(request(volumeRequest), fake.transport);
		expect(outcome.outputs).toMatchObject({
			name: "data-1",
			sizeGigabytes: 10,
			region: "nyc3",
			filesystemType: "ext4",
		});
	});

	it("grows a volume that is smaller than the request", async () => {
		const fake = fakeTransport(volumeApi([volume({ size_gigabytes: 10 })]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				...volumeRequest,
				desired: { region: "nyc3", sizeGigabytes: 50 },
			}),
			fake.transport,
		);
		expect(outcome.action).toBe("update");
		expect(fake.bodyOf(1).type).toBe("resize");
		expect(fake.bodyOf(1).size_gigabytes).toBe(50);
	});

	it("says a resize is accepted, not applied", async () => {
		const fake = fakeTransport(volumeApi([volume()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				...volumeRequest,
				desired: { region: "nyc3", sizeGigabytes: 50 },
			}),
			fake.transport,
		);
		expect(outcome.diagnostics.join(" ")).toMatch(/accepted/u);
	});

	it("warns that the guest filesystem still needs extending", async () => {
		const fake = fakeTransport(volumeApi([volume()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				...volumeRequest,
				desired: { region: "nyc3", sizeGigabytes: 50 },
			}),
			fake.transport,
		);
		expect(outcome.diagnostics.join(" ")).toContain("filesystem");
	});

	it("reports the grown size after a resize", async () => {
		const fake = fakeTransport(volumeApi([volume()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				...volumeRequest,
				desired: { region: "nyc3", sizeGigabytes: 50 },
			}),
			fake.transport,
		);
		expect(outcome.outputs.sizeGigabytes).toBe(50);
	});

	it("reports a shrink rather than replacing the volume", async () => {
		const fake = fakeTransport(volumeApi([volume({ size_gigabytes: 100 })]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				...volumeRequest,
				desired: { region: "nyc3", sizeGigabytes: 10 },
			}),
			fake.transport,
		);
		expect(outcome.action).not.toBe("update");
		expect(outcome.diagnostics.join(" ")).toContain("only grow");
		expect(fake.calls.filter((c) => c.path.endsWith("/actions"))).toHaveLength(
			0,
		);
	});

	it("names both sizes when it reports a shrink", async () => {
		const fake = fakeTransport(volumeApi([volume({ size_gigabytes: 100 })]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({
				...volumeRequest,
				desired: { region: "nyc3", sizeGigabytes: 10 },
			}),
			fake.transport,
		);
		expect(outcome.diagnostics.join(" ")).toMatch(/100 GB.*10 GB/u);
	});

	it("does nothing when the size already matches", async () => {
		const fake = fakeTransport(volumeApi([volume({ size_gigabytes: 10 })]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(request(volumeRequest), fake.transport);
		expect(outcome.diagnostics).toEqual([]);
		expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	});

	it("adopts a volume when the request names no size at all", async () => {
		const fake = fakeTransport(volumeApi([volume()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
		).reconcile(
			request({ ...volumeRequest, desired: { region: "nyc3" } }),
			fake.transport,
		);
		expect(outcome.outputs.sizeGigabytes).toBe(10);
	});

	it("reads an existing volume without creating one", async () => {
		const fake = fakeTransport(volumeApi([volume()]));
		const outcome = asOutcome(
			await resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).read(
				request(volumeRequest),
				fake.transport,
			),
		);
		expect(outcome.outputs.name).toBe("data-1");
		expect(fake.countOf("POST", VOLUMES)).toBe(0);
	});

	it("reads nothing for a volume that does not exist", async () => {
		expect(
			await resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).read(
				request(volumeRequest),
				fakeTransport(volumeApi()).transport,
			),
		).toBeUndefined();
	});

	it("deletes the volume it created", async () => {
		const fake = fakeTransport(volumeApi([volume()]));
		await resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).delete?.(
			request(volumeRequest),
			fake.transport,
		);
		expect(fake.calls.some((c) => c.method === "DELETE")).toBe(true);
	});

	it("treats an already-absent volume as deleted", async () => {
		const fake = fakeTransport(volumeApi());
		await expect(
			resolverFor(DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID).delete?.(
				request(volumeRequest),
				fake.transport,
			),
		).resolves.toBeUndefined();
		expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
	});
});

function clusterApi(initial: Rec[] = []) {
	let clusters = [...initial];
	let nextId = 700 + initial.length;
	return (call: RecordedCall): TransportResponse => {
		if (call.method === "GET" && call.path === CLUSTERS) {
			return json(200, {
				kubernetes_clusters: clusters,
				meta: { total: clusters.length },
			});
		}
		if (call.method === "POST" && call.path === CLUSTERS) {
			const sent = JSON.parse(String(call.body)) as Rec;
			const created = {
				id: `doks-${nextId++}`,
				name: sent.name,
				region: sent.region,
				version: sent.version,
				status: { state: "provisioning" },
			};
			clusters.push(created);
			return json(201, { kubernetes_cluster: created });
		}
		if (call.method === "DELETE" && call.path.startsWith(`${CLUSTERS}/`)) {
			const id = call.path.slice(CLUSTERS.length + 1);
			clusters = clusters.filter((c) => c.id !== id);
			return { status: 204, headers: {}, body: "" };
		}
		return json(500, { message: `unexpected ${call.method} ${call.path}` });
	};
}

const cluster = (overrides: Rec = {}) => ({
	id: "doks-1",
	name: "apps-1",
	region: "nyc3",
	version: "1.31.1-do.0",
	endpoint: "https://doks-1.k8s.ondigitalocean.com",
	status: { state: "running" },
	...overrides,
});

const clusterRequest = {
	productId: DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
	logicalId: "apps-1",
	desired: { region: "nyc3", version: "1.31.1-do.0", size: "s-2vcpu-4gb" },
} as const;

describe("DOKS clusters", () => {
	it("creates a cluster that does not exist", async () => {
		const fake = fakeTransport(clusterApi());
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(request(clusterRequest), fake.transport);
		expect(outcome.action).toBe("create");
	});

	it("creates once and adopts thereafter", async () => {
		const fake = fakeTransport(clusterApi());
		const resolver = resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID);
		const first = await resolver.reconcile(
			request(clusterRequest),
			fake.transport,
		);
		const second = await resolver.reconcile(
			request(clusterRequest),
			fake.transport,
		);
		expect(second.physicalId).toBe(first.physicalId);
		expect(fake.countOf("POST", CLUSTERS)).toBe(1);
	});

	it("creates exactly one node pool, named after the cluster", async () => {
		const fake = fakeTransport(clusterApi());
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
			request(clusterRequest),
			fake.transport,
		);
		const pools = fake.bodyOf(1).node_pools as Rec[];
		expect(pools).toHaveLength(1);
		expect(String(pools[0]?.name)).toContain("apps-1");
	});

	it("defaults the node count to one rather than to a fleet", async () => {
		const fake = fakeTransport(clusterApi());
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
			request(clusterRequest),
			fake.transport,
		);
		expect((fake.bodyOf(1).node_pools as Rec[])[0]?.count).toBe(1);
	});

	it("uses a requested node count", async () => {
		const fake = fakeTransport(clusterApi());
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
			request({
				...clusterRequest,
				desired: { ...clusterRequest.desired, nodeCount: 3 },
			}),
			fake.transport,
		);
		expect((fake.bodyOf(1).node_pools as Rec[])[0]?.count).toBe(3);
	});

	it("enables autoscaling only when asked", async () => {
		const fake = fakeTransport(clusterApi());
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
			request(clusterRequest),
			fake.transport,
		);
		expect((fake.bodyOf(1).node_pools as Rec[])[0]).not.toHaveProperty(
			"auto_scale",
		);
	});

	it("passes an explicit autoscale flag through, including false", async () => {
		const fake = fakeTransport(clusterApi());
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
			request({
				...clusterRequest,
				desired: { ...clusterRequest.desired, autoScale: false },
			}),
			fake.transport,
		);
		expect((fake.bodyOf(1).node_pools as Rec[])[0]?.auto_scale).toBe(false);
	});

	it("uses a requested Kubernetes version and node size", async () => {
		const fake = fakeTransport(clusterApi());
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
			request({
				...clusterRequest,
				desired: {
					region: "nyc3",
					version: "1.30.0-do.0",
					size: "s-4vcpu-8gb",
				},
			}),
			fake.transport,
		);
		expect(fake.bodyOf(1).version).toBe("1.30.0-do.0");
		expect((fake.bodyOf(1).node_pools as Rec[])[0]?.size).toBe("s-4vcpu-8gb");
	});

	it("refuses to invent a region", async () => {
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
				request({ ...clusterRequest, desired: {} }),
				fakeTransport(clusterApi()).transport,
			),
		);
		expect(failure.message.toLowerCase()).toContain("region");
	});

	it("refuses to invent a Kubernetes version", async () => {
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
				request({ ...clusterRequest, desired: { region: "nyc3" } }),
				fakeTransport(clusterApi()).transport,
			),
		);
		expect(failure.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(failure.message).toContain("desired.version");
	});

	it("refuses to invent a node size", async () => {
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
				request({
					...clusterRequest,
					desired: { region: "nyc3", version: "1.31.1-do.0" },
				}),
				fakeTransport(clusterApi()).transport,
			),
		);
		expect(failure.message).toContain("desired.size");
	});

	it("names an example when it refuses, so the refusal is actionable", async () => {
		const failure = await failureOf(() =>
			resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).reconcile(
				request({ ...clusterRequest, desired: { region: "nyc3" } }),
				fakeTransport(clusterApi()).transport,
			),
		);
		expect(failure.message).toMatch(/for example/u);
	});

	it("says a fresh cluster is accepted, not confirmed", async () => {
		const fake = fakeTransport(clusterApi());
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(request(clusterRequest), fake.transport);
		expect(outcome.diagnostics.join(" ")).toContain("provisioning");
	});

	it("says nothing about state once the cluster is running", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(request(clusterRequest), fake.transport);
		expect(outcome.diagnostics).toEqual([]);
	});

	it("reports the apiserver endpoint, which is the handoff to the workload resolver", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(request(clusterRequest), fake.transport);
		expect(outcome.outputs.endpoint).toBe(
			"https://doks-1.k8s.ondigitalocean.com",
		);
	});

	it("reports the cluster's observed shape", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(request(clusterRequest), fake.transport);
		expect(outcome.outputs).toMatchObject({
			name: "apps-1",
			region: "nyc3",
			version: "1.31.1-do.0",
			status: "running",
		});
	});

	it("reports a version drift rather than upgrading every node", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(
			request({
				...clusterRequest,
				desired: { ...clusterRequest.desired, version: "1.32.0-do.0" },
			}),
			fake.transport,
		);
		expect(outcome.diagnostics.join(" ")).toContain("restarts every node");
		expect(fake.countOf("POST", CLUSTERS)).toBe(0);
	});

	it("names both versions when it reports the drift", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(
			request({
				...clusterRequest,
				desired: { ...clusterRequest.desired, version: "1.32.0-do.0" },
			}),
			fake.transport,
		);
		expect(outcome.diagnostics.join(" ")).toMatch(/1\.31\.1-do\.0.*1\.32/u);
	});

	it("reports a region drift rather than replacing the cluster", async () => {
		// A cluster's region is immutable; "converging" it means destroying one
		const fake = fakeTransport(clusterApi([cluster({ region: "sfo3" })]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(request(clusterRequest), fake.transport);
		expect(outcome.diagnostics.join(" ")).toContain("immutable");
	});

	it("reports both drifts at once rather than stopping at the first", async () => {
		const fake = fakeTransport(clusterApi([cluster({ region: "sfo3" })]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(
			request({
				...clusterRequest,
				desired: { ...clusterRequest.desired, version: "1.32.0-do.0" },
			}),
			fake.transport,
		);
		expect(outcome.diagnostics.length).toBeGreaterThan(1);
	});

	it("stays quiet when the request names no version or region to compare", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(
			request({ ...clusterRequest, desired: { region: "nyc3" } }),
			fake.transport,
		);
		expect(outcome.diagnostics).toEqual([]);
	});

	it("carries both the state and the drift when a provisioning cluster also drifts", async () => {
		const fake = fakeTransport(
			clusterApi([cluster({ status: { state: "provisioning" } })]),
		);
		const outcome = await resolverFor(
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
		).reconcile(
			request({
				...clusterRequest,
				desired: { ...clusterRequest.desired, version: "1.32.0-do.0" },
			}),
			fake.transport,
		);
		const joined = outcome.diagnostics.join(" ");
		expect(joined).toContain("provisioning");
		expect(joined).toContain("restarts every node");
	});

	it("reads an existing cluster without creating one", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		const outcome = asOutcome(
			await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).read(
				request(clusterRequest),
				fake.transport,
			),
		);
		expect(outcome.outputs.name).toBe("apps-1");
		expect(fake.countOf("POST", CLUSTERS)).toBe(0);
	});

	it("reads nothing for a cluster that does not exist", async () => {
		expect(
			await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).read(
				request(clusterRequest),
				fakeTransport(clusterApi()).transport,
			),
		).toBeUndefined();
	});

	it("deletes the cluster it created", async () => {
		const fake = fakeTransport(clusterApi([cluster()]));
		await resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).delete?.(
			request(clusterRequest),
			fake.transport,
		);
		expect(fake.calls.some((c) => c.method === "DELETE")).toBe(true);
	});

	it("treats an already-absent cluster as deleted", async () => {
		const fake = fakeTransport(clusterApi());
		await expect(
			resolverFor(DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID).delete?.(
				request(clusterRequest),
				fake.transport,
			),
		).resolves.toBeUndefined();
		expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
	});
});
