import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	approveProviderFact,
	createEventBackedRegistry,
	createRegistryFromProviders,
	definitionsFor,
	matchResource,
	type RegistrableProvider,
	type ResourceIntent,
	registerProviderFact,
	registryCatalogProjection,
} from "../src/index.js";

let stores: RuntimeLocalEventStore[] = [];
function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cloud-reg-"));
	const s = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

const actor = { kind: "user", id: "operator-1" } as const;

describe("Registry: catalog from a provider capabilityManifest()", () => {
	it("indexes each advertised capability as a default Resource Definition", () => {
		const provider = createCloudflareProvider();
		const defs = definitionsFor(provider);
		expect(defs.map((d) => d.port).sort()).toEqual([
			"compute",
			"kv",
			"objectStore",
		]);
		const compute = defs.find((d) => d.port === "compute");
		expect(compute?.providerId).toBe("@hobo/provider-cloudflare");
		expect(compute?.features).toContain("http");
		// Live negotiation is delegated to the provider Capability.satisfies.
		expect(
			compute?.satisfies({ port: "compute", features: ["http"] }).kind,
		).toBe("full");
		expect(
			compute?.satisfies({ port: "compute", features: ["gpu"] }).kind,
		).toBe("partial");
	});

	it("produces a stable catalog hash for a fixed provider set", () => {
		const a = createRegistryFromProviders([createCloudflareProvider()]);
		const b = createRegistryFromProviders([createCloudflareProvider()]);
		expect(a.catalogHash).toBe(b.catalogHash);
		expect(a.definitions()).toHaveLength(3);
	});
});

// A minimal Capability-Manifest-bearing provider fixture (the shape `hobo add`
// installs): one port, deterministic cost, real manifest documents.
function fixtureProvider(id: string, ports: string[]): RegistrableProvider {
	return {
		id,
		regions: ["local"],
		capabilities: ports.map((port) => ({
			port,
			satisfies: (req) =>
				req.port === port
					? { kind: "full" }
					: { kind: "none", missing: [req.port] },
			estimateCost: () => ({
				marginalPrice: "0",
				sku: `${id}-${port}`,
				unit: "hour",
			}),
		})),
		capabilityManifest: () => ({
			providerId: id,
			published: {
				"/.well-known/capability-manifest/index.json": JSON.stringify({
					providerId: id,
					ports,
				}),
			},
			capabilities: {
				capabilities: ports.map((port) => ({
					port,
					features: [],
					regions: ["local"],
				})),
			},
			cost: {
				facts: ports.map((port) => ({
					port,
					sku: `${id}-${port}`,
					unit: "hour",
					marginalPrice: "0",
				})),
			},
		}),
	};
}

function intentFor(port: string): ResourceIntent {
	return {
		name: "ledger",
		port,
		require: [],
		prefer: [],
		negotiation: "require",
		deps: [],
		objective: "min-cost",
	};
}

