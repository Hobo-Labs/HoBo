/**
 * Executable step definitions for governance-planes-s6-08.feature.
 *
 * Drives the epic's real reference architecture
 * (services/governance-planes-reference-architecture.ts) — the Stage-6
 * evidence suite over its committed fixture — and asserts each scenario
 * against the events, policy decisions, and projections it produces.
 * Boundaries stay mocked from the promoted technical-proof modules.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runStage6GovernanceEvidenceSuite } from "../../services/governance-planes-reference-architecture.js";

type Suite = ReturnType<typeof runStage6GovernanceEvidenceSuite>;

let suiteCache: Suite | undefined;
function suite(): Suite {
	suiteCache ??= runStage6GovernanceEvidenceSuite();
	return suiteCache;
}

// --- Scenario: Consent-gated notify send through hobo:notify ---------------

let notifyResult: Suite["results"]["notify"] | undefined;

Given(
	"a Stage-6 notify recipient with granted product-notification consent",
	() => {
		notifyResult = suite().results.notify;
	},
);

When("the yard dispatches a Stage-6 notify send through hobo:notify", () => {
	assert.ok(notifyResult, "notify slice must have run");
	assert.equal(notifyResult.ok, true, "granted consent must allow the send");
	assert.equal(notifyResult.port, "hobo:notify");
});

Then(
	"Stage-6 notification.Requested is appended with the consent reference",
	() => {
		const requested = notifyResult?.events.find(
			(event: { type: string }) => event.type === "notification.Requested",
		);
		assert.ok(requested, "notification.Requested must be appended");
		assert.equal(requested.data.consentRef, "consent:alice-notify");
	},
);

Then("Stage-6 notification.Delivered records the notify outcome", () => {
	const delivered = notifyResult?.events.find(
		(event: { type: string }) => event.type === "notification.Delivered",
	);
	assert.ok(delivered, "notification.Delivered must be appended");
	assert.equal(delivered.data.recipientId, "user:alice");
});

// --- Scenario: Residency obligation with crypto-shred erasure --------------

let residencyResult: Suite["results"]["residencyErasure"] | undefined;

Given("Stage-6 phi-classified data constrained to us-east-1", () => {
	residencyResult = suite().results.residencyErasure;
});

When("a Stage-6 deploy plan targets eu-central-1", () => {
	assert.ok(residencyResult, "residency slice must have run");
});

Then("Stage-6 can-deploy denies with a residency violation", () => {
	assert.equal(residencyResult?.deployable, false);
	assert.equal(residencyResult?.residencyEnforced, true);
	assert.equal(residencyResult?.governance.decision.effect, "deny");
	assert.ok(
		residencyResult?.governance.decision.violations.some((violation: string) =>
			violation.includes("outside allowed regions us-east-1"),
		),
		"denial names the residency violation",
	);
});

Then(
	"Stage-6 hobo erase crypto-shreds the subject key without rewriting history",
	() => {
		const erasure = residencyResult?.erasure;
		assert.ok(erasure, "erasure evidence must exist");
		assert.equal(erasure.erasedSubject, "alice");
		assert.ok(
			erasure.projection.erasedSubjects.some((key: string) =>
				key.endsWith("/subject/alice"),
			),
			"rebuilt projection lists the shredded subject",
		);
		// The log kept every original event; erasure destroyed keys, not history.
		assert.ok(erasure.logEventCount > 0, "append-only log retains its events");
	},
);

// --- Scenario: Guardrail blocks flagged model output -----------------------

let guardrailResult: Suite["results"]["guardrail"] | undefined;

Given("a Stage-6 agent output that fails the PII guardrail rail", () => {
	guardrailResult = suite().results.guardrail;
});

When(
	"the enforced Stage-6 guardrail step evaluates the buffered window",
	() => {
		assert.ok(guardrailResult, "guardrail slice must have run");
	},
);

Then(
	"the Stage-6 guardrail decision blocks the output with a deny policy decision",
	() => {
		assert.equal(guardrailResult?.effect, "block");
		assert.equal(guardrailResult?.policyDecision.effect, "deny");
		assert.ok(
			guardrailResult?.policyDecision.violations.some((violation: string) =>
				violation.includes("ssn detected in output"),
			),
			"block cites the failed PII rail finding",
		);
	},
);

// --- Scenario: Certified-only Registry install via Matching ----------------

let installResult: Suite["results"]["registryInstall"] | undefined;

Given("a Stage-6 certified listing and a failed-certification listing", () => {
	installResult = suite().results.registryInstall;
});

When("Stage-6 Matching discovers providers for a WIT port", () => {
	assert.ok(installResult, "registry-install slice must have run");
	assert.equal(installResult.discovery.ok, true);
});

Then("only the Stage-6 certified listing can install", () => {
	assert.equal(installResult?.installed, true);
	assert.equal(installResult?.listingId, "listing-certified");
	const discovered = installResult?.discovery.results.map(
		(result: { listingId: string }) => result.listingId,
	);
	assert.deepEqual(
		discovered,
		["listing-certified"],
		"uncertified listing stays unlisted",
	);
	assert.ok(
		installResult?.events.some(
			(event: { type: string }) => event.type === "registry.ListingInstalled",
		),
		"install is recorded as an event",
	);
});

Then("the Stage-6 evidence rollup reports all four items green", () => {
	const rollup = suite();
	assert.equal(rollup.allGreen, true);
	assert.deepEqual(rollup.evidence, {
		"consent-gated-notify": true,
		"residency-obligation-crypto-shred": true,
		"blocked-flagged-model-output": true,
		"certified-only-registry-install": true,
	});
});
