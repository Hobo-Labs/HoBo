import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CATEGORY_PORTS,
	parseExecutionHostManifest,
} from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	COST_FACTS,
	createBlacksmithCatalogEntry,
	executionHostManifest,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-blacksmith-boundary.pact.json"),
		"utf8",
	),
);

describe("Blacksmith execution-host manifest (Dispatcher lane)", () => {
	it("both category manifests parse clean through the SHARED execution-host boundary", () => {
		for (const category of ["runner", "build-machine"] as const) {
			const parsed = parseExecutionHostManifest(
				executionHostManifest(category),
				{ category },
			);
			assert.deepEqual(parsed.errors, []);
			assert.equal(parsed.ok, true);
			assert.equal(
				parsed.manifest?.capabilities[0]?.port,
				CATEGORY_PORTS[category],
			);
		}
	});

	it("declares REAL Blacksmith list prices — half of GitHub's, with 3000 free minutes", () => {
		assert.equal(COST_FACTS.runner.marginalPrice, "0.0040");
		assert.equal(COST_FACTS.runner.included, 3000);
		const manifest = executionHostManifest("build-machine");
		assert.deepEqual(manifest.capabilities[0]?.features, [
			"container-build",
			"ghcr-publish",
			"docker-layer-cache",
		]);
	});
});

describe("published well-known bundle (registry lane)", () => {
	it("publishes the four well-known documents and parses clean", () => {
		const parsed = parsePublishedManifest(publishCapabilityManifest());
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
	});

	it("secretless posture matches the pact-recorded auth document (no static org tokens)", () => {
		const auth = JSON.parse(
			publishCapabilityManifest()["/.well-known/capability-manifest/auth.json"],
		);
		const recorded = pact.interactions[1].response.body;
		assert.equal(auth.schema, recorded.schema);
		assert.equal(auth.mode, recorded.mode);
		assert.equal(auth.exchange, recorded.exchange);
		assert.equal(auth.substrate.exchange, recorded.substrate.exchange);
		assert.equal(auth.staticSecrets, false);
	});

	it("the hobo add catalog entry exposes both execution-host ports with Blacksmith cost facts", () => {
		const entry = createBlacksmithCatalogEntry();
		assert.deepEqual(
			entry.capabilities.map((capability) => capability.port).sort(),
			["hobo:build-machine", "hobo:runner"],
		);
		const runner = entry.capabilities.find(
			(capability) => capability.port === "hobo:runner",
		);
		assert.deepEqual(
			runner?.satisfies({ port: "hobo:runner", features: ["fast-runner"] }),
			{ kind: "full" },
		);
		assert.equal(
			runner?.estimateCost({ port: "hobo:runner" }).marginalPrice,
			"0.0040",
		);
	});
});
