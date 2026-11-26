/**
 * Executable step definitions for cli-mcp-developer-experience.feature.
 *
 * Runs the epic's real reference simulation (services/cli-mcp-reference.ts) —
 * every provider boundary is mocked, no live services — and asserts each
 * scenario against the artifacts the simulation actually produces.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runCliMcpDeveloperExperienceReference } from "../../services/cli-mcp-reference.js";

type Reference = Awaited<
	ReturnType<typeof runCliMcpDeveloperExperienceReference>
>;

let referencePromise: Promise<Reference> | undefined;
function reference(): Promise<Reference> {
	referencePromise ??= runCliMcpDeveloperExperienceReference();
	return referencePromise;
}

type CliMcpWorld = {
	result?: Reference;
};

// --- Scenario: Build, inspect, and deploy a Snapshop app -------------------------------

Given(
	"a generated HoBo project with the parity-checked CLI command surface",
	async function (this: CliMcpWorld) {
		this.result = await reference();
		assert.equal(
			this.result.commandSurface.parity.ok,
			true,
			"CLI/MCP parity holds",
		);
		assert.deepEqual(this.result.commandSurface.missingRequiredCommands, []);
	},
);

When(
	"the app developer runs the deterministic local-to-Camp loop",
	function (this: CliMcpWorld) {
		const app = this.result?.scenarios.appDeveloper;
		assert.ok(app, "app developer journey must have run");
		assert.equal(
			app.deterministicSnapshot.dev.replayDiff.status,
			"unchanged",
			"local dev loop is deterministic",
		);
	},
);

Then(
	"the mocked Camp deploy reaches deployed state with no cloud-specific code matches",
	function (this: CliMcpWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(
			result.scenarios.appDeveloper.deterministicSnapshot.up.status,
			"deployed",
		);
		assert.deepEqual(
			result.scenarios.appDeveloper.deterministicSnapshot
				.cloudSpecificCodeMatches,
			[],
		);
		assert.equal(
			result.workspace.mockedOnly,
			true,
			"simulation stays fully mocked",
		);
		assert.equal(result.workspace.liveExternalCalls, 0);
	},
);

// --- Scenario: Run MCP plan and deploy through an SVID-bound session --------------------

Given(
	"the MCP server advertises CLI-parity tools over an SVID-bound session",
	async function (this: CliMcpWorld) {
		this.result = await reference();
		assert.equal(
			this.result.commandSurface.parity.ok,
			true,
			"MCP tools mirror the CLI surface",
		);
	},
);

When(
	"an agent calls MCP plan with valid scope and MCP deploy without the required scope",
	function (this: CliMcpWorld) {
		assert.ok(this.result?.scenarios.mcp, "MCP scenario must have run");
	},
);

Then(
	"MCP plan succeeds while the unscoped deploy fails closed with a scope denial",
	function (this: CliMcpWorld) {
		const mcp = this.result?.scenarios.mcp;
		assert.ok(mcp);
		assert.equal(mcp.plan.ok, true, "scoped plan succeeds");
		assert.equal(mcp.deniedDeploy.ok, false, "unscoped deploy fails closed");
		assert.equal(mcp.deniedDeploy.error.code, "MCP_SCOPE_DENIED");
	},
);

Then(
	"static credential keys are rejected by the credential broker",
	function (this: CliMcpWorld) {
		const credentials = this.result?.scenarios.credentials;
		assert.ok(credentials);
		assert.equal(credentials.staticKey.status, "rejected");
		assert.equal(credentials.deniedAfterRevoke.status, "denied");
	},
);

// --- Scenario: Operator paths ------------------------------------------------------------

Given(
	"deterministic mocked identity, policy, runtime, gateway, and projection providers",
	async function (this: CliMcpWorld) {
		this.result = await reference();
		assert.equal(
			this.result.workspace.mockedOnly,
			true,
			"operator paths run against mocks only",
		);
	},
);

When(
	"GitOps, SecOps, SRE, and DevOps operators run their documented HoBo paths",
	function (this: CliMcpWorld) {
		const scenarios = this.result?.scenarios;
		assert.ok(
			scenarios?.gitops &&
				scenarios.secops &&
				scenarios.sre &&
				scenarios.canary,
			"all operator journeys ran",
		);
	},
);

Then(
	"the operator simulation preserves read-only previews, denied policy decisions, drift replay evidence, and rollback state",
	function (this: CliMcpWorld) {
		const scenarios = this.result?.scenarios;
		assert.ok(scenarios);
		assert.equal(
			scenarios.gitops.readOnlyPlan,
			true,
			"GitOps CI plan stays read-only",
		);
		assert.equal(
			scenarios.secops.decision.effect,
			"deny",
			"SecOps policy decision denies the unsafe action",
		);
		assert.equal(
			scenarios.secops.replay.effect,
			"deny",
			"policy denial replays from the audit stream",
		);
		assert.equal(
			scenarios.sre.replay.drift.detected,
			true,
			"SRE replay retains drift evidence",
		);
		assert.equal(
			scenarios.canary.status.state,
			"promoted",
			"healthy canary promotes",
		);
		assert.equal(
			scenarios.canaryRollback.status.state,
			"rolled-back",
			"regressing canary rolls back",
		);
	},
);
