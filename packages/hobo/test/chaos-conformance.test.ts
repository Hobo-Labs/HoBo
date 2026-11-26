/**
 * Every provider's resolvers face the same chaos suite.
 *
 * `chaos-resolver.test.ts` already drives Cloudflare R2 through injected faults
 * and pins the one property that matters. This widens that from one product to
 * one product per provider, because the resolvers were written against several
 * different API shapes — ARM with long-running operations, Google REST with
 * Operations polling, SigV4 over four request protocols, Cloudflare v4,
 * DigitalOcean's paged collections, Hetzner's exact name filter, and a
 * Kubernetes apiserver — and "R2 converges" is evidence about R2.
 *
 * The listed-collection shapes are the interesting additions. Where ARM and
 * Google let a create's own response address the resource afterwards, a
 * DigitalOcean or Hetzner resolver must find its record again *by the name it
 * chose*, in a list that also holds everybody else's — precisely the step a
 * fault can hide, and precisely where "adopt the first record" would duplicate
 * or, worse, adopt a stranger's resource.
 *
 * The property under test is convergence after an *ambiguous* failure: the
 * socket died, or the deadline passed, or the body came back truncated, and the
 * caller cannot tell whether the provider applied the write. Retrying must
 * produce one resource, not two. A resolver that lets the provider mint an id
 * cannot satisfy this at all, which is why several products across these
 * catalogs ship no resolver rather than a convergent-looking one.
 *
 * This lives in `@hobo/hobo` rather than in each provider package for the same
 * reason the R2 chaos test does: provider packages are layer 2 and cannot
 * import `@hobo/testing`, so the composition root is where a cross-provider
 * suite can exist at all.
 */

import type { HttpTransport, TransportRequest } from "@hobo/core";
import { parseResolveRequest } from "@hobo/core";
import {
	azureResolverRegistry,
	guardedAzureTransport,
} from "@hobo/provider-azure";
import {
	digitaloceanResolverRegistry,
	guardedDigitalOceanTransport,
} from "@hobo/provider-digitalocean";
import { gcpResolverRegistry, guardedGcpTransport } from "@hobo/provider-gcp";
import {
	guardedHetznerTransport,
	hetznerResolverRegistry,
} from "@hobo/provider-hetzner";
import {
	guardedKubernetesTransport,
	kubernetesResolverRegistry,
} from "@hobo/provider-kubernetes";
import {
	type ChaosSubject,
	chaosViolations,
	runChaosConformance,
} from "@hobo/testing";
import { describe, expect, it } from "vitest";
import { isJsonString, type JsonObject, type JsonValue } from "../src/json.js";

/**
 * A fake provider world shared by both subjects.
 *
 * Writes land under the path they address, so a create followed by a read of
 * the same path finds the resource — which is the whole question a convergence
 * test asks. A `POST` to a collection addresses the new item by the `name` in
 * its body (Google's shape); a `PUT` addresses it directly (ARM's shape).
 */
function fakeWorld() {
	const resources = new Map<string, unknown>();
	const creates: TransportRequest[] = [];

	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		const key = `${url.host}${url.pathname}`;
		const writing = request.method === "PUT" || request.method === "POST";

		if (writing) {
			creates.push(request);
			const body = request.body ? JSON.parse(request.body) : {};
			const itemKey =
				request.method === "POST" && isJsonString(body.name)
					? `${key}/${body.name}`
					: key;
			const stored = {
				name: body.name ?? itemKey.split("/").pop(),
				...body,
				properties: {
					...body.properties,
					provisioningState: "Succeeded",
				},
			};
			resources.set(itemKey, stored);
			return json(200, stored);
		}

		if (request.method === "DELETE") {
			resources.delete(key);
			return json(200, {});
		}

		const found = resources.get(key);
		return found === undefined
			? json(404, { error: { message: "not found" } })
			: json(200, found);
	};

	return {
		transport,
		countResources: () => resources.size,
		// Only the write that creates counts. A read-back is not a create, and a
		// resolver is expected to issue several of those.
		countCreates: () => creates.length,
	};
}

