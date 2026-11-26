/**
 * Runnable example for governance-planes-s6-08. The draft-artifact gate EXECUTES this
 * with `node --import tsx` and diffs stdout against usage.expected.txt — keep both honest.
 *
 * Runs the same Stage-6 evidence suite the cucumber steps drive
 * (services/governance-planes-reference-architecture.ts): consent-gated notify,
 * residency + crypto-shred erasure, guardrail output blocking, and certified-only
 * registry install — then the four-item evidence rollup.
 */
import { strict as assert } from "node:assert";

import { runStage6GovernanceEvidenceSuite } from "../services/governance-planes-reference-architecture.ts";

const suite = runStage6GovernanceEvidenceSuite();

// 1) Consent-gated notify: granted consent allows the send and both events append.
const notify = suite.results.notify;
assert.equal(notify.ok, true);
assert.equal(notify.port, "hobo:notify");
const requested = notify.events.find(
	(event: { type: string }) => event.type === "notification.Requested",
);
const delivered = notify.events.find(
	(event: { type: string }) => event.type === "notification.Delivered",
);
assert.ok(requested && delivered);
assert.equal(requested.data.consentRef, "consent:alice-notify");
assert.equal(delivered.data.recipientId, "user:alice");
console.log(
	`notify ok=${notify.ok} port=${notify.port} consentRef=${requested.data.consentRef} recipient=${delivered.data.recipientId}`,
);

// 2) Residency: phi data pinned to us-east-1 denies an eu-central-1 deploy;
//    erasure crypto-shreds the subject key without rewriting history.
const residency = suite.results.residencyErasure;
assert.equal(residency.deployable, false);
assert.equal(residency.residencyEnforced, true);
assert.equal(residency.governance.decision.effect, "deny");
assert.ok(
	residency.governance.decision.violations.some((violation: string) =>
		violation.includes("outside allowed regions us-east-1"),
	),
);
assert.equal(residency.erasure.erasedSubject, "alice");
assert.ok(
	residency.erasure.projection.erasedSubjects.some((key: string) =>
		key.endsWith("/subject/alice"),
	),
);
assert.ok(residency.erasure.logEventCount > 0);
console.log(
	`residency deployable=${residency.deployable} effect=${residency.governance.decision.effect} erasedSubject=${residency.erasure.erasedSubject} logEvents=${residency.erasure.logEventCount}`,
);

// 3) Guardrail: flagged model output is blocked with a deny policy decision.
const guardrail = suite.results.guardrail;
assert.equal(guardrail.effect, "block");
assert.equal(guardrail.policyDecision.effect, "deny");
assert.ok(
	guardrail.policyDecision.violations.some((violation: string) =>
		violation.includes("ssn detected in output"),
	),
);
console.log(
	`guardrail effect=${guardrail.effect} policy=${guardrail.policyDecision.effect}`,
);

// 4) Registry: only the certified listing is discoverable and installable.
const install = suite.results.registryInstall;
assert.equal(install.discovery.ok, true);
assert.equal(install.installed, true);
assert.equal(install.listingId, "listing-certified");
assert.deepEqual(
	install.discovery.results.map(
		(entry: { listingId: string }) => entry.listingId,
	),
	["listing-certified"],
);
assert.ok(
	install.events.some(
		(event: { type: string }) => event.type === "registry.ListingInstalled",
	),
);
console.log(
	`registry installed=${install.installed} listing=${install.listingId} discovered=${install.discovery.results.length}`,
);

// 5) The Stage-6 evidence rollup reports all four items green.
assert.equal(suite.allGreen, true);
assert.deepEqual(suite.evidence, {
	"consent-gated-notify": true,
	"residency-obligation-crypto-shred": true,
	"blocked-flagged-model-output": true,
	"certified-only-registry-install": true,
});
console.log(
	`rollup allGreen=${suite.allGreen} items=${Object.keys(suite.evidence).length}`,
);

console.log(
	"EPIC HELD: all four Stage-6 governance evidence items are green over mocked boundaries",
);
