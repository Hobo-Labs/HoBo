import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	CATEGORY_SKUS,
	type CreditLedgerView,
	createExecutionHostRegistry,
	createGithubActionsClient,
	createGithubRunnerProvider,
	DISPATCH_DECIDED,
	type ExecutionHostProviderLike,
	emptyLedgerView,
	executionHostManifest,
	GITHUB_RUNNER_PROVIDER_ID,
	selectExecutionHost,
} from "../src/index.js";

// A registered fixture sibling (the self-hosted Executors-behind-Relay
// default): free but with its OWN declared manifest, so ranking has a real
// alternative to re-route to when GitHub's free tier is exhausted.
function fixtureSibling(
	id: string,
	marginalPrice: string,
): ExecutionHostProviderLike {
	return {
		id,
		category: "runner",
		capabilityManifest() {
			const manifest = executionHostManifest("runner", { providerId: id });
			return {
				...manifest,
				cost: {
					...manifest.cost,
					facts: [
						{
							...manifest.cost.facts[0],
							marginalPrice,
						},
					],
				},
			};
		},
	};
}

function githubRunner() {
	return createGithubRunnerProvider({
		client: createGithubActionsClient({
			owner: "hobo-dev",
			repo: "hobo-jobs",
			token: async () => "unused-in-selection",
			fetch: async () => ({
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({}),
			}),
		}),
	});
}

const SKU = CATEGORY_SKUS.runner;

function ledger(
	balances: CreditLedgerView["balances"],
	seq = 42,
): CreditLedgerView {
	return { seq, balanceHash: "sha256:test-balance", balances };
}

describe("Dispatcher cost routing over registered execution hosts (ADR-0071)", () => {
	it("GitHub wins while its declared free minutes have headroom, and dispatch.Decided records why", () => {
		const registry = createExecutionHostRegistry([
			githubRunner(),
			fixtureSibling("paid-sibling", "0.0160"),
		]);
		const decision = selectExecutionHost(
			{
				category: "runner",
				dispatchId: "d-1",
				units: 10,
				ledgerView: ledger({
					[GITHUB_RUNNER_PROVIDER_ID]: { [SKU]: { freeHeadroom: 2000 } },
					"paid-sibling": { [SKU]: { freeHeadroom: 0 } },
				}),
			},
			registry,
		);

		assert.equal(decision.selectedProvider, GITHUB_RUNNER_PROVIDER_ID);
		assert.equal(decision.routingMode, "ranked");
		const fact = decision.dispatchDecided;
		assert.equal(fact.type, DISPATCH_DECIDED);
		assert.equal(fact.data.selectedProvider, GITHUB_RUNNER_PROVIDER_ID);
		assert.equal(fact.data.objective, "maximize-credits");
		assert.equal(fact.data.ledgerInput.view, "CreditLedgerView");
		assert.equal(fact.data.ledgerInput.seq, 42);
		assert.equal(fact.data.candidates.length, 2);
		assert.equal(fact.data.candidates[0]?.effectiveMarginalCost, 0);
	});

	it("free-tier exhaustion re-routes the next job to the cheapest remaining registered runner", () => {
		const registry = createExecutionHostRegistry([
			githubRunner(),
			fixtureSibling("self-hosted", "0.0000"),
		]);
		// GitHub's 2000 free minutes are spent; self-hosted stays free.
		const decision = selectExecutionHost(
			{
				category: "runner",
				dispatchId: "d-2",
				units: 10,
				ledgerView: ledger({
					[GITHUB_RUNNER_PROVIDER_ID]: { [SKU]: { freeHeadroom: 0 } },
					"self-hosted": { [SKU]: { freeHeadroom: 100000 } },
				}),
			},
			registry,
		);

		assert.equal(decision.selectedProvider, "self-hosted");
		const github = decision.candidates.find(
			(candidate) => candidate.providerId === GITHUB_RUNNER_PROVIDER_ID,
		);
		// GitHub falls back to its declared list price once free is gone.
		assert.equal(github?.effectiveMarginalCost, 0.006);
	});

	it("pinning a provider opts out of routing and says so in the fact", () => {
		const registry = createExecutionHostRegistry([
			githubRunner(),
			fixtureSibling("self-hosted", "0.0000"),
		]);
		const decision = selectExecutionHost(
			{
				category: "runner",
				dispatchId: "d-3",
				withProvider: GITHUB_RUNNER_PROVIDER_ID,
				ledgerView: emptyLedgerView(),
			},
			registry,
		);

		assert.equal(decision.selectedProvider, GITHUB_RUNNER_PROVIDER_ID);
		assert.equal(decision.routingMode, "pinned");
		assert.equal(decision.optedOutOfRouting, true);
	});

	it("selection is deterministic: identical inputs produce the identical decision fact", () => {
		const build = () =>
			selectExecutionHost(
				{
					category: "runner",
					dispatchId: "d-4",
					units: 5,
					ledgerView: ledger({}),
				},
				createExecutionHostRegistry([
					githubRunner(),
					fixtureSibling("self-hosted", "0.0000"),
				]),
			);
		assert.deepEqual(build(), build());
	});

	it("rejects unregistered pins and empty categories instead of inventing hosts", () => {
		const registry = createExecutionHostRegistry([githubRunner()]);
		assert.throws(() =>
			selectExecutionHost(
				{ category: "runner", dispatchId: "d-5", withProvider: "depot" },
				registry,
			),
		);
		assert.throws(() =>
			selectExecutionHost(
				{ category: "build-machine", dispatchId: "d-6" },
				registry,
			),
		);
	});
});
