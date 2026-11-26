import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	createHostingerProvider,
	HOSTINGER_PROVIDER_ID,
	HOSTINGER_TRAFFIC_ROUTING_OFFERING_IDS,
	HOSTINGER_TRAFFIC_ROUTING_PROFILE,
	parsePublishedManifest,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../src/json.js";

function capabilityFor(port: string) {
	const provider = createHostingerProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation (full | partial | none)", () => {
	it("full: managed MySQL satisfies mysql + relational + managed", () => {
		const match = capabilityFor("database").satisfies({
			port: "database",
			features: ["mysql", "relational", "managed"],
		});
		assert.deepEqual(match, { kind: "full" });
	});

	it("partial: a postgres request on MySQL returns the missing feature", () => {
		const match = capabilityFor("database").satisfies({
			port: "database",
			features: ["relational", "postgres"],
		});
		assert.deepEqual(match, { kind: "partial", missing: ["postgres"] });
	});

	it("none: an objectStore request is not a compute capability", () => {
		const match = capabilityFor("compute").satisfies({ port: "objectStore" });
		assert.deepEqual(match, { kind: "none" });
	});

	/**
	 * Hostinger sells hosting plans, not infrastructure primitives. Declaring an
	 * objectStore or cache row would make Matching answer `full` for a capability
	 * nothing can realize.
	 */
	it("declares only the two ports Hostinger actually sells", () => {
		const provider = createHostingerProvider();
		const ports = provider.capabilities.map((entry) => entry.port).sort();
		assert.deepEqual(ports, ["compute", "database"]);
		for (const absent of ["objectStore", "cache", "queue", "kv"]) {
			assert.equal(
				ports.includes(absent),
				false,
				`Hostinger has no managed ${absent}; a row for one would be a portability lie`,
			);
		}
	});
});

describe("estimateCost: declared marginal-cost facts per class", () => {
	it("returns a real nonzero VPS magnitude", () => {
		const compute = capabilityFor("compute").estimateCost({ port: "compute" });
		assert.equal(compute.sku, "hostinger.vps.kvm1.instance-hour");
		assert.ok(Number.parseFloat(compute.marginalPrice) > 0);
	});

	/**
	 * A genuine zero, not a placeholder: the database is included in the hosting
	 * plan rather than billed separately, so the marginal cost really is nothing
	 * and the free-tier fact is what carries "it comes with the plan".
	 */
	it("prices the included MySQL database at a truthful zero", () => {
		const database = capabilityFor("database").estimateCost({
			port: "database",
		});
		assert.equal(database.sku, "hostinger.mysql.database-hour");
		assert.equal(database.marginalPrice, "0.0000");
		assert.equal(database.freeTier.included, 730);
		assert.equal(database.freeTier.reset, "monthly");
	});
});

describe("capabilityManifest: published well-known bundle", () => {
	it("parses cleanly and publishes a posture with no static secrets", () => {
		const provider = createHostingerProvider();
		const manifest = provider.capabilityManifest();
		assert.equal(manifest.providerId, HOSTINGER_PROVIDER_ID);

		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.auth.mode, "svid-federation");
		assert.equal(parsed.auth.exchange, "hobo:broker-credential-locator");
		assert.equal(parsed.auth.staticSecrets, false);
	});

	it("advertises both equivalence-class capabilities with data centres", () => {
		const provider = createHostingerProvider({ regions: ["ams"] });
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
			["compute", "database"],
		);
		for (const capability of capabilities) {
			if (!isJsonObject(capability)) {
				throw new Error("expected a capability");
			}
			assert.deepEqual(capability.regions, ["ams"]);
		}
	});
});

describe("client: runtime binding client per port", () => {
	it("returns the resource class + service for a known port and throws for unknown", () => {
		const provider = createHostingerProvider();
		const client = provider.client("database", { host: "mysql.example" });
		assert.equal(client.resourceClass, "hostinger:mysql-database");
		assert.equal(client.providerService, "Hostinger managed MySQL");
		assert.deepEqual(client.bindings, { host: "mysql.example" });
		assert.throws(() => provider.client("objectStore", {}));
	});
});

describe("TrafficRouting offerings surface", () => {
	/**
	 * Hostinger sells no load balancer. Declaring `lb.*` as preview would let
	 * Matching negotiate a feature that then falls through at realization, which
	 * is worse than declaring nothing.
	 */
	it("declares DNS routing and the fallback floor, and no lb.* offering", () => {
		assert.ok(HOSTINGER_TRAFFIC_ROUTING_OFFERING_IDS.includes("dns.weighted"));
		assert.ok(
			HOSTINGER_TRAFFIC_ROUTING_OFFERING_IDS.includes("inprocess.weighted"),
		);
		assert.equal(
			HOSTINGER_TRAFFIC_ROUTING_OFFERING_IDS.some((id) => id.startsWith("lb.")),
			false,
		);
		assert.ok(
			HOSTINGER_TRAFFIC_ROUTING_PROFILE.fallbacks.includes(
				"inprocess.weighted",
			),
		);
	});
});
