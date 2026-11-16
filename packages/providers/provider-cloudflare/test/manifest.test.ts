import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	createCloudflareProvider,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "../src/index.js";
import { isJsonArray, isJsonObject, isJsonString } from "../src/json.js";

describe("Capability Manifest publication (FR-031)", () => {
	it("publishes capabilities, auth, and cost.json under /.well-known/capability-manifest/", () => {
		const documents = publishCapabilityManifest();
		const parsed = parsePublishedManifest(documents);

		assert.equal(parsed.ok, true);
		assert.equal(parsed.auth.schema, "hobo.provider-auth/v1");
		assert.equal(parsed.cost.schema, "hobo.cost/v1");
		const listed = parsed.capabilities.capabilities;
		if (!isJsonArray(listed)) {
			throw new Error("expected capabilities.capabilities to be an array");
		}
		assert.equal(listed.length, 3);
		assert.deepEqual(
			listed
				.map((entry) => (isJsonObject(entry) ? entry.port : undefined))
				.filter(isJsonString)
				.sort(),
			["compute", "kv", "objectStore"],
		);
		const compute = listed.find(
			(entry) => isJsonObject(entry) && entry.port === "compute",
		);
		assert.ok(isJsonObject(compute));
		assert.equal(compute.productId, "cloudflare.workers/v1");
	});

	it("rejects manifests that publish static secrets", () => {
		const documents = publishCapabilityManifest();
		const auth = JSON.parse(
			documents["/.well-known/capability-manifest/auth.json"],
		);
		auth.staticKey = "secret";
		documents["/.well-known/capability-manifest/auth.json"] =
			`${JSON.stringify(auth, null, 2)}\n`;
		const parsed = parsePublishedManifest(documents);

		assert.equal(parsed.ok, false);
		assert.ok(parsed.errors.includes("auth must not publish static secrets"));
	});
});

describe("CloudProvider.capabilityManifest() shape", () => {
	it("returns the published bundle plus parsed capabilities/auth/cost", () => {
		const provider = createCloudflareProvider();
		const manifest = provider.capabilityManifest();

		assert.equal(manifest.providerId, "@hobo/provider-cloudflare");
		assert.deepEqual(Object.keys(manifest.published).sort(), [
			"/.well-known/capability-manifest/auth.json",
			"/.well-known/capability-manifest/capabilities.json",
			"/.well-known/capability-manifest/cost.json",
			"/.well-known/capability-manifest/index.json",
		]);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const caps = manifest.capabilities as {
			capabilities: Array<{ port: string }>;
		};
		assert.deepEqual(caps.capabilities.map((c) => c.port).sort(), [
			"compute",
			"kv",
			"objectStore",
		]);
		assert.equal(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			(manifest.auth as { staticSecrets: boolean }).staticSecrets,
			false,
		);
	});

	it("advertises the configured colo regions", () => {
		const provider = createCloudflareProvider({ colos: ["WNAM", "APAC"] });
		assert.deepEqual(provider.regions, ["WNAM", "APAC"]);
	});
});

describe("Equivalence-class mappings (all three initial ports)", () => {
	it("maps web/service, kv, and objectStore to Cloudflare resource classes", () => {
		assert.equal(
			equivalenceForPort("web/service").resourceClass,
			"cloudflare:workers-script",
		);
		assert.equal(
			equivalenceForPort("kv").resourceClass,
			"cloudflare:kv-namespace",
		);
		assert.equal(
			equivalenceForPort("objectStore").resourceClass,
			"cloudflare:r2-bucket",
		);
		assert.deepEqual(INITIAL_CAPABILITY_PORTS, [
			"web/service",
			"kv",
			"objectStore",
		]);
	});

	it("maps each class to Workers/KV/R2 provider services", () => {
		assert.equal(equivalenceForPort("web/service").providerService, "Workers");
		assert.equal(equivalenceForPort("kv").providerService, "KV");
		assert.equal(equivalenceForPort("objectStore").providerService, "R2");
	});
});
