import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	CLOUDFLARE_TRAFFIC_ROUTING_OFFERING_IDS,
	CLOUDFLARE_TRAFFIC_ROUTING_PROFILE,
	createCloudflareProvider,
} from "../src/index.js";

function capabilityFor(port: string) {
	const provider = createCloudflareProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation (full | partial | none)", () => {
	it("full: R2 objectStore satisfies durable + s3-compatible", () => {
		const match = capabilityFor("objectStore").satisfies({
			port: "objectStore",
			features: ["durable", "s3-compatible"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("partial: strict S3 semantics on R2 return the missing features", () => {
		const match = capabilityFor("objectStore").satisfies({
			port: "objectStore",
			features: ["durable", "s3-etag-md5", "s3-read-after-overwrite"],
		});
		assert.deepEqual(match, {
			kind: "partial",
			missing: ["s3-etag-md5", "s3-read-after-overwrite"],
		});
	});

	it("none: a database request is not an objectStore capability", () => {
		const match = capabilityFor("objectStore").satisfies({ port: "database" });
		assert.deepEqual(match, { kind: "none" });
	});

	it("full: Workers compute satisfies edge + worker + http", () => {
		const match = capabilityFor("compute").satisfies({
			port: "compute",
			features: ["edge", "worker", "http"],
		});
		assert.deepEqual(match, { kind: "full" });
	});
});

describe("Capability.estimateCost", () => {
	it("returns a per-port marginal-cost signal with free tier", () => {
		const cost = capabilityFor("kv").estimateCost({ port: "kv" });
		assert.equal(cost.currency, "USD");
		assert.equal(cost.sku, "cloudflare.kv.read");
		assert.equal(cost.unit, "operation");
		assert.equal(cost.freeTier.included, 0);
		assert.equal(cost.pricingStatus, "unknown");
	});

	it("prices compute and objectStore with distinct SKUs", () => {
		assert.equal(
			capabilityFor("compute").estimateCost({ port: "compute" }).sku,
			"cloudflare.workers.request",
		);
		assert.equal(
			capabilityFor("objectStore").estimateCost({ port: "objectStore" }).sku,
			"cloudflare.r2.storage.gb-month",
		);
	});
});

describe("CloudProvider.client", () => {
	it("returns a binding client keyed by resource class for each port", () => {
		const provider = createCloudflareProvider();
		const client = provider.client("compute", {
			url: "https://svc.workers.dev",
		});
		assert.equal(client.resourceClass, "cloudflare:workers-script");
		assert.equal(client.providerService, "Workers");
		assert.deepEqual(client.bindings, { url: "https://svc.workers.dev" });
	});

	it("rejects an unknown port", () => {
		const provider = createCloudflareProvider();
		assert.throws(
			() => provider.client("database", {}),
			/no client for port database/,
		);
	});
});

describe("TrafficRouting offerings surface", () => {
	it("declares lb.lifecycle and observe.health offerings", () => {
		assert.ok(CLOUDFLARE_TRAFFIC_ROUTING_OFFERING_IDS.includes("lb.lifecycle"));
		assert.ok(
			CLOUDFLARE_TRAFFIC_ROUTING_OFFERING_IDS.includes("observe.health"),
		);
		assert.equal(CLOUDFLARE_TRAFFIC_ROUTING_PROFILE.provider, "cloudflare");
	});
});
