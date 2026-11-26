import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	createGcpProvider,
	GCP_PROVIDER_ID,
	GCP_TRAFFIC_ROUTING_OFFERING_IDS,
	GCP_TRAFFIC_ROUTING_PROFILE,
	parsePublishedManifest,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../src/json.js";

function capabilityFor(port: string) {
	const provider = createGcpProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation (full | partial | none)", () => {
	it("full: GCS objectStore satisfies durable + versioned", () => {
		const match = capabilityFor("objectStore").satisfies({
			port: "objectStore",
			features: ["durable", "versioned"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("partial: edge-worker semantics on Cloud Run return the missing features", () => {
		const match = capabilityFor("compute").satisfies({
			port: "compute",
			features: ["container", "edge", "wasm-native"],
		});
		assert.deepEqual(match, {
			kind: "partial",
			missing: ["edge", "wasm-native"],
		});
	});

	it("none: a database request is not an objectStore capability", () => {
		const match = capabilityFor("objectStore").satisfies({ port: "database" });
		assert.deepEqual(match, { kind: "none" });
	});

	it("full: Cloud SQL database satisfies postgres + managed", () => {
		const match = capabilityFor("database").satisfies({
			port: "database",
			features: ["postgres", "managed"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("full: Pub/Sub queue and Memorystore cache satisfy their class features", () => {
		assert.deepEqual(
			capabilityFor("queue").satisfies({
				port: "queue",
				features: ["queue", "at-least-once"],
			}),
			{ kind: "full" },
		);
		assert.deepEqual(
			capabilityFor("cache").satisfies({
				port: "cache",
				features: ["cache", "redis"],
			}),
			{ kind: "full" },
		);
	});
});

describe("estimateCost: declared marginal-cost facts per class", () => {
	it("returns real nonzero list-price magnitudes with free-tier facts", () => {
		const compute = capabilityFor("compute").estimateCost({ port: "compute" });
		assert.equal(compute.sku, "gcp.cloudrun.vcpu-hour");
		assert.equal(compute.marginalPrice, "0.0864");
		const kv = capabilityFor("kv").estimateCost({ port: "kv" });
		assert.equal(kv.sku, "gcp.firestore.write");
		assert.ok(Number.parseFloat(kv.marginalPrice) > 0);
		assert.equal(kv.freeTier.reset, "monthly");
	});
});

describe("capabilityManifest: published well-known bundle", () => {
	it("parses cleanly and publishes the keyless STS federation posture", () => {
		const provider = createGcpProvider();
		const manifest = provider.capabilityManifest();
		assert.equal(manifest.providerId, GCP_PROVIDER_ID);

		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.auth.mode, "svid-federation");
		assert.ok(
			String(parsed.auth.tokenAudience).includes("workloadIdentityPools"),
		);
		assert.equal(parsed.auth.exchange, "gcp:WorkloadIdentityFederation");
		assert.equal(parsed.auth.staticSecrets, false);
	});

	it("advertises all six equivalence-class capabilities with regions", () => {
		const provider = createGcpProvider({ regions: ["asia-northeast1"] });
		const manifest = provider.capabilityManifest();
		const decoded = parseJsonValue(JSON.stringify(manifest.capabilities));
		if (!isJsonObject(decoded) || !isJsonArray(decoded.capabilities)) {
			throw new Error("expected a capabilities list");
		}
		const capabilities = decoded.capabilities;
		assert.equal(capabilities.length, 6);
		assert.deepEqual(
			capabilities
				.map((entry) => {
					if (!isJsonObject(entry) || !isJsonString(entry.port)) {
						throw new Error("expected a capability port");
					}
					return entry.port;
				})
				.sort(),
			["cache", "compute", "database", "kv", "objectStore", "queue"],
		);
		for (const capability of capabilities) {
			if (!isJsonObject(capability)) {
				throw new Error("expected a capability");
			}
			assert.deepEqual(capability.regions, ["asia-northeast1"]);
		}
	});
});

describe("client: runtime binding client per port", () => {
	it("returns the resource class + service for a known port and throws for unknown", () => {
		const provider = createGcpProvider();
		const client = provider.client("kv", { tableName: "sessions" });
		assert.equal(client.resourceClass, "gcp:firestore-database");
		assert.equal(client.providerService, "Firestore");
		assert.deepEqual(client.bindings, { tableName: "sessions" });
		assert.throws(() => provider.client("mainframe", {}));
	});
});

describe("TrafficRouting offerings surface", () => {
	it("declares lb.* features with inprocess fallback floor", () => {
		assert.ok(GCP_TRAFFIC_ROUTING_OFFERING_IDS.includes("lb.lifecycle"));
		assert.ok(GCP_TRAFFIC_ROUTING_OFFERING_IDS.includes("inprocess.weighted"));
		assert.ok(
			GCP_TRAFFIC_ROUTING_PROFILE.fallbacks.includes("inprocess.weighted"),
		);
	});
});
