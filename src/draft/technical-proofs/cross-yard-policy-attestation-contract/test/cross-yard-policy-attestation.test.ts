import assert from "node:assert/strict";
import { test } from "vitest";

import {
  attestPolicyEngineBuild,
  createFixtureAttestationTrust,
  doctorYardPolicyGuarantee,
  measurePolicyEngineBuild,
  reconcileYardPolicyAttestations,
  signDecisionLog
} from "../src/cross-yard-policy-attestation.js";

const NOW = "2026-06-27T12:00:00.000Z";
const FRESH_LOG_AT = "2026-06-27T11:58:00.000Z";
const STALE_LOG_AT = "2026-06-27T11:40:00.000Z";
const MAX_LOG_GAP_MS = 5 * 60 * 1000;

test("acceptance: Yard ships signed decision logs and matching policy-engine build attestation", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const yard = createYardEvidence({ trust, yardId: "yard:aws-prod", engine: expectedEngine });

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [yard],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });

  assert.deepEqual(result.signals, []);
  assert.equal(result.managementPlaneLog.length, 1);
  assert.equal(result.managementPlaneLog[0].type, "policy.Decided");
  assert.equal(result.managementPlaneLog[0].yardId, "yard:aws-prod");
  assert.equal(statusFor(result, "yard:aws-prod").guarantee, "inside-shared-trust-root");
});

test("acceptance: central reconciliation flags a Yard with a forked policy engine", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const forkedEngine = measurePolicyEngineBuild({
    name: "fail-open-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:forked-fail-open-binary",
    conformanceDigest: "sha256:policy-engine-conformance",
    behavior: "fail-open"
  });
  const yard = createYardEvidence({ trust, yardId: "yard:azure-prod", engine: forkedEngine });

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [yard],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });

  assert.equal(statusFor(result, "yard:azure-prod").guarantee, "outside-guarantee");
  assertSignal(result, "policy.AttestationMismatch", "yard:azure-prod");
});

test("adversarial: Yard that stops shipping decision logs raises an attestation gap", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const yard = createYardEvidence({
    trust,
    yardId: "yard:gcp-prod",
    engine: expectedEngine,
    observedAt: STALE_LOG_AT
  });

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [yard],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });

  assert.equal(statusFor(result, "yard:gcp-prod").guarantee, "outside-guarantee");
  assertSignal(result, "policy.AttestationGap", "yard:gcp-prod");
});

test("adversarial: Yard cannot borrow another Yard's valid build attestation", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const borrowed = createYardEvidence({ trust, yardId: "yard:aws-prod", engine: expectedEngine });
  const decisionLog = signDecisionLog({
    yardId: "yard:azure-prod",
    trustRootId: trust.sharedTrustRootId,
    engineDigest: expectedEngine.digest,
    decisions: [decision("policy:prod-apply", "allow")],
    signer: trust.decisionLogSigner,
    observedAt: FRESH_LOG_AT
  });

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [{ yardId: "yard:azure-prod", attestation: borrowed.attestation, decisionLogs: [decisionLog] }],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });

  assert.equal(statusFor(result, "yard:azure-prod").guarantee, "outside-guarantee");
  assertSignal(result, "policy.AttestationMismatch", "yard:azure-prod");
});

test("adversarial: fresh decision logs with skipped sequences raise an attestation gap", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const yard = createYardEvidence({ trust, yardId: "yard:azure-prod", engine: expectedEngine });
  yard.decisionLogs.push(
    signDecisionLog({
      yardId: "yard:azure-prod",
      trustRootId: trust.sharedTrustRootId,
      engineDigest: expectedEngine.digest,
      decisions: [decision("policy:prod-destroy", "deny")],
      signer: trust.decisionLogSigner,
      observedAt: FRESH_LOG_AT,
      sequence: 3
    })
  );

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [yard],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });

  assert.equal(statusFor(result, "yard:azure-prod").guarantee, "outside-guarantee");
  assertSignal(result, "policy.AttestationGap", "yard:azure-prod");
});

test("adversarial: attacker cannot forge matching attestation without the measured engine payload", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const forkedEngine = measurePolicyEngineBuild({
    name: "fail-open-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:forked-fail-open-binary",
    conformanceDigest: "sha256:policy-engine-conformance",
    behavior: "fail-open"
  });
  const forgedAttestation = attestPolicyEngineBuild({
    yardId: "yard:rogue-prod",
    measurement: forkedEngine,
    trustRootId: trust.sharedTrustRootId,
    signer: trust.engineAttestor,
    issuedAt: FRESH_LOG_AT
  });
  forgedAttestation.payload.engineDigest = expectedEngine.digest;
  const decisionLog = signDecisionLog({
    yardId: "yard:rogue-prod",
    trustRootId: trust.sharedTrustRootId,
    engineDigest: expectedEngine.digest,
    decisions: [decision("policy:prod-apply", "allow")],
    signer: trust.decisionLogSigner,
    observedAt: FRESH_LOG_AT
  });

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [{ yardId: "yard:rogue-prod", attestation: forgedAttestation, decisionLogs: [decisionLog] }],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });

  assert.equal(statusFor(result, "yard:rogue-prod").guarantee, "outside-guarantee");
  assertSignal(result, "policy.ForgedAttestation", "yard:rogue-prod");
});

test("acceptance: hobo doctor reports a Yard outside the shared trust root as outside guarantee", () => {
  const trust = createFixtureAttestationTrust();
  const expectedEngine = measurePolicyEngineBuild({
    name: "builtin-policy-engine",
    version: "1.2.0",
    binaryDigest: "sha256:release-binary",
    conformanceDigest: "sha256:policy-engine-conformance"
  });
  const outsideYard = createYardEvidence({
    trust,
    yardId: "yard:sovereign-prod",
    engine: expectedEngine,
    trustRootId: "trust-root:external-sovereign"
  });

  const result = reconcileYardPolicyAttestations({
    expectedEngineDigests: [expectedEngine.digest],
    trust,
    yards: [outsideYard],
    now: NOW,
    maxDecisionLogGapMs: MAX_LOG_GAP_MS
  });
  const doctor = doctorYardPolicyGuarantee(result, "yard:sovereign-prod");

  assert.equal(doctor.guarantee, "outside-guarantee");
  assert.match(doctor.summary, /outside shared trust root/);
  assertSignal(result, "policy.OutsideTrustRoot", "yard:sovereign-prod");
});

function createYardEvidence({
  trust,
  yardId,
  engine,
  trustRootId = trust.sharedTrustRootId,
  observedAt = FRESH_LOG_AT
}) {
  return {
    yardId,
    attestation: attestPolicyEngineBuild({
      yardId,
      measurement: engine,
      trustRootId,
      signer: trust.engineAttestor,
      issuedAt: observedAt
    }),
    decisionLogs: [
      signDecisionLog({
        yardId,
        trustRootId,
        engineDigest: engine.digest,
        decisions: [decision("policy:prod-apply", "allow")],
        signer: trust.decisionLogSigner,
        observedAt
      })
    ]
  };
}

function decision(policyId, effect) {
  return {
    decisionId: `${policyId}:${effect}`,
    policyId,
    effect,
    resource: "hobo:deployment:checkout-prod",
    subject: "user:deployer"
  };
}

function statusFor(result, yardId) {
  return result.yardStatuses.find((status) => status.yardId === yardId);
}

function assertSignal(result, type, yardId) {
  assert.ok(
    result.signals.some((signal) => signal.type === type && signal.yardId === yardId),
    `expected ${type} for ${yardId}; got ${JSON.stringify(result.signals)}`
  );
}
