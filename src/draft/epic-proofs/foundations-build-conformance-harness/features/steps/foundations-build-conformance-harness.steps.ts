/**
 * Executable step definitions for foundations-build-conformance-harness.feature.
 *
 * Drives the epic's real reference simulation
 * (services/foundations-reference-architecture.ts) and asserts the workspace,
 * componentize, trust-gate, and CI artifacts it actually produces.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runFoundationsBuildConformanceSimulation } from "../../services/foundations-reference-architecture.js";

type Simulation = Awaited<
	ReturnType<typeof runFoundationsBuildConformanceSimulation>
>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runFoundationsBuildConformanceSimulation();
	return simulationPromise;
}

type FoundationsWorld = {
	result?: Simulation;
};

// --- Scenario: Bootstrap a package skeleton with boundary lint ---------------------------

Given(
	"a design-phase HoBo workspace contract",
	async function (this: FoundationsWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.epic.slug,
			"foundations-build-conformance-harness",
		);
	},
);

When("the workspace skeleton is validated", function (this: FoundationsWorld) {
	assert.equal(
		this.result?.workspace.packageManager,
		"pnpm",
		"workspace pins pnpm",
	);
});

Then(
	"required packages validate and adapter boundary violations are denied",
	function (this: FoundationsWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.workspace.status, "valid");
		assert.equal(result.workspace.boundaryViolation.effect, "deny");
		assert.equal(result.negative.adapterImport.effect, "deny");
		assert.match(
			result.negative.adapterImport.reason,
			/adapters may import only core ports/,
		);
	},
);

// --- Scenario: Build a deterministic hello-bindle component ------------------------------

Given(
	"the hello-bindle source fixture",
	async function (this: FoundationsWorld) {
		this.result = await simulation();
		assert.ok(this.result.componentize, "componentize slice must have run");
	},
);

When("the fixture is componentized", function (this: FoundationsWorld) {
	assert.equal(
		this.result?.componentize.validation.passed,
		true,
		"wasm validation passes",
	);
});

Then(
	"wasm validation, the OCI descriptor, and smoke output are deterministic",
	function (this: FoundationsWorld) {
		const componentize = this.result?.componentize;
		assert.ok(componentize);
		assert.equal(componentize.smoke.exitCode, 0, "smoke run exits 0");
		assert.equal(
			componentize.oci.mediaType,
			"application/vnd.oci.image.manifest.v1+json",
		);
	},
);

// --- Scenario: Verify signed artifacts before Matching can see them ----------------------

Given(
	"a signed artifact and its conformance report",
	async function (this: FoundationsWorld) {
		this.result = await simulation();
		assert.ok(this.result.artifactTrust, "artifact trust slice must have run");
	},
);

When(
	"install verification runs in the trust gate",
	function (this: FoundationsWorld) {
		assert.equal(
			this.result?.artifactTrust.install.ok,
			true,
			"signed install verifies",
		);
	},
);

Then(
	"the artifact is available to Matching but not auto-selected and unsigned artifacts are refused",
	function (this: FoundationsWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.artifactTrust.install.availableToMatching, true);
		assert.equal(
			result.artifactTrust.install.selectedByMatching,
			false,
			"trust gate never auto-selects",
		);
		assert.deepEqual(result.negative.unsignedArtifact.reasons, [
			"signature.required",
		]);
	},
);

// --- Scenario: Run PR gates and hello-bindle E2E without stored secrets ------------------

Given("the mocked CI fabric contract", async function (this: FoundationsWorld) {
	this.result = await simulation();
	assert.equal(this.result.ci.contract.passed, true, "CI contract lane passes");
});

When("the CI and opt-in E2E lanes run", function (this: FoundationsWorld) {
	assert.equal(this.result?.ci.e2e.status, "passed");
});

Then(
	"OIDC-scoped short-lived tokens gate the run and missing OIDC fails the lane",
	function (this: FoundationsWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(
			result.ci.e2e.token.expiresInSeconds,
			900,
			"E2E token is short-lived",
		);
		assert.equal(
			result.negative.ciMissingOidc.passed,
			false,
			"missing OIDC fails closed",
		);
	},
);
