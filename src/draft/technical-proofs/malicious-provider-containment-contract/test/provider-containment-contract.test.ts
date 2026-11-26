import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTAINMENT_CONTRACT_VERSION,
  createEvilProviderFixture,
  evaluateProviderContainment
} from "../src/provider-containment-contract.js";

const defaultPolicy = Object.freeze({
  supportedCapabilities: ["database", "objectStore", "compute", "queue", "cache", "dns"],
  allowedEgressTargets: ["yard://conformance/database"],
  minimumVersions: {
    "oci://registry.example/hobo/provider/evil": "2.0.0"
  },
  revokedKeyIds: [],
  yankedVersions: []
});

test("provider claiming unsupported capability is refused before certification", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      manifest: { claimedCapabilities: ["database", "email"] },
      implementedCapabilities: ["database", "email"],
      sandboxRerun: { passed: true, exercisedCapabilities: ["database", "email"] }
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.contractVersion, CONTAINMENT_CONTRACT_VERSION);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.certification, "refused");
  assert.equal(verdict.reachesInfraOutsideScope, false);
  assert.deepEqual(gate(verdict, "provider.claim.unsupported_capability").reasons, [
    "unsupported capability: email"
  ]);
  assertEvent(verdict, "provider.CertificationRefused", "provider.claim.unsupported_capability");
});

test("sandbox executor denies egress beyond the scoped target and records the attempt", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      sandboxEgressAttempts: [
        { target: "https://attacker.example/exfiltrate", channel: "normal" }
      ]
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reachesInfraOutsideScope, false);
  assert.deepEqual(verdict.sandboxEffects, [
    {
      target: "https://attacker.example/exfiltrate",
      channel: "normal",
      outcome: "denied"
    }
  ]);
  assert.equal(gate(verdict, "sandbox.egress_scope").decision, "deny");
  assertEvent(verdict, "sandbox.EgressDenied", "sandbox.egress_scope");
});

test("unsigned and tampered provider packages are refused at install", () => {
  const unsigned = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      packageIntegrity: { signed: false, signatureValid: false, digestValid: true }
    }),
    policy: defaultPolicy
  });
  const tampered = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      packageIntegrity: { signed: true, signatureValid: true, digestValid: false }
    }),
    policy: defaultPolicy
  });

  assert.equal(unsigned.installable, false);
  assert.equal(gate(unsigned, "artifact.signature").decision, "deny");
  assert.match(unsigned.reasons.join("\n"), /artifact.signature_required/);
  assertEvent(unsigned, "artifact.InstallRejected", "artifact.signature");

  assert.equal(tampered.installable, false);
  assert.equal(gate(tampered, "artifact.digest").decision, "deny");
  assert.match(tampered.reasons.join("\n"), /artifact.digest_mismatch/);
  assertEvent(tampered, "artifact.InstallRejected", "artifact.digest");
});

test("forged conformance report is rejected by in-boundary rerun rather than attachment trust", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      conformanceAttachment: {
        suiteId: "@hobo/conformance/provider-capability/database",
        passed: true,
        digest: "sha256:forged"
      },
      sandboxRerun: {
        suiteId: "@hobo/conformance/provider-capability/database",
        passed: false,
        digest: "sha256:actual",
        exercisedCapabilities: ["database"]
      }
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.trustedAttachedConformanceReport, false);
  assert.equal(gate(verdict, "conformance.in_boundary_rerun").decision, "deny");
  assert.match(verdict.reasons.join("\n"), /conformance.report_mismatch/);
  assertEvent(verdict, "conformance.ReportRejected", "conformance.in_boundary_rerun");
});

