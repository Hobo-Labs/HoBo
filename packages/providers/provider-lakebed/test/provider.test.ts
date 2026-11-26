import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	createLakebedProvider,
	LAKEBED_PROVIDER_ID,
	LAKEBED_TRAFFIC_ROUTING_OFFERING_IDS,
	LAKEBED_TRAFFIC_ROUTING_PROFILE,
	parsePublishedManifest,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

function capabilityFor(port: string) {
	const provider = createLakebedProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation — honest closed-PaaS verdicts", () => {
	it("full: Capsule compute satisfies http + managed + sync-rpc", () => {
		assert.deepEqual(
			capabilityFor("compute").satisfies({
				port: "compute",
				features: ["http", "managed", "sync-rpc"],
			}),
			{ kind: "full" },
		);
	});

	it("partial: a container require on the Capsule runtime names the gap (ADR-0033)", () => {
		assert.deepEqual(
			capabilityFor("compute").satisfies({
				port: "compute",
				features: ["container", "http"],
			}),
			{ kind: "partial", missing: ["container"] },
		);
	});

	it("partial: a postgres require on the Reactive DB names the gap", () => {
		assert.deepEqual(
			capabilityFor("database").satisfies({
				port: "database",
				features: ["postgres", "managed"],
			}),
			{ kind: "partial", missing: ["postgres"] },
		);
	});

	it("partial: strict S3 semantics on the File Store name the gaps", () => {
		assert.deepEqual(
			capabilityFor("objectStore").satisfies({
				port: "objectStore",
				features: ["durable", "s3-compatible"],
			}),
			{ kind: "partial", missing: ["s3-compatible"] },
		);
	});

	it("none: a queue request has no Lakebed capability at all", () => {
		const provider = createLakebedProvider();
		assert.equal(
			provider.capabilities.some((entry) => entry.port === "queue"),
			false,
		);
	});
});

describe("capabilityManifest: published well-known bundle", () => {
	it("parses cleanly and publishes the brokered-deploy-token posture", () => {
		const provider = createLakebedProvider();
		const manifest = provider.capabilityManifest();
		assert.equal(manifest.providerId, LAKEBED_PROVIDER_ID);

		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.auth.mode, "svid-federation");
		assert.equal(parsed.auth.exchange, "hobo:brokered-deploy-token");
		assert.equal(parsed.auth.staticSecrets, false);
	});

	it("advertises the four honestly-scoped capabilities", () => {
		const provider = createLakebedProvider();
		const capabilitiesDoc = provider.capabilityManifest().capabilities;
		const capabilities = isJsonObject(capabilitiesDoc)
			? capabilitiesDoc.capabilities
			: undefined;
		assert.ok(Array.isArray(capabilities));
		assert.deepEqual(
			capabilities.map((c) => (isJsonObject(c) ? c.port : undefined)).sort(),
			["compute", "database", "kv", "objectStore"],
		);
	});
});

describe("client: runtime binding client per port", () => {
	it("returns the Capsule resource class and throws for unsupported ports", () => {
		const provider = createLakebedProvider();
		const client = provider.client("compute", { url: "https://x.lakebed.app" });
		assert.equal(client.resourceClass, "lakebed:capsule");
		assert.equal(client.providerService, "Capsule");
		assert.throws(() => provider.client("queue", {}));
	});
});

describe("TrafficRouting offerings surface", () => {
	it("declares inprocess + driver.route-bind offerings", () => {
		assert.ok(
			LAKEBED_TRAFFIC_ROUTING_OFFERING_IDS.includes("inprocess.weighted"),
		);
		assert.ok(
			LAKEBED_TRAFFIC_ROUTING_OFFERING_IDS.includes("driver.route-bind"),
		);
		assert.equal(LAKEBED_TRAFFIC_ROUTING_PROFILE.provider, "lakebed");
		assert.ok(LAKEBED_TRAFFIC_ROUTING_PROFILE.offerings.length >= 2);
	});
});
