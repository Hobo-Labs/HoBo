import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	CATEGORY_PORTS,
	COST_FACTS,
	createGithubRunnerCatalogEntry,
	executionHostManifest,
	parseExecutionHostManifest,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-github-boundary.pact.json"),
		"utf8",
	),
);

describe("execution-host capability manifest (Dispatcher lane)", () => {
	it("both category manifests parse clean with the category SKU pinned", () => {
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

	it("declares transcribed GitHub Actions list prices, not uniform zeros", () => {
		assert.equal(COST_FACTS.runner.marginalPrice, "0.0060");
		assert.equal(COST_FACTS.runner.included, 2000);
		const manifest = executionHostManifest("runner");
		assert.equal(manifest.cost.facts[0]?.freeTier.included, 2000);
		assert.equal(manifest.cost.facts[0]?.source.type, "declared-provider");
	});

	it("rejects a cross-category manifest instead of mismatching ports", () => {
		const parsed = parseExecutionHostManifest(executionHostManifest("runner"), {
			category: "build-machine",
		});
		assert.equal(parsed.ok, false);
	});
});

describe("published well-known bundle (registry lane)", () => {
	it("publishes the four well-known documents and parses clean", () => {
		const documents = publishCapabilityManifest();
		const parsed = parsePublishedManifest(documents);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
	});

	it("secretless posture matches the pact-recorded auth document (no PATs)", () => {
		const documents = publishCapabilityManifest();
		const auth = JSON.parse(
			documents["/.well-known/capability-manifest/auth.json"],
		);
		const recorded = pact.interactions[2].response.body;
		assert.equal(auth.schema, recorded.schema);
		assert.equal(auth.mode, recorded.mode);
		assert.equal(auth.tokenAudience, recorded.tokenAudience);
		assert.equal(auth.exchange, recorded.exchange);
		assert.equal(auth.staticSecrets, false);
	});

	it("the hobo add catalog entry exposes both execution-host ports with cost facts", () => {
		const entry = createGithubRunnerCatalogEntry();
		assert.deepEqual(
			entry.capabilities.map((capability) => capability.port).sort(),
			["hobo:build-machine", "hobo:runner"],
		);
		const runner = entry.capabilities.find(
			(capability) => capability.port === "hobo:runner",
		);
		assert.deepEqual(runner?.satisfies({ port: "hobo:runner" }), {
			kind: "full",
		});
		assert.deepEqual(runner?.satisfies({ port: "compute" }), { kind: "none" });
		assert.deepEqual(
			runner?.satisfies({ port: "hobo:runner", features: ["gpu"] }),
			{ kind: "partial", missing: ["gpu"] },
		);
		assert.equal(
			runner?.estimateCost({ port: "hobo:runner" }).marginalPrice,
			"0.0060",
		);
		const manifest = entry.capabilityManifest();
		assert.equal(manifest.capabilities.capabilities?.length, 2);
		assert.equal(manifest.cost.facts?.length, 2);
	});
});
