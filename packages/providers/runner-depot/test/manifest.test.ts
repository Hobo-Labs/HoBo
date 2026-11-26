import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CATEGORY_PORTS,
	createGithubActionsClient,
	type GithubFetch,
	parseExecutionHostManifest,
} from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	COST_FACTS,
	createDepotCatalogEntry,
	createDepotRunnerProvider,
	DEPOT_DECLARED_CACHE_HIT_RATE,
	DEPOT_RUNS_ON_DEFAULT,
	executionHostManifest,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-depot-boundary.pact.json"),
		"utf8",
	),
);

describe("Depot execution-host manifest (Dispatcher lane)", () => {
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

	it("declares REAL Depot magnitudes: build minutes at list price + declared warm hit rate", () => {
		assert.equal(COST_FACTS["build-machine"].marginalPrice, "0.0400");
		assert.equal(COST_FACTS["build-machine"].included, 500);
		assert.equal(DEPOT_DECLARED_CACHE_HIT_RATE, "0.80");
		const manifest = executionHostManifest("build-machine");
		assert.deepEqual(manifest.capabilities[0]?.features, [
			"container-build",
			"remote-buildkit",
			"shared-cache",
		]);
	});
});

describe("published well-known bundle (registry lane)", () => {
	it("publishes the four well-known documents and parses clean", () => {
		const parsed = parsePublishedManifest(publishCapabilityManifest());
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
	});

	it("secretless posture matches the pact-recorded auth document (no static Depot tokens)", () => {
		const auth = JSON.parse(
			publishCapabilityManifest()["/.well-known/capability-manifest/auth.json"],
		);
		const recorded = pact.interactions[1].response.body;
		assert.equal(auth.schema, recorded.schema);
		assert.equal(auth.mode, recorded.mode);
		assert.equal(auth.tokenAudience, recorded.tokenAudience);
		assert.equal(auth.exchange, recorded.exchange);
		assert.equal(auth.staticSecrets, false);
	});

	it("the hobo add catalog entry exposes both execution-host ports with Depot cost facts", () => {
		const entry = createDepotCatalogEntry();
		assert.deepEqual(
			entry.capabilities.map((capability) => capability.port).sort(),
			["hobo:build-machine", "hobo:runner"],
		);
		const build = entry.capabilities.find(
			(capability) => capability.port === "hobo:build-machine",
		);
		assert.deepEqual(
			build?.satisfies({
				port: "hobo:build-machine",
				features: ["shared-cache"],
			}),
			{ kind: "full" },
		);
		assert.equal(
			build?.estimateCost({ port: "hobo:build-machine" }).marginalPrice,
			"0.0400",
		);
	});

	it("the runner lane dispatches with the Depot runs-on substitution", async () => {
		const bodies: string[] = [];
		const runBody = {
			id: 77,
			status: "completed",
			conclusion: "success",
			html_url: "https://github.com/hobo-dev/hobo-jobs/actions/runs/77",
		};
		const transport: GithubFetch = async (url, init) => {
			if (init.body) bodies.push(init.body);
			if (url.includes("/dispatches")) {
				return {
					ok: true,
					status: 204,
					text: async () => "",
					json: async () => ({}),
				};
			}
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ workflow_runs: [runBody] }),
			};
		};
		const provider = createDepotRunnerProvider({
			client: createGithubActionsClient({
				owner: "hobo-dev",
				repo: "hobo-jobs",
				token: async () => "ghs_token",
				fetch: transport,
			}),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		const result = await provider.run({ jobId: "job-depot" });
		assert.equal(result.status, "succeeded");
		const dispatched = JSON.parse(bodies[0] ?? "{}");
		assert.equal(dispatched.inputs.runs_on, DEPOT_RUNS_ON_DEFAULT);
	});
});
