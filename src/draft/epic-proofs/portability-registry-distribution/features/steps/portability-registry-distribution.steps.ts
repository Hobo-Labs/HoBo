/**
 * Executable step definitions for portability-registry-distribution.feature.
 *
 * Drives the epic's real reference simulation
 * (services/portability-registry-reference.ts) and asserts install
 * verification, digest pinning, yank response, and air-gap import outcomes it
 * produces. Mirrors, trust verifiers, and importers stay in-memory fixtures.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runPortabilityRegistrySimulation } from "../../services/portability-registry-reference.js";

type Simulation = Awaited<ReturnType<typeof runPortabilityRegistrySimulation>>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runPortabilityRegistrySimulation();
	return simulationPromise;
}

// --- Scenario: Install a certified provider listing ------------------------

let installSim: Simulation | undefined;

Given(
	"a certified provider Resource Pack listing in a curated registry catalog",
	async () => {
		installSim = await simulation();
		assert.equal(installSim.epic.slug, "portability-registry-distribution");
	},
);

When(
	"the platform engineer installs it through the registry reference flow",
	() => {
		assert.equal(installSim?.install.ok, true);
	},
);

Then(
	"the registry artifact passes signature, catalog, and trust verification",
	() => {
		assert.equal(installSim?.catalog.decision.effect, "allow");
		assert.equal(installSim?.trust.decision.effect, "allow");
	},
);

Then(
	"the installed listing is available to Matching without automatic selection",
	() => {
		assert.equal(installSim?.install.availableToMatching, true);
		assert.equal(installSim?.install.selectedByMatching, false);
	},
);

// --- Scenario: Discover, resolve, and fetch only digest-identical artifacts

let resolutionSim: Simulation | undefined;

Given(
	"a capability-indexed registry with registered artifact mirrors",
	async () => {
		resolutionSim = await simulation();
		assert.equal(resolutionSim.discovery.ok, true);
		assert.equal(
			resolutionSim.discovery.results[0].listingId,
			"listing-aws-resource-pack",
		);
	},
);

When("the planning agent resolves a floating registry version range", () => {
	assert.equal(resolutionSim?.resolution.ok, true);
});

Then(
	"the registry resolver freezes a digest pin for the discovered listing",
	() => {
		const pin = resolutionSim?.resolution.pins[0];
		assert.ok(pin, "resolution must produce a pin");
		assert.match(
			pin.digest,
			/^sha256:[a-f0-9]{64}$/,
			"pin is a frozen content digest",
		);
	},
);

Then(
	"registry mirror cost selection runs only after digest identity verification",
	() => {
		assert.equal(resolutionSim?.mirrorSelection.ok, true);
		assert.deepEqual(resolutionSim?.mirrorSelection.costEligibleMirrorIds, [
			"mirror-cheap",
			"mirror-fast",
		]);
		// Dependency-confusion attempt fails closed before any mirror cost ranking.
		assert.equal(resolutionSim?.dependencyConfusion.ok, false);
		assert.equal(
			resolutionSim?.dependencyConfusion.reason,
			"artifact.pinned_coordinate_absent",
		);
	},
);

// --- Scenario: Yank a compromised listing ----------------------------------

let yankSim: Simulation | undefined;

Given(
	"a certified registry listing pinned by a running Deployment Set",
	async () => {
		yankSim = await simulation();
	},
);

When("SecOps yanks the registry listing as critical", () => {
	assert.equal(yankSim?.yank.ok, true);
});

Then("new deploy selection of the yanked registry listing is blocked", () => {
	assert.equal(yankSim?.yankedCanDeploy.ok, false);
	assert.equal(yankSim?.yankedCanDeploy.reason, "listing.yanked");
});

Then(
	"the running Set is flagged with a registry remediation obligation instead of a rewrite",
	() => {
		assert.equal(yankSim?.yankDoctor.ok, false);
		assert.equal(
			yankSim?.yankDoctor.findings[0].type,
			"listing.yanked.pinned-set",
		);
		assert.equal(yankSim?.yankObligations[0].type, "policy.ObligationCreated");
	},
);

// --- Scenario: Import a signed offline bundle ------------------------------

let offlineSim: Simulation | undefined;

Given(
	"a signed offline registry bundle with revocation and anti-rollback material",
	async () => {
		offlineSim = await simulation();
	},
);

When(
	"the sovereign operator imports the bundle into an in-boundary mirror",
	() => {
		assert.equal(offlineSim?.offlineImport.ok, true);
	},
);

Then(
	"accepted artifacts are recorded in a registry.BundleImported event without egress",
	() => {
		assert.equal(offlineSim?.offlineImport.egressAttempts, 0);
		assert.equal(
			offlineSim?.offlineImport.event.type,
			"registry.BundleImported",
		);
		assert.equal(
			offlineSim?.offlineImport.event.verification.revocation,
			"passed",
		);
	},
);

Then("revoked or rolled-back registry artifacts fail the import closed", () => {
	assert.equal(offlineSim?.offlineRefusal.ok, false);
	assert.ok(
		offlineSim?.offlineRefusal.reasons.every((reason: string) =>
			/revocation|antiRollback|transparency/.test(reason),
		),
		"every refusal names its revocation, anti-rollback, or transparency cause",
	);
});
