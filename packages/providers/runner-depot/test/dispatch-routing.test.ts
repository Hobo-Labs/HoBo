import assert from "node:assert/strict";
import { createBlacksmithRunnerProvider } from "@hobo/runner-blacksmith";
import {
	CATEGORY_SKUS,
	createExecutionHostRegistry,
	createGithubActionsClient,
	createGithubBuildMachineProvider,
	createGithubRunnerProvider,
	GITHUB_RUNNER_PROVIDER_ID,
	type GithubFetch,
	projectBuildCosts,
	selectExecutionHost,
} from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	createDepotBuildMachineProvider,
	createDepotClient,
	createDepotRunnerProvider,
	DEPOT_PROVIDER_ID,
	type CacheHitFact,
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
			json: async () => ({ build_id: "build-1", build_token: "test-token" }),
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

	it("routes a repeated build using the recorded Depot metering estimate", async () => {
		const SKU = CATEGORY_SKUS["build-machine"];
		const facts: CacheHitFact[] = [];
		const depot = createDepotBuildMachineProvider({
			client: depotClient(),
			registry: "registry.depot.dev/hobo-builds",
			executor: {
				async execute() {
					return {
						digest: `sha256:${"a".repeat(64)}`,
						cacheHitRatio: 0.9,
						meteredUnits: 1,
					};
				},
			},
			onFact: (fact) => facts.push(fact),
		});
		const registry = createExecutionHostRegistry([
			depot,
			createGithubBuildMachineProvider({
				client: githubClient(),
				owner: "hobo",
			}),
		]);
		await depot.execute({ buildId: "checkout", estimatedUnits: 10 });
		const observed = facts[0];
		assert.ok(observed);
		const ledgerView = projectBuildCosts(
			{
				seq: 11,
				balanceHash: "sha256:test",
				balances: {
					[DEPOT_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
					[GITHUB_RUNNER_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
				},
			},
			registry,
			"checkout",
			[{ ...observed, seq: 12 }],
		);
		const decision = selectExecutionHost(
			{
				category: "build-machine",
				dispatchId: "d-warm",
				buildId: "checkout",
				objective: "maximize-credits",
				units: 10,
				ledgerView,
			},
			registry,
		);

		assert.equal(decision.selectedProvider, DEPOT_PROVIDER_ID);
		assert.equal(
			decision.dispatchDecided.data.candidates[0]?.effectiveMarginalCost,
			0.004,
		);
		assert.equal(decision.candidates.length, 2);
		assert.equal(decision.candidates[1]?.providerId, GITHUB_RUNNER_PROVIDER_ID);
		assert.equal(decision.candidates[1]?.effectiveMarginalCost, 0.006);
		assert.equal(decision.dispatchDecided.data.ledgerInput.seq, 12);
		assert.equal(
			decision.dispatchDecided.data.ledgerInput.balanceHash,
			ledgerView.balanceHash,
		);
	});

	it("rejects invalid executor measurements without debiting the budget", async () => {
		const budget = { remainingUnits: 10 };
		const facts: CacheHitFact[] = [];
		const depot = createDepotBuildMachineProvider({
			client: depotClient(),
			registry: "registry.depot.dev/hobo-builds",
			creditBudget: budget,
			executor: {
				async execute() {
					return {
						digest: `sha256:${"a".repeat(64)}`,
						cacheHitRatio: 0.5,
						meteredUnits: -1,
					};
				},
			},
			onFact: (fact) => facts.push(fact),
		});
		await assert.rejects(
			depot.execute({ buildId: "checkout", estimatedUnits: 10 }),
			/measurements/,
		);
		assert.equal(budget.remainingUnits, 10);
		assert.deepEqual(facts, []);
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
