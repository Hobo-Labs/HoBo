import assert from "node:assert/strict";
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
	BLACKSMITH_PROVIDER_ID,
	createBlacksmithRunnerProvider,
} from "../src/index.js";

// Acceptance (HOBO-719): with GitHub and Blacksmith BOTH registered, the
// min-cost objective routes to the cheaper effective option and records the
// rationale in dispatch.Decided (ADR-0071).

const noopFetch: GithubFetch = async () => ({
	ok: true,
	status: 200,
	text: async () => "",
	json: async () => ({}),
});

function client() {
	return createGithubActionsClient({
		owner: "hobo-dev",
		repo: "hobo-jobs",
		token: async () => "unused-in-selection",
		fetch: noopFetch,
	});
}

const SKU = CATEGORY_SKUS.runner;

function registry() {
	return createExecutionHostRegistry([
		createGithubRunnerProvider({ client: client() }),
		createBlacksmithRunnerProvider({ client: client() }),
	]);
}

describe("Dispatcher routing across github + blacksmith (min-cost, ADR-0071)", () => {
	it("routes to Blacksmith when both free tiers are exhausted — half the list price wins", () => {
		const decision = selectExecutionHost(
			{
				category: "runner",
				dispatchId: "d-price",
				objective: "cost",
				units: 10,
				ledgerView: {
					seq: 7,
					balanceHash: "sha256:test",
					balances: {
						[GITHUB_RUNNER_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
						[BLACKSMITH_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
					},
				},
			},
			registry(),
		);

		assert.equal(decision.selectedProvider, BLACKSMITH_PROVIDER_ID);
		const rationale = decision.dispatchDecided.data;
		assert.equal(rationale.selectedProvider, BLACKSMITH_PROVIDER_ID);
		assert.equal(rationale.objective, "cost");
		const costs = Object.fromEntries(
			rationale.candidates.map((candidate) => [
				candidate.provider,
				candidate.effectiveMarginalCost,
			]),
		);
		assert.equal(costs[BLACKSMITH_PROVIDER_ID], 0.004);
		assert.equal(costs[GITHUB_RUNNER_PROVIDER_ID], 0.006);
	});

	it("still routes to GitHub while GitHub free headroom covers the job and Blacksmith's is gone", () => {
		const decision = selectExecutionHost(
			{
				category: "runner",
				dispatchId: "d-free",
				units: 10,
				ledgerView: {
					seq: 8,
					balanceHash: "sha256:test",
					balances: {
						[GITHUB_RUNNER_PROVIDER_ID]: { [SKU]: { freeHeadroom: 500 } },
						[BLACKSMITH_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
					},
				},
			},
			registry(),
		);

		assert.equal(decision.selectedProvider, GITHUB_RUNNER_PROVIDER_ID);
	});

	it("both manifests register cleanly in one execution-host registry (conformance)", () => {
		const hosts = registry();
		assert.equal(hosts.byCategory.get("runner")?.length, 2);
		assert.ok(hosts.byId.get(`runner:${BLACKSMITH_PROVIDER_ID}`));
		assert.ok(hosts.byId.get(`runner:${GITHUB_RUNNER_PROVIDER_ID}`));
	});
});
