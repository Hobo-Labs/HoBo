import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	CONVEX_LIMITS,
	CONVEX_PARADIGM,
	CONVEX_PROVIDER_ID,
	convexImpedanceFindings,
	createConvexProvider,
	parsePublishedManifest,
} from "../src/index.js";

function capabilityFor(port: string) {
	const provider = createConvexProvider();
	const capability = provider.capabilities.find((entry) => entry.port === port);
	assert.ok(capability, `expected capability for ${port}`);
	return capability;
}

describe("Capability.satisfies negotiation — honest closed-BaaS verdicts", () => {
	it("full: reactive document database with vector search as a feature", () => {
		assert.deepEqual(
			capabilityFor("database").satisfies({
				port: "database",
				features: ["document", "reactive", "search.vector"],
			}),
			{ kind: "full" },
		);
	});

	it("partial: a relational require on the document store names the gap", () => {
		assert.deepEqual(
			capabilityFor("database").satisfies({
				port: "database",
				features: ["relational", "document"],
			}),
			{ kind: "partial", missing: ["relational"] },
		);
	});

	it("partial: a container require on the function host names the gap", () => {
		assert.deepEqual(
			capabilityFor("compute").satisfies({
				port: "compute",
				features: ["container", "http"],
			}),
			{ kind: "partial", missing: ["container"] },
		);
	});

	it("none: a port the provider does not serve", () => {
		assert.deepEqual(capabilityFor("compute").satisfies({ port: "queue" }), {
			kind: "none",
		});
	});

	it("cost signals carry declared public-pricing magnitudes", () => {
		const signal = capabilityFor("database").estimateCost({
			port: "database",
		});
		assert.equal(signal.currency, "USD");
		assert.equal(signal.sku, "convex.db.gb-month");
		assert.ok(Number(signal.marginalPrice) > 0);
	});
});

describe("capability manifest", () => {
	it("publishes four well-known documents that parse clean", () => {
		const provider = createConvexProvider();
		const manifest = provider.capabilityManifest();
		assert.equal(manifest.providerId, CONVEX_PROVIDER_ID);
		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
	});

	it("auth document publishes brokered posture and never a static key", () => {
		const provider = createConvexProvider();
		const auth = provider.capabilityManifest().auth;
		assert.equal(auth.mode, "deploy-key-brokered");
		assert.equal(auth.staticSecrets, false);
		assert.ok(!("staticKey" in auth));
		assert.ok(!("deployKey" in auth));
	});

	it("parse fails closed when a static secret sneaks into auth", () => {
		const provider = createConvexProvider();
		const published = { ...provider.capabilityManifest().published };
		const auth = JSON.parse(
			published["/.well-known/capability-manifest/auth.json"],
		);
		auth.deployKey = "prod:abc123";
		published["/.well-known/capability-manifest/auth.json"] =
			JSON.stringify(auth);
		const parsed = parsePublishedManifest(published);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.errors.some((error) => error.includes("static secrets")));
	});
});

describe("impedance boundaries are typed, not prose", () => {
	it("hard limits match the vendor documentation", () => {
		assert.equal(CONVEX_LIMITS.queryMutationMs, 1_000);
		assert.equal(CONVEX_LIMITS.documentBytes, 1_048_576);
		assert.equal(CONVEX_LIMITS.actionMs, 600_000);
		assert.equal(CONVEX_PARADIGM, "document");
	});

	it("a relational paradigm request is a blocking mismatch", () => {
		const findings = convexImpedanceFindings({ paradigm: "relational" });
		const block = findings.find((entry) => entry.severity === "block");
		assert.ok(block);
		assert.equal(block.code, "paradigm-mismatch");
	});

	it("time-travel expectations surface the replay boundary", () => {
		const findings = convexImpedanceFindings({ features: ["time-travel"] });
		assert.ok(
			findings.some((entry) => entry.code === "no-control-plane-time-travel"),
		);
	});

	it("a document paradigm request produces no blockers", () => {
		const findings = convexImpedanceFindings({ paradigm: "document" });
		assert.ok(!findings.some((entry) => entry.severity === "block"));
	});
});
