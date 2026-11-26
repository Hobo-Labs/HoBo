/**
 * Executable step definitions for providers-iac-build-adapters.feature.
 *
 * Drives the epic's real reference simulation
 * (services/providers-reference-architecture.ts) over the committed
 * providers-reference-scenarios fixture and asserts the catalog, realize
 * pipeline, containment, and multi-cloud evidence it produces. All provider,
 * IaC, and build boundaries stay mocked.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
	loadProvidersScenarioFixture,
	runProvidersReferenceSimulation,
} from "../../services/providers-reference-architecture.js";

type Simulation = Awaited<ReturnType<typeof runProvidersReferenceSimulation>>;
type Fixture = Awaited<ReturnType<typeof loadProvidersScenarioFixture>>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runProvidersReferenceSimulation();
	return simulationPromise;
}

let fixturePromise: Promise<Fixture> | undefined;
function fixture(): Promise<Fixture> {
	fixturePromise ??= loadProvidersScenarioFixture();
	return fixturePromise;
}

// --- Scenario: Register provider-owned defaults ----------------------------

let catalogSim: Simulation | undefined;

Given(
	"the eight cloud provider adapter manifests in the providers fixture",
	async () => {
		const fx = await fixture();
		assert.equal(fx.providers.length, 8);
		catalogSim = await simulation();
	},
);

When(
	"the Yard registers the provider adapters into the capability catalog",
	async () => {
		const fx = await fixture();
		assert.equal(
			catalogSim?.providerCatalog.providers.length,
			fx.providers.length,
		);
		assert.deepEqual(
			catalogSim?.providerCatalog.registeredEvents,
			fx.providers.map(
				(provider: { id: string }) => `provider.Registered:${provider.id}`,
			),
		);
	},
);

Then(
	"every registered provider adapter carries passing conformance evidence",
	() => {
		assert.equal(catalogSim?.conformance.claimedPortsCovered, true);
		assert.ok(
			catalogSim?.conformance.reports.every(
				(report: { status: string }) => report.status === "passed",
			),
		);
		assert.ok(
			catalogSim?.providerCatalog.defaults.every(
				(definition: { source: string }) =>
					definition.source === "provider-owned",
			),
			"default definitions stay provider-owned",
		);
	},
);

Then("provider adapter Matching rejects the unsupported require clause", () => {
	const unsatisfied = catalogSim?.equivalenceResolver.unsatisfiedRequire;
	assert.equal(unsatisfied?.request, "database.postgres.managed.ha.vector");
	assert.equal(unsatisfied?.rejectedProvider, "hetzner");
	assert.equal(
		unsatisfied?.reason,
		"required capability vector is unavailable",
	);
});

// --- Scenario: Realize a Bindle resource without live providers ------------

let realizeSim: Simulation | undefined;

Given(
	"a resolved ResourcePlan with mocked IaC, build, and driver adapter boundaries",
	async () => {
		realizeSim = await simulation();
	},
);

When("the provider adapter emits IacProgram and BuildSpec fixtures", () => {
	assert.equal(realizeSim?.realize.iacProgram.kind, "hobo.iac-program/v1");
	assert.equal(realizeSim?.realize.buildSpec.kind, "hobo.build-spec/v1");
});

Then(
	"the adapter pipeline previews, applies, refreshes, and returns outputs as bindings",
	() => {
		assert.deepEqual(realizeSim?.realize.pipeline, [
			"realize",
			"build",
			"preview",
			"apply",
			"refresh",
		]);
		assert.equal(realizeSim?.realize.outputsToBindings, true);
	},
);

Then("the adapter realization records zero live provider calls", () => {
	assert.deepEqual(realizeSim?.realize.liveProviderCalls, []);
	assert.deepEqual(realizeSim?.liveNetworkCalls, []);
});

// --- Scenario: Reject malicious and drifting provider behavior -------------

let safetySim: Simulation | undefined;

Given(
	"a forged conformance report, undeclared egress, partial apply, and drift signal",
	async () => {
		safetySim = await simulation();
		assert.deepEqual(safetySim.conformance.maliciousClaimsRejected, [
			"forged-report",
			"undeclared-egress",
			"unsupported-port",
		]);
	},
);

When(
	"the provider adapter conformance, sandbox, and refresh gates evaluate the evidence",
	() => {
		assert.equal(safetySim?.maliciousProvider.policyDecision, "deny");
	},
);

Then(
	"the malicious provider adapter is denied and contained without egress",
	() => {
		assert.equal(safetySim?.maliciousProvider.contained, true);
		assert.equal(safetySim?.maliciousProvider.forgedReportAccepted, false);
		assert.equal(safetySim?.maliciousProvider.egressAllowed, false);
		assert.equal(safetySim?.maliciousProvider.sandbox, "no-egress-firecracker");
	},
);

Then(
	"provider adapter drift is recorded and rollback requires an orphan sweep",
	() => {
		assert.equal(safetySim?.drift.detected, true);
		assert.ok(safetySim?.drift.actions.includes("orphan-sweep"));
		assert.equal(safetySim?.drift.falseDriftRejected, true);
		assert.equal(
			safetySim?.partialApply.compensation.status,
			"safe_rollback_requires_orphan_sweep",
		);
	},
);

// --- Scenario: Run the same shop Bindle on AWS and Azure -------------------

let multiCloudSim: Simulation | undefined;

Given(
	"one unchanged shop Bindle source with provider-specific adapter mappings",
	async () => {
		multiCloudSim = await simulation();
		assert.equal(
			multiCloudSim.multiCloudShop.bindleSourceDigest,
			"sha256:shop-bindle-unchanged",
		);
	},
);

When(
	"the multi-cloud provider adapter gate compares topology, bindings, and portability",
	() => {
		assert.deepEqual(multiCloudSim?.multiCloudShop.targets, ["aws", "azure"]);
		assert.deepEqual(multiCloudSim?.multiCloudShop.campChecksRun, [
			"aws-prod",
			"azure-prod",
		]);
	},
);

Then(
	"the shop Bindle keeps identical topology and bindings across aws and azure",
	() => {
		assert.equal(multiCloudSim?.multiCloudShop.sameTopology, true);
		assert.equal(multiCloudSim?.multiCloudShop.sameBindings, true);
	},
);

Then(
	"provider adapter option leaks and unsatisfied requires fail the portability gate",
	() => {
		assert.equal(multiCloudSim?.multiCloudShop.providerOptionsLeaked, false);
		assert.equal(
			multiCloudSim?.multiCloudShop.unsatisfiedRequireRejected,
			true,
		);
		assert.ok(
			(multiCloudSim?.portabilityReport.lockInEntries.length ?? 0) > 0,
			"portability report itemizes lock-in entries",
		);
		assert.equal(multiCloudSim?.portabilityReport.canDeploy, false);
	},
);
