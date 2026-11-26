/**
 * Executable step definitions for networking-connectivity-dns-relay.feature.
 *
 * Drives the epic's real simulation (services/networking-reference-architecture.ts),
 * which composes the promoted connectivity, DNS, ACME, gateway, relay, and
 * tenant-routing technical proofs over the committed fixture. Every assertion
 * reads outputs of that simulation; DNS adapters and providers are in-memory.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runNetworkingConnectivityDnsRelaySimulation } from "../../services/networking-reference-architecture.js";

type Simulation = Awaited<
	ReturnType<typeof runNetworkingConnectivityDnsRelaySimulation>
>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runNetworkingConnectivityDnsRelaySimulation();
	return simulationPromise;
}

// --- Scenario: Cross-provider bind stays private and policy-bounded --------

let crossCloudBind: Simulation["crossCloudBind"] | undefined;

Given(
	"an app API in an AWS Yard binding to a database in an Azure Yard",
	async () => {
		crossCloudBind = (await simulation()).crossCloudBind;
	},
);

When("HoBo folds the Yard manifests and plans Junction connectivity", () => {
	assert.ok(crossCloudBind, "cross-cloud bind slice must have run");
	assert.equal(
		crossCloudBind.topology.length,
		2,
		"both Yard manifests are projected",
	);
});

Then(
	"the connectivity plan selects the tier 3 private interconnect under an allow policy gate",
	() => {
		assert.equal(crossCloudBind?.outcome, "deployable");
		assert.equal(crossCloudBind?.tierPlan.tier, 3);
		assert.equal(crossCloudBind?.policyGate.effect, "allow");
	},
);

Then("mirrored per-Yard Junction halves validate with mTLS intact", () => {
	assert.equal(crossCloudBind?.mtls.ok, true);
	assert.equal(crossCloudBind?.junction.validation.ok, true);
	assert.deepEqual([...(crossCloudBind?.junction.deliveryYards ?? [])].sort(), [
		"yard-aws-us",
		"yard-azure-eu",
	]);
});

// --- Scenario: Custom-domain promotion is validation-first -----------------

let domainPromotion: Simulation["domainPromotion"] | undefined;

Given("a custom domain fronting multiple Camps behind shadow DNS", async () => {
	domainPromotion = (await simulation()).domainPromotion;
});

When(
	"HoBo stages DNS, validates evidence, issues certificates, and routes domain traffic",
	() => {
		assert.equal(domainPromotion?.validation.status, "validated");
		assert.equal(domainPromotion?.acme.status, "issued");
		assert.equal(domainPromotion?.gateway.status, "ready");
		assert.equal(domainPromotion?.routing.status, "routed");
	},
);

Then("only shadow DNS changes before the domain validation gate passes", () => {
	assert.equal(
		domainPromotion?.liveZoneWrites,
		0,
		"no live-zone writes happen pre-validation; staging stays in the shadow zone",
	);
	assert.equal(domainPromotion?.junctionDomain.status, "ready");
});

Then(
	"rebinding and split-horizon evidence block unsafe domain promotion",
	() => {
		assert.equal(domainPromotion?.negativeRebinding.status, "failed");
		assert.equal(domainPromotion?.negativeSplitHorizon.promotion, "blocked");
	},
);

// --- Scenario: Relay cannot become an SSRF pivot ---------------------------

let relay: Simulation["relay"] | undefined;

Given("a private target reachable only through the HoBo Relay", async () => {
	relay = (await simulation()).relay;
});

When("HoBo dispatches scoped work through the Relay session", () => {
	assert.equal(relay?.status, "attached");
	assert.equal(relay?.execution.status, "completed");
});

Then(
	"the Relay transport stays outbound-only and completes the scoped work",
	() => {
		assert.equal(relay?.network.outboundOnly, true);
		assert.equal(relay?.execution.ok, true);
	},
);

Then(
	"Relay metadata and forward-proxy attempts are denied with scoped reasons",
	() => {
		assert.ok(relay);
		const byCode = new Map(
			relay.deniedAttempts.map((attempt: { code: string }) => [
				attempt.code,
				attempt,
			]),
		);
		const metadataAttempt = byCode.get("relay.target.not-allowed");
		assert.equal(
			metadataAttempt?.ok,
			false,
			"metadata-service target must be refused",
		);
		assert.equal(metadataAttempt?.providerCode, "relay.target.unknown");
		const proxyAttempt = byCode.get("relay.forward-proxy.denied");
		assert.equal(proxyAttempt?.ok, false, "forward-proxy work must be refused");
		assert.equal(proxyAttempt?.providerCode, "relay.work.out-of-scope");
	},
);

Then(
	"Relay work frames carry credential references, never credential material",
	() => {
		assert.ok(relay);
		const frames = JSON.stringify(relay.execution.yardFrames);
		assert.ok(
			frames.includes('"exec.Succeeded"'),
			"scoped work really executed",
		);
		for (const forbidden of [
			"credentialMaterial",
			"providerToken",
			'"secret"',
			'"token"',
		]) {
			assert.equal(
				frames.includes(forbidden),
				false,
				`yard frames must not carry credential material field ${forbidden}`,
			);
		}
	},
);

// --- Scenario: Tenant context resolves before ingress handlers -------------

let tenantIngress: Simulation["tenantIngress"] | undefined;

Given(
	"subdomain, custom-domain, path, and JWT tenant routing signals",
	async () => {
		tenantIngress = (await simulation()).tenantIngress;
	},
);

When("tenant-aware ingress routes an incoming request", () => {
	assert.ok(tenantIngress, "tenant ingress slice must have run");
});

Then(
	"ctx.tenant is resolved from the routing table before the handler runs",
	() => {
		assert.equal(tenantIngress?.resolved.ok, true);
		assert.equal(tenantIngress?.resolved.ctx.tenant, "tenant-alpha");
		assert.equal(tenantIngress?.placement.kind, "region-pooled");
	},
);

Then("mismatched tenant claims fail the ingress closed", () => {
	assert.equal(tenantIngress?.mismatch.ok, false);
	assert.equal(tenantIngress?.mismatch.code, "tenant-routing.tenant-mismatch");
});