function json(status: number, body: JsonValue) {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

const AZURE_SUBSCRIPTION = "00000000-0000-4000-8000-000000000001";

const azureKeyVault: ChaosSubject = {
	label: "azure.key-vault/v1",
	create(wrap) {
		const world = fakeWorld();
		const registry = azureResolverRegistry({
			subscriptionId: AZURE_SUBSCRIPTION,
			resourceGroup: "rg-1",
			resolveCredential: async () => "bearer-token",
		});
		const resolver = registry.get("azure.key-vault/v1");
		if (!resolver) throw new Error("azure.key-vault/v1 resolver missing");
		const transport = guardedAzureTransport(wrap(world.transport));
		const request = parseResolveRequest({
			ref: {
				slot: "secretRef",
				productId: "azure.key-vault/v1",
				logicalId: "vault",
			},
			desired: { location: "westeurope", tenantId: "t-1", sku: "standard" },
			credentialRef: "env://AZURE_TOKEN",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

const gcpBucket: ChaosSubject = {
	label: "gcp.cloud-storage/v1",
	create(wrap) {
		const world = fakeWorld();
		const registry = gcpResolverRegistry({
			projectId: "proj-1",
			resolveCredential: async () => "oauth-token",
		});
		const resolver = registry.get("gcp.cloud-storage/v1");
		if (!resolver) throw new Error("gcp.cloud-storage/v1 resolver missing");
		const transport = guardedGcpTransport(
			wrap(world.transport),
			"cloudStorage",
		);
		const request = parseResolveRequest({
			ref: {
				slot: "bucket",
				productId: "gcp.cloud-storage/v1",
				logicalId: "assets",
			},
			desired: { location: "US" },
			credentialRef: "env://GCP_TOKEN",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

/**
 * A world that answers a write with a long-running Operation instead of the
 * resource, which is what `redis.googleapis.com` (and Cloud SQL, and Cloud Run)
 * actually does.
 *
 * This shape deserves its own chaos subject rather than riding on
 * {@link fakeWorld}: an LRO resolver's create returns a *handle*, not the thing,
 * so the "did my write land?" question the fault raises is answered one
 * indirection further away. A resolver that reported the accepted operation as
 * the resource would look fine against the direct-write world and duplicate
 * here.
 */
function gcpOperationWorld() {
	const resources = new Map<string, unknown>();
	const creates: TransportRequest[] = [];
	const operationName = "projects/proj-1/locations/us-central1/operations/op-1";

	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);

		if (url.pathname === `/v1/${operationName}`) {
			return json(200, { name: operationName, done: true });
		}

		if (request.method === "POST") {
			creates.push(request);
			// The id is the caller's `instanceId` query parameter, never one the
			// provider mints — that pairing is what makes the retry converge.
			const instanceId = url.searchParams.get("instanceId") ?? "unnamed";
			const body = request.body ? JSON.parse(request.body) : {};
			resources.set(`${url.pathname}/${instanceId}`, {
				name: `projects/proj-1/locations/us-central1/instances/${instanceId}`,
				host: "10.0.0.7",
				port: 6379,
				state: "READY",
				...body,
			});
			return json(200, { name: operationName, done: true });
		}

		if (request.method === "DELETE") {
			resources.delete(url.pathname);
			return json(200, { name: operationName, done: true });
		}

		const found = resources.get(url.pathname);
		return found === undefined
			? json(404, { error: { message: "not found" } })
			: json(200, found);
	};

	return {
		transport,
		countResources: () => resources.size,
		countCreates: () => creates.length,
	};
}

const azureRedisCache: ChaosSubject = {
	label: "azure.cache-for-redis/v1",
	create(wrap) {
		const world = fakeWorld();
		const registry = azureResolverRegistry({
			subscriptionId: AZURE_SUBSCRIPTION,
			resourceGroup: "rg-1",
			resolveCredential: async () => "bearer-token",
		});
		const resolver = registry.get("azure.cache-for-redis/v1");
		if (!resolver) throw new Error("azure.cache-for-redis/v1 resolver missing");
		const transport = guardedAzureTransport(wrap(world.transport));
		const request = parseResolveRequest({
			ref: {
				slot: "kv",
				productId: "azure.cache-for-redis/v1",
				logicalId: "cache",
			},
			desired: { capacity: 1, location: "westeurope", skuName: "Standard" },
			credentialRef: "env://AZURE_TOKEN",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

const gcpMemorystore: ChaosSubject = {
	label: "gcp.memorystore-redis/v1",
	create(wrap) {
		const world = gcpOperationWorld();
		const registry = gcpResolverRegistry({
			projectId: "proj-1",
			resolveCredential: async () => "oauth-token",
		});
		const resolver = registry.get("gcp.memorystore-redis/v1");
		if (!resolver) {
			throw new Error("gcp.memorystore-redis/v1 resolver missing");
		}
		const transport = guardedGcpTransport(wrap(world.transport), "memorystore");
		const request = parseResolveRequest({
			ref: {
				slot: "kv",
				productId: "gcp.memorystore-redis/v1",
				logicalId: "session-cache",
			},
			desired: { location: "us-central1", memoryGb: 1, tier: "basic" },
			credentialRef: "env://GCP_TOKEN",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

/**
 * A world whose collections are *listed*, not GET-by-name — the shape
 * DigitalOcean and Hetzner both have, and the one that makes convergence
 * genuinely harder than the ARM/Google case above.
 *
 * The difference is worth its own world rather than a flag on
 * {@link fakeWorld}: there, a create's own response is enough to address the
 * resource afterwards. Here the resolver must find its record again by the
 * *name it chose*, in a list that also contains everybody else's, which is
 * precisely the step a fault can hide. A resolver that adopted "the first
 * record in the list" would pass the direct-write world and duplicate — or
 * worse, adopt a stranger's resource — under this one.
 *
 * `nameFiltered` models Hetzner's exact `?name=` filter; without it the whole
 * collection comes back, as DigitalOcean's does.
 */
function listedWorld(options: {
	readonly collectionPath: string;
	readonly listKey: string;
	readonly itemKey: string;
	readonly nameFiltered: boolean;
	readonly stored: (body: JsonObject, id: number) => JsonValue;
}) {
	const records: JsonObject[] = [];
	const creates: TransportRequest[] = [];
	let nextId = 1;

	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === options.collectionPath) {
			const wanted = url.searchParams.get("name");
			const listed =
				options.nameFiltered && wanted !== null
					? records.filter((entry) => entry.name === wanted)
					: records;
			return json(200, { [options.listKey]: listed, meta: {} });
		}
		if (request.method === "POST" && url.pathname === options.collectionPath) {
			creates.push(request);
			// SAFETY: assertion required at this I/O or test boundary.
			const body = (request.body ? JSON.parse(request.body) : {}) as JsonObject;
			// SAFETY: assertion required at this I/O or test boundary.
			const record = options.stored(body, nextId++) as JsonObject;
			records.push(record);
			return json(201, { [options.itemKey]: record });
		}
		if (request.method === "DELETE") {
			records.length = 0;
			return json(200, {});
		}
		return json(404, { message: "not found" });
	};

	return {
		transport,
		countResources: () => records.length,
		countCreates: () => creates.length,
	};
}

const digitaloceanDatabase: ChaosSubject = {
	label: "digitalocean.managed-postgres/v1",
	create(wrap) {
		const world = listedWorld({
			collectionPath: "/v2/databases",
			listKey: "databases",
			itemKey: "database",
			nameFiltered: false,
			stored: (body, id) => ({
				id: `db-${id}`,
				name: body.name,
				engine: body.engine,
				region: body.region,
				size: body.size,
				num_nodes: body.num_nodes,
				status: "creating",
				connection: { host: `${String(body.name)}.db.example`, port: 25060 },
			}),
		});
		const registry = digitaloceanResolverRegistry({
			resolveCredential: async () => "pat-token",
		});
		const resolver = registry.get("digitalocean.managed-postgres/v1");
		if (!resolver) {
			throw new Error("digitalocean.managed-postgres/v1 resolver missing");
		}
		const transport = guardedDigitalOceanTransport(wrap(world.transport));
		const request = parseResolveRequest({
			ref: {
				slot: "data",
				productId: "digitalocean.managed-postgres/v1",
				logicalId: "ledger",
			},
			desired: { region: "nyc3", size: "db-s-1vcpu-1gb" },
			credentialRef: "env://DIGITALOCEAN_TOKEN",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

const hetznerServer: ChaosSubject = {
	label: "hetzner.cloud-server/v1",
	create(wrap) {
		const world = listedWorld({
			collectionPath: "/v1/servers",
			listKey: "servers",
			itemKey: "server",
			nameFiltered: true,
			stored: (body, id) => ({
				id: 100 + id,
				name: body.name,
				status: "initializing",
				server_type: { name: body.server_type },
				datacenter: { location: { name: body.location } },
				public_net: { ipv4: { ip: "203.0.113.42" } },
			}),
		});
		const registry = hetznerResolverRegistry({
			resolveCredential: async () => "project-token",
		});
		const resolver = registry.get("hetzner.cloud-server/v1");
		if (!resolver) throw new Error("hetzner.cloud-server/v1 resolver missing");
		const transport = guardedHetznerTransport(wrap(world.transport));
		const request = parseResolveRequest({
			ref: {
				slot: "web",
				productId: "hetzner.cloud-server/v1",
				logicalId: "api-1",
			},
			desired: {
				location: "fsn1",
				serverType: "cx22",
				image: "ubuntu-24.04",
			},
			credentialRef: "env://HCLOUD_TOKEN",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

/**
 * A fake apiserver. Its create addresses the new object by `metadata.name`
 * rather than a top-level `name`, which is why it cannot ride on
 * {@link fakeWorld}: a world that keyed on `body.name` would store every
 * Deployment under the collection path and then answer the read-back with a
 * 404, making the resolver look non-convergent for the world's reason rather
 * than its own.
 */
function apiserverWorld(collectionPath: string) {
	const objects = new Map<string, unknown>();
	const creates: TransportRequest[] = [];

	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === collectionPath) {
			creates.push(request);
			// SAFETY: assertion required at this I/O or test boundary.
			const body = (request.body ? JSON.parse(request.body) : {}) as {
				metadata?: { name?: string };
			};
			const name = body.metadata?.name ?? "unnamed";
			const stored = {
				...body,
				metadata: {
					...body.metadata,
					uid: "11111111-2222-3333-4444-555555555555",
				},
			};
			objects.set(`${collectionPath}/${name}`, stored);
			return json(201, stored);
		}
		if (request.method === "DELETE") {
			objects.delete(url.pathname);
			return json(200, { kind: "Status", status: "Success" });
		}
		const found = objects.get(url.pathname);
		return found === undefined
			? json(404, { kind: "Status", reason: "NotFound", message: "not found" })
			: json(200, found);
	};

	return {
		transport,
		countResources: () => objects.size,
		countCreates: () => creates.length,
	};
}

const kubernetesDeployment: ChaosSubject = {
	label: "kubernetes.deployment/v1",
	create(wrap) {
		const world = apiserverWorld("/apis/apps/v1/namespaces/shop/deployments");
		const registry = kubernetesResolverRegistry({
			apiServerUrl: "https://cluster.example:6443",
			resolveCredential: async () => "projected-service-account-token",
		});
		const resolver = registry.get("kubernetes.deployment/v1");
		if (!resolver) throw new Error("kubernetes.deployment/v1 resolver missing");
		const transport = guardedKubernetesTransport(
			wrap(world.transport),
			"https://cluster.example:6443",
		);
		const request = parseResolveRequest({
			ref: {
				slot: "web",
				productId: "kubernetes.deployment/v1",
				logicalId: "api",
			},
			desired: { namespace: "shop", spec: { replicas: 2 } },
			credentialRef: "secret://camp/cluster-token",
		});
		return {
			reconcile: () => resolver.reconcile(request, transport),
			countResources: world.countResources,
			countCreates: world.countCreates,
		};
	},
};

describe("resolvers converge after an ambiguous failure", () => {
	for (const subject of [
		azureKeyVault,
		azureRedisCache,
		gcpBucket,
		gcpMemorystore,
		digitaloceanDatabase,
		hetznerServer,
		kubernetesDeployment,
	]) {
		it(`${subject.label} survives every ambiguous fault on the write`, async () => {
			// Index 1: these resolvers read before they write, so call 0 is the
			// existence probe and call 1 is the create. Faulting the read would
			// test something else — a failed read is unambiguous, nothing was
			// applied, and there is nothing to converge out of.
			const results = await runChaosConformance(subject, { writeCallIndex: 1 });
			expect(chaosViolations(results)).toEqual([]);
		});

		it(`${subject.label} actually exercised every fault`, async () => {
			// Without this, a subject whose first reconcile never reaches the write
			// would report zero violations and look green while testing nothing.
			const results = await runChaosConformance(subject, { writeCallIndex: 1 });
			expect(results).toHaveLength(5);
			expect(
				results.every((result) => result.resourcesAfterRetry === 1),
				"every scenario must end with exactly one resource",
			).toBe(true);
		});
	}
});

describe("the conformance suite itself discriminates", () => {
	/**
	 * A green suite is only meaningful if a red one is reachable. This subject is
	 * the failure mode the suite exists to catch: it never reads before writing,
	 * and it lets the "provider" mint a fresh id each time — exactly what a
	 * resolver posting to a collection endpoint does. Under a fault that
	 * corrupts the response *after* the write landed, its retry writes a second
	 * resource.
	 */
	const duplicating: ChaosSubject = {
		label: "fake.non-convergent/v1",
		create(wrap) {
			const resources = new Map<string, unknown>();
			let minted = 0;
			const inner: HttpTransport = async (request) => {
				if (request.method === "POST") {
					minted += 1;
					const id = `generated-${minted}`;
					resources.set(id, { id });
					return json(200, { id });
				}
				return json(404, { error: { message: "no list-by-name" } });
			};
			const transport = wrap(inner);
			return {
				// Writes unconditionally: no read, no adoption, new id every time.
				reconcile: async () => {
					const response = await transport({
						method: "POST",
						url: "https://fake.example.com/v1/things",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({}),
					});
					// SAFETY: assertion required at this I/O or test boundary.
					const parsed = JSON.parse(response.body) as { id: string };
					return { physicalId: parsed.id, action: "create" };
				},
				countResources: () => resources.size,
				countCreates: () => minted,
			};
		},
	};

	it("fails a resolver that duplicates on retry", async () => {
		const results = await runChaosConformance(duplicating, {
			writeCallIndex: 0,
		});
		const violations = chaosViolations(results);

		// The two response-corrupting faults let the write land and then hide it,
		// so the retry duplicates. That is the whole point of the suite.
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.join("\n")).toContain("must read first and adopt");
		expect(
			results.filter((result) => result.resourcesAfterRetry > 1).length,
			"at least one fault must expose the duplicate",
		).toBeGreaterThan(0);
	});
});
