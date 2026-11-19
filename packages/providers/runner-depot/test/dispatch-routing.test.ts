import assert from "node:assert/strict";
import { createBlacksmithRunnerProvider } from "@hobo/runner-blacksmith";
import {
	CATEGORY_SKUS,
	createExecutionHostRegistry,
	createGithubActionsClient,
	createGithubRunnerProvider,
	GITHUB_RUNNER_PROVIDER_ID,
	type GithubFetch,
	selectExecutionHost,
} from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	createDepotBuildMachineProvider,
	createDepotClient,
	createDepotRunnerProvider,
	DEPOT_PROVIDER_ID,
} from "../src/index.js";

const noopFetch: GithubFetch = async () => ({
	ok: true,
	status: 200,
	text: async () => "",
	json: async () => ({}),
});

function githubClient() {
	return createGithubActionsClient({
		owner: "hobo-dev",
		repo: "hobo-jobs",
		token: async () => "unused-in-selection",
		fetch: noopFetch,
	});
}

function depotClient() {
	return createDepotClient({
		projectId: "hobo-builds",
		token: async () => "unused-in-selection",
		fetch: async () => ({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({}),
		}),
	});
}

const BLACKSMITH_PROVIDER_ID = "@hobo/runner-blacksmith";

function runnerRegistry() {
	return createExecutionHostRegistry([
		createGithubRunnerProvider({ client: githubClient() }),
		createBlacksmithRunnerProvider({ client: githubClient() }),
		createDepotRunnerProvider({ client: githubClient() }),
	]);
}

describe("Dispatcher routing across the M3 trio (ADR-0071)", () => {
	it("ranks all three runners and dispatch.Decided explains the pick", () => {
		const SKU = CATEGORY_SKUS.runner;
		const decision = selectExecutionHost(
			{
				category: "runner",
				dispatchId: "d-trio",
				objective: "cost",
				units: 10,
				ledgerView: {
					seq: 11,
					balanceHash: "sha256:test",
					balances: {
						[GITHUB_RUNNER_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
						[BLACKSMITH_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
						[DEPOT_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
					},
				},
			},
			runnerRegistry(),
		);

		assert.equal(decision.selectedProvider, BLACKSMITH_PROVIDER_ID);
		assert.equal(decision.dispatchDecided.data.candidates.length, 3);
		const costs = Object.fromEntries(
			decision.dispatchDecided.data.candidates.map((candidate) => [
				candidate.provider,
				candidate.effectiveMarginalCost,
			]),
		);
		assert.equal(costs[DEPOT_PROVIDER_ID], 0.004);
		assert.equal(costs[GITHUB_RUNNER_PROVIDER_ID], 0.006);
	});

	it("a warm-cache Depot build outranks a free-exhausted cold GitHub build", () => {
		const SKU = CATEGORY_SKUS["build-machine"];
		const registry = createExecutionHostRegistry([
			createDepotBuildMachineProvider({
				client: depotClient(),
				registry: "registry.depot.dev/hobo-builds",
			}),
		]);
		const decision = selectExecutionHost(
			{
				category: "build-machine",
				dispatchId: "d-warm",
				objective: "maximize-credits",
				units: 10,
				ledgerView: {
					seq: 12,
					balanceHash: "sha256:test",
					balances: {
						[DEPOT_PROVIDER_ID]: {
							[SKU]: { freeHeadroom: 0, marginalUnitCost: 0.004 },
						},
					},
				},
			},
			registry,
		);

		assert.equal(decision.selectedProvider, DEPOT_PROVIDER_ID);
		assert.equal(
			decision.dispatchDecided.data.candidates[0]?.effectiveMarginalCost,
			0.004,
		);
	});

	it("all three manifests register cleanly in one execution-host registry (conformance)", () => {
		const registry = runnerRegistry();
		assert.equal(registry.byCategory.get("runner")?.length, 3);
		for (const id of [
			GITHUB_RUNNER_PROVIDER_ID,
			BLACKSMITH_PROVIDER_ID,
			DEPOT_PROVIDER_ID,
		]) {
			assert.ok(registry.byId.get(`runner:${id}`), id);
		}
	});
});