describe("Registry: event-backed registry (HOBO-710)", () => {
	const streamId = "registry:default";

	it("folds installed+approved providers from the stream into the matchable snapshot", async () => {
		const store = freshStore();
		const base = createRegistryFromProviders([createCloudflareProvider()]);
		const registry = createEventBackedRegistry({ store, streamId, base });

		const baseHash = registry.catalogHash;
		expect(registry.providers()).toEqual(["@hobo/provider-cloudflare"]);

		const pg = fixtureProvider("pg-local", ["hobo:database"]);
		await store.append(
			streamId,
			[registerProviderFact(pg), approveProviderFact("pg-local")],
			{ expectedSeq: 0, actor, tenant: "yard" },
		);

		// The sync snapshot only changes on refresh (the read model re-fold).
		expect(registry.providers()).toEqual(["@hobo/provider-cloudflare"]);
		await registry.refresh();

		expect(registry.providers().sort()).toEqual([
			"@hobo/provider-cloudflare",
			"pg-local",
		]);
		const def = registry.definitions().find((d) => d.providerId === "pg-local");
		expect(def?.port).toBe("hobo:database");
		expect(def?.satisfies({ port: "hobo:database", features: [] }).kind).toBe(
			"full",
		);
		// Catalog hash changes when an installed provider lands.
		expect(registry.catalogHash).not.toBe(baseHash);

		// Rebuildable from zero: a fresh registry over the same store folds the
		// same snapshot.
		const rebuilt = createEventBackedRegistry({ store, streamId, base });
		await rebuilt.refresh();
		expect(rebuilt.catalogHash).toBe(registry.catalogHash);

		// Matching resolves the installed provider.
		const outcome = matchResource(intentFor("hobo:database"), registry);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.decision.providerId).toBe("pg-local");
	});

	it("excludes registered-but-unapproved providers and names them in the remediation", async () => {
		const store = freshStore();
		const base = createRegistryFromProviders([createCloudflareProvider()]);
		const registry = createEventBackedRegistry({ store, streamId, base });

		const pg = fixtureProvider("pg-local", ["hobo:database"]);
		await store.append(streamId, [registerProviderFact(pg)], {
			expectedSeq: 0,
			actor,
			tenant: "yard",
		});
		await registry.refresh();

		// Held: visible via held(), invisible to definitions()/providers().
		expect(registry.providers()).toEqual(["@hobo/provider-cloudflare"]);
		expect(registry.held()).toEqual([
			{ providerId: "pg-local", ports: ["hobo:database"] },
		]);

		const outcome = matchResource(intentFor("hobo:database"), registry);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.remediation.code).toBe("capability.provider-not-approved");
			expect(outcome.remediation.suggestedProvider).toBe("pg-local");
		}

		// Approving flips it to matchable.
		await store.append(streamId, [approveProviderFact("pg-local")], {
			expectedSeq: 1,
			actor,
			tenant: "yard",
		});
		await registry.refresh();
		expect(registry.held()).toEqual([]);
		expect(matchResource(intentFor("hobo:database"), registry).ok).toBe(true);
	});

	it("dedupes an installed provider whose id collides with a base provider", async () => {
		const store = freshStore();
		const base = createRegistryFromProviders([createCloudflareProvider()]);
		const registry = createEventBackedRegistry({ store, streamId, base });

		const impostor = fixtureProvider("@hobo/provider-cloudflare", ["kv"]);
		await store.append(
			streamId,
			[
				registerProviderFact(impostor),
				approveProviderFact("@hobo/provider-cloudflare"),
			],
			{ expectedSeq: 0, actor, tenant: "yard" },
		);
		await registry.refresh();

		// The live base definition wins; the recorded one is not double-counted.
		expect(registry.providers()).toEqual(["@hobo/provider-cloudflare"]);
		expect(registry.definitions()).toHaveLength(3);
	});
});

describe("Registry: catalog projection over provider.Registered", () => {
	it("materializes a provider's Capability Manifest snapshot, rebuildable from zero", async () => {
		const store = freshStore();
		const provider = createCloudflareProvider();
		const streamId = "registry:catalog";

		await store.append(streamId, [registerProviderFact(provider)], {
			expectedSeq: 0,
			actor,
			tenant: "yard",
		});

		const view = await registryCatalogProjection.rebuildFromZero(
			store,
			streamId,
		);
		const row = registryCatalogProjection.get(
			view,
			"@hobo/provider-cloudflare",
		);
		expect(row?.ports).toEqual(["compute", "kv", "objectStore"]);
		expect(row?.definitionCount).toBe(3);
		expect(row?.manifestIndexDigest).toMatch(/^sha256:/);
	});

	it("declares its read-set as a projection.Declared fact", () => {
		const declared = registryCatalogProjection.declared();
		expect(declared.type).toBe("projection.Declared");
		expect(declared.data).toMatchObject({
			projection: "registry-catalog",
			readSet: ["provider.Registered"],
		});
	});
});
