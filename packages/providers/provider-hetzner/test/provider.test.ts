import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	createHetznerProvider,
	HETZNER_PROVIDER_ID,
	HETZNER_TRAFFIC_ROUTING_OFFERING_IDS,
	HETZNER_TRAFFIC_ROUTING_PROFILE,
	parsePublishedManifest,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../src/json.js";

function capabilityFor(port: string) {
	const provider = createHetznerProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation (full | partial | none)", () => {
	it("full: Object Storage satisfies durable + s3-compatible", () => {
		const match = capabilityFor("objectStore").satisfies({
			port: "objectStore",
			features: ["durable", "s3-compatible"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("partial: serverless semantics on a Cloud Server return the missing features", () => {
		const match = capabilityFor("compute").satisfies({
			port: "compute",
			features: ["vm", "autoscaling", "edge"],
		});
		assert.deepEqual(match, {
			kind: "partial",
			missing: ["autoscaling", "edge"],
		});
	});

	it("none: a database request is not a compute capability", () => {
		const match = capabilityFor("compute").satisfies({ port: "database" });
		assert.deepEqual(match, { kind: "none" });
	});

	/**
	 * The load-bearing honesty test for this provider. Hetzner sells no managed
	 * database, cache or queue; declaring one would make Matching answer `full`
	 * for a capability nothing can realize, and place an app that needs Postgres
	 * on a virtual machine it would have to administer itself.
	 */
	it("declares only the two ports Hetzner actually sells", () => {
		const provider = createHetznerProvider();
		const ports = provider.capabilities.map((entry) => entry.port).sort();
		assert.deepEqual(ports, ["compute", "objectStore"]);
		for (const absent of ["database", "cache", "queue", "kv"]) {
			assert.equal(
				ports.includes(absent),
				false,
				`Hetzner has no managed ${absent}; a row for one would be a portability lie`,
			);
		}
	});
});

describe("estimateCost: declared marginal-cost facts per class", () => {
	it("returns real nonzero list-price magnitudes with free-tier facts", () => {
		const compute = capabilityFor("compute").estimateCost({ port: "compute" });
		assert.equal(compute.sku, "hetzner.cloud-server.cx22.instance-hour");
		assert.ok(Number.parseFloat(compute.marginalPrice) > 0);
		const objectStore = capabilityFor("objectStore").estimateCost({
			port: "objectStore",
		});
		assert.equal(objectStore.sku, "hetzner.object-storage.storage.gb-month");
		assert.equal(objectStore.freeTier.included, 1000);
		assert.equal(objectStore.freeTier.reset, "monthly");
	});
});

describe("capabilityManifest: published well-known bundle", () => {
	it("parses cleanly and publishes a posture with no static secrets", () => {
		const provider = createHetznerProvider();
		const manifest = provider.capabilityManifest();
		assert.equal(manifest.providerId, HETZNER_PROVIDER_ID);

		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.auth.mode, "svid-federation");
		assert.equal(parsed.auth.exchange, "hobo:broker-credential-locator");
		assert.equal(parsed.auth.staticSecrets, false);
	});

	it("advertises both equivalence-class capabilities with locations", () => {
		const provider = createHetznerProvider({ regions: ["hel1"] });
		const manifest = provider.capabilityManifest();
		const decoded = parseJsonValue(JSON.stringify(manifest.capabilities));
		if (!isJsonObject(decoded) || !isJsonArray(decoded.capabilities)) {
			throw new Error("expected a capabilities list");
		}
		const capabilities = decoded.capabilities;
		assert.equal(capabilities.length, 2);
		assert.deepEqual(
			capabilities
				.map((entry) => {
					if (!isJsonObject(entry) || !isJsonString(entry.port)) {
						throw new Error("expected a capability port");
					}
					return entry.port;
				})
				.sort(),
			["compute", "objectStore"],
		);
		for (const capability of capabilities) {
			if (!isJsonObject(capability)) {
				throw new Error("expected a capability");
			}
			assert.deepEqual(capability.regions, ["hel1"]);
		}
	});
});

describe("client: runtime binding client per port", () => {
	it("returns the resource class + service for a known port and throws for unknown", () => {
		const provider = createHetznerProvider();
		const client = provider.client("compute", { ipv4: "203.0.113.5" });
		assert.equal(client.resourceClass, "hetzner:cloud-server");
		assert.equal(client.providerService, "Hetzner Cloud Server");
		assert.deepEqual(client.bindings, { ipv4: "203.0.113.5" });
		assert.throws(() => provider.client("database", {}));
	});
});

describe("TrafficRouting offerings surface", () => {
	it("declares lb.* features with inprocess fallback floor", () => {
		assert.ok(HETZNER_TRAFFIC_ROUTING_OFFERING_IDS.includes("lb.lifecycle"));
		assert.ok(
			HETZNER_TRAFFIC_ROUTING_OFFERING_IDS.includes("inprocess.weighted"),
		);
		assert.ok(
			HETZNER_TRAFFIC_ROUTING_PROFILE.fallbacks.includes("inprocess.weighted"),
		);
	});
});
