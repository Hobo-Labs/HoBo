import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	createDigitalOceanProvider,
	DIGITALOCEAN_PROVIDER_ID,
	DIGITALOCEAN_TRAFFIC_ROUTING_OFFERING_IDS,
	DIGITALOCEAN_TRAFFIC_ROUTING_PROFILE,
	parsePublishedManifest,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

function capabilityFor(port: string) {
	const provider = createDigitalOceanProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation (full | partial | none)", () => {
	it("full: Spaces objectStore satisfies durable + s3-compatible + cdn", () => {
		const match = capabilityFor("objectStore").satisfies({
			port: "objectStore",
			features: ["durable", "s3-compatible", "cdn"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("partial: edge-worker semantics on App Platform return the missing features", () => {
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

	it("full: Managed PostgreSQL satisfies postgres + managed", () => {
		const match = capabilityFor("database").satisfies({
			port: "database",
			features: ["postgres", "managed"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("full: Managed Valkey satisfies cache + redis", () => {
		assert.deepEqual(
			capabilityFor("cache").satisfies({
				port: "cache",
				features: ["cache", "redis"],
			}),
			{ kind: "full" },
		);
	});

	it("declares no capability for the ports DigitalOcean does not sell", () => {
		const provider = createDigitalOceanProvider();
		const ports = provider.capabilities.map((entry) => entry.port).sort();
		assert.deepEqual(ports, ["cache", "compute", "database", "objectStore"]);
		assert.equal(
			ports.includes("queue"),
			false,
			"DigitalOcean has no first-party queue; declaring one would make Matching answer full for a capability nothing can realize",
		);
	});
});

describe("estimateCost: declared marginal-cost facts per class", () => {
	it("returns real nonzero list-price magnitudes with free-tier facts", () => {
		const compute = capabilityFor("compute").estimateCost({ port: "compute" });
		assert.equal(
			compute.sku,
			"digitalocean.app-platform.basic-xxs.instance-hour",
		);
		assert.ok(Number.parseFloat(compute.marginalPrice) > 0);
		const objectStore = capabilityFor("objectStore").estimateCost({
			port: "objectStore",
		});
		assert.equal(objectStore.sku, "digitalocean.spaces.storage.gb-month");
		assert.equal(objectStore.freeTier.included, 250);
		assert.equal(objectStore.freeTier.reset, "monthly");
	});
});

describe("capabilityManifest: published well-known bundle", () => {
	it("parses cleanly and publishes a posture with no static secrets", () => {
		const provider = createDigitalOceanProvider();
		const manifest = provider.capabilityManifest();
		assert.equal(manifest.providerId, DIGITALOCEAN_PROVIDER_ID);

		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.auth.mode, "svid-federation");
		assert.equal(parsed.auth.exchange, "hobo:broker-credential-locator");
		assert.equal(parsed.auth.staticSecrets, false);
	});

	it("advertises all four equivalence-class capabilities with regions", () => {
		const provider = createDigitalOceanProvider({ regions: ["ams3"] });
		const manifest = provider.capabilityManifest();
		const capabilities =
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			(manifest.capabilities as { capabilities: Array<JsonObject> })
				.capabilities;
		assert.equal(capabilities.length, 4);
		assert.deepEqual(capabilities.map((c) => c.port).sort(), [
			"cache",
			"compute",
			"database",
			"objectStore",
		]);
		for (const capability of capabilities) {
			assert.deepEqual(capability.regions, ["ams3"]);
		}
	});
});

describe("client: runtime binding client per port", () => {
	it("returns the resource class + service for a known port and throws for unknown", () => {
		const provider = createDigitalOceanProvider();
		const client = provider.client("database", { host: "db.example" });
		assert.equal(client.resourceClass, "digitalocean:managed-postgres");
		assert.equal(client.providerService, "Managed Databases for PostgreSQL");
		assert.deepEqual(client.bindings, { host: "db.example" });
		assert.throws(() => provider.client("mainframe", {}));
	});
});

describe("TrafficRouting offerings surface", () => {
	it("declares lb.* features with inprocess fallback floor", () => {
		assert.ok(
			DIGITALOCEAN_TRAFFIC_ROUTING_OFFERING_IDS.includes("lb.lifecycle"),
		);
		assert.ok(
			DIGITALOCEAN_TRAFFIC_ROUTING_OFFERING_IDS.includes("inprocess.weighted"),
		);
		assert.ok(
			DIGITALOCEAN_TRAFFIC_ROUTING_PROFILE.fallbacks.includes(
				"inprocess.weighted",
			),
		);
	});
});
