/**
 * Executable step definitions for contracts-policy-governance.feature.
 *
 * Drives the epic's real mocked boundary harness and Gatekeeper simulations
 * (services/reference-architecture.ts) and asserts the governance decisions
 * they actually produce — no live policy or registry services.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
	createMockBoundaryHarness,
	runDenyCeilingBypassSimulation,
	runFailClosedSimulation,
	runGovernedDeploySimulation,
	validateBoundaryCoverage,
} from "../../services/reference-architecture.js";

type Harness = ReturnType<typeof createMockBoundaryHarness>;
type Governed = Awaited<ReturnType<typeof runGovernedDeploySimulation>>;
type DenyCeiling = Awaited<ReturnType<typeof runDenyCeilingBypassSimulation>>;
type FailClosed = Awaited<ReturnType<typeof runFailClosedSimulation>>;

type GovernanceWorld = {
	harness?: Harness;
	governed?: Governed;
	denyCeiling?: DenyCeiling;
	failClosed?: FailClosed;
};

// --- Scenario: Compatible deploy produces auditable approval obligations ----------------

Given(
	"a production camp with mandatory contract, policy, obligation, cost, provenance, and conformance gates",
	function (this: GovernanceWorld) {
		this.harness = createMockBoundaryHarness();
		assert.deepEqual(
			this.harness.networkCalls,
			[],
			"harness starts with no live calls",
		);
	},
);

When(
	"the platform SRE asks Gatekeeper to verify a compatible deploy",
	async function (this: GovernanceWorld) {
		assert.ok(this.harness, "harness must exist");
		this.governed = await runGovernedDeploySimulation(this.harness);
	},
);

Then(
	"Gatekeeper allows the deploy with approval obligations and replayable evidence",
	function (this: GovernanceWorld) {
		const governed = this.governed;
		assert.ok(governed);
		assert.equal(governed.gatekeeper.deployable, true);
		assert.equal(governed.gatekeeper.status, "deployable");
		assert.equal(governed.policyDecision.effect, "require-approval");
		assert.deepEqual(
			governed.obligationGate.reasons,
			[],
			"no blocking obligation reasons",
		);
		assert.equal(
			governed.conformanceReplay.matchesRecordedDecision,
			true,
			"decision replays from evidence",
		);
	},
);

Then(
	"every declared governance boundary reports a mocked decision with no live network calls",
	function (this: GovernanceWorld) {
		assert.ok(this.governed && this.harness);
		assert.deepEqual(
			validateBoundaryCoverage(this.governed.boundaryDecisions),
			{
				ok: true,
				missing: [],
				extra: [],
			},
		);
		assert.deepEqual(
			this.harness.networkCalls,
			[],
			"no simulated live service calls occurred",
		);
	},
);

// --- Scenario: Mandatory governance cannot be bypassed ----------------------------------

Given(
	"a bindle-level policy pack that tries to disable mandatory contract gates",
	function (this: GovernanceWorld) {
		this.harness = createMockBoundaryHarness();
	},
);

When(
	"Gatekeeper evaluates the deploy against the yard deny ceiling",
	async function (this: GovernanceWorld) {
		assert.ok(this.harness);
		this.denyCeiling = await runDenyCeilingBypassSimulation(this.harness);
	},
);

Then(
	"the deny ceiling keeps mandatory gates enabled and Gatekeeper blocks the deploy",
	function (this: GovernanceWorld) {
		const result = this.denyCeiling;
		assert.ok(result);
		assert.equal(result.gatekeeper.deployable, false);
		assert.equal(result.gatekeeper.status, "blocked");
		assert.equal(result.denyCeiling.ok, false, "bypass attempt is flagged");
		assert.match(
			result.gatekeeper.failures
				.map((failure: { reason: string }) => failure.reason)
				.join("\n"),
			/mandatory deny-ceiling forbids disabling contracts/,
		);
	},
);

// --- Scenario: Policy uncertainty fails closed ------------------------------------------

Given(
	"the policy engine and signed policy-pack registry are unavailable",
	function (this: GovernanceWorld) {
		this.harness = createMockBoundaryHarness({
			policyProviderMode: "unavailable",
		});
	},
);

When(
	"Gatekeeper verifies the production deploy without a policy decision",
	async function (this: GovernanceWorld) {
		assert.ok(this.harness);
		this.failClosed = await runFailClosedSimulation(this.harness);
	},
);

Then(
	"the deploy is denied with a fail-closed reason from the mocked policy boundary",
	function (this: GovernanceWorld) {
		const result = this.failClosed;
		assert.ok(result);
		assert.equal(result.gatekeeper.deployable, false);
		assert.equal(result.failClosedDecision.effect, "deny");
		assert.equal(result.failClosedDecision.failClosed, true);
		assert.match(
			result.failClosedDecision.reason,
			/policy evaluator unavailable/,
		);
		assert.equal(
			result.boundaryDecisions["Gatekeeper to Policy Engine"].status,
			"mocked_provider_unavailable",
		);
	},
);