test("claimed supported capabilities must be exercised by the in-boundary rerun", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      manifest: { claimedCapabilities: ["database", "objectStore"] },
      sandboxRerun: {
        suiteId: "@hobo/conformance/provider-capability/database",
        passed: true,
        digest: "sha256:report",
        exercisedCapabilities: ["database"]
      }
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.ok, false);
  assert.equal(gate(verdict, "conformance.claimed_capability_coverage").decision, "deny");
  assert.deepEqual(gate(verdict, "conformance.claimed_capability_coverage").reasons, [
    "claimed capability not rerun: objectStore"
  ]);
  assert.match(verdict.reasons.join("\n"), /conformance.coverage_missing: objectStore/);
  assertEvent(verdict, "conformance.ReportRejected", "conformance.claimed_capability_coverage");
});

test("older signed vulnerable provider versions are blocked by anti-rollback", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      coordinate: "oci://registry.example/hobo/provider/evil",
      version: "1.9.9"
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.selectable, false);
  assert.equal(gate(verdict, "artifact.anti_rollback").decision, "deny");
  assert.match(verdict.reasons.join("\n"), /artifact.anti_rollback/);
  assertEvent(verdict, "registry.RollbackRejected", "artifact.anti_rollback");
});

test("yanked provider version is blocked from new selection", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      coordinate: "oci://registry.example/hobo/provider/evil",
      version: "2.1.0"
    }),
    policy: {
      ...defaultPolicy,
      yankedVersions: ["oci://registry.example/hobo/provider/evil@2.1.0"]
    }
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.selectable, false);
  assert.equal(gate(verdict, "listing.yanked").decision, "deny");
  assert.match(verdict.reasons.join("\n"), /listing.yanked/);
  assertEvent(verdict, "listing.SelectionBlocked", "listing.yanked");
});

test("compromised signing key is denied by offline revocation, not accepted by signature alone", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      packageIntegrity: {
        signed: true,
        signatureValid: true,
        digestValid: true,
        keyId: "compromised-provider-key"
      }
    }),
    policy: {
      ...defaultPolicy,
      revokedKeyIds: ["compromised-provider-key"]
    }
  });

  assert.equal(verdict.ok, false);
  assert.equal(gate(verdict, "trust.offline_revocation").decision, "deny");
  assert.match(verdict.reasons.join("\n"), /trust.key_revoked/);
  assertEvent(verdict, "registry.KeyRevocationMatched", "trust.offline_revocation");
});

test("scoped covert-channel attempts are contained and reported as residual risk", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      sandboxEgressAttempts: [
        { target: "yard://conformance/database", channel: "covert" }
      ]
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.ok, true, verdict.reasons.join("\n"));
  assert.equal(verdict.reachesInfraOutsideScope, false);
  assert.deepEqual(verdict.sandboxEffects, [
    {
      target: "yard://conformance/database",
      channel: "covert",
      outcome: "allowed-with-audit"
    }
  ]);
  assert.ok(verdict.residualRisks.includes("covert-channel-within-scoped-target"));
  assertEvent(verdict, "sandbox.ScopedEgressObserved", "sandbox.egress_scope");
});

test("passing conformance states honest production-behavior limits instead of proving benignity", () => {
  const verdict = evaluateProviderContainment({
    provider: createEvilProviderFixture({
      productionBehavior: "malicious-after-conformance"
    }),
    policy: defaultPolicy
  });

  assert.equal(verdict.ok, true, verdict.reasons.join("\n"));
  assert.equal(verdict.assurance, "integrity-conformance-and-containment-gates-passed-not-benignity");
  assert.ok(verdict.residualRisks.includes("validly-signed-but-malicious"));
  assert.ok(verdict.residualRisks.includes("benign-during-conformance-malicious-in-production"));
  assertEvent(verdict, "provider.ResidualRiskRecorded", "provider.production_behavior_limit");
});

function gate(verdict, gateId) {
  const match = verdict.gates.find((candidate) => candidate.id === gateId);
  assert.ok(match, `missing gate ${gateId}`);
  return match;
}

function assertEvent(verdict, eventType, gateId) {
  assert.ok(
    verdict.auditEvents.some((event) => event.type === eventType && event.gateId === gateId),
    `missing event ${eventType} for ${gateId}`
  );
}
