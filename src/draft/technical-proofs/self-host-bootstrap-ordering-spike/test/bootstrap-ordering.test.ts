import assert from "node:assert/strict";
import { test } from "vitest";
import {
  REQUIRED_FAILURE_SCENARIOS,
  classifyBootstrapAttempt,
  createBootstrapPlan,
  failureRecoveryTable,
  handoverStatus,
  validateBootstrapPlan,
} from "../src/bootstrap-ordering.js";

test("connected bootstrap orders seed, self-deploy, identity handover, and retirement", () => {
  const plan = createBootstrapPlan({
    attemptId: "attempt-001",
    targetYard: "yard-prod",
    targetCamp: "prod-aws",
    operatorSubject: "spiffe://operator/alice",
  });

  assert.deepEqual(validateBootstrapPlan(plan), []);
  assert.equal(plan.credential.auditedAs, "identity.SeedTokenUsed");
  assert.equal(plan.credential.singleUse, true);
  assert.equal(plan.credential.refreshable, false);
  assert.equal(plan.egressAllowed, false);

  const order = plan.steps.map((entry) => entry.type);
  assert.deepEqual(order, [
    "seed.started",
    "artifact.bundle-verified",
    "identity.SeedTokenUsed",
    "delta.Opened",
    "resource.Provisioning",
    "resource.Provisioned",
    "seedLog.Imported",
    "identity.Issued",
    "token.Revoked",
    "seed.Discarded",
  ]);
});

test("seed log import is immutable provenance, not live command replay", () => {
  const plan = createBootstrapPlan({
    attemptId: "attempt-002",
    targetYard: "yard-prod",
    targetCamp: "prod-aws",
    operatorSubject: "spiffe://operator/alice",
  });

  const importStep = plan.steps.find((entry) => entry.type === "seedLog.Imported");

  assert.match(importStep.data.seedLogHash, /^[a-f0-9]{64}$/);
  assert.equal(importStep.data.replayMode, "read-only-provenance");
  assert.equal(importStep.data.liveCommandReplay, false);
});

test("handover blocks until real Identity has issued a brokered token", () => {
  assert.deepEqual(handoverStatus(["resource.Provisioned", "seedLog.Imported"]), {
    ready: false,
    missing: ["identity.Issued"],
    trigger: null,
  });

  assert.deepEqual(handoverStatus(["resource.Provisioned", "seedLog.Imported", "identity.Issued"]), {
    ready: true,
    missing: [],
    trigger: "real-identity-token-broker-ready",
  });
});

test("air-gapped bootstrap requires in-boundary signed inputs and no egress", () => {
  assert.throws(
    () =>
      createBootstrapPlan({
        attemptId: "attempt-airgap",
        targetYard: "yard-sovereign",
        targetCamp: "prod-sovereign",
        operatorSubject: "spiffe://operator/alice",
        mode: "airgap",
      }),
    /offlineBundle\.digest is required/,
  );

  const plan = createBootstrapPlan({
    attemptId: "attempt-airgap",
    targetYard: "yard-sovereign",
    targetCamp: "prod-sovereign",
    operatorSubject: "spiffe://operator/alice",
    mode: "airgap",
    offlineBundle: { digest: "sha256:offline-bundle" },
    inBoundaryTrustRoot: "trust-root-001",
  });

  assert.equal(plan.egressAllowed, false);
  assert.equal(plan.offlineInputs.hostedServicesAllowed, false);
  assert.equal(plan.offlineInputs.bundleDigest, "sha256:offline-bundle");
  assert.equal(plan.offlineInputs.trustRoot, "trust-root-001");
});

test("double bootstrap resumes only the same attempt id and blocks a different lineage", () => {
  assert.deepEqual(classifyBootstrapAttempt(null, "attempt-1"), {
    action: "start",
    reason: "no-existing-bootstrap-attempt",
  });

  assert.deepEqual(classifyBootstrapAttempt("attempt-1", "attempt-1"), {
    action: "resume",
    reason: "same-bootstrap-attempt-id",
  });

  assert.deepEqual(classifyBootstrapAttempt("attempt-1", "attempt-2"), {
    action: "block",
    reason: "target-yard-already-has-a-different-bootstrap-attempt",
  });
});

test("failure recovery table covers every adversarial scenario", () => {
  const rows = failureRecoveryTable();
  const ids = rows.map((row) => row.id);

  assert.deepEqual(ids.sort(), [...REQUIRED_FAILURE_SCENARIOS].sort());

  for (const row of rows) {
    assert.ok(row.recovery.length > 20, `${row.id} must name a recovery path`);
    assert.ok(row.invariant.length > 20, `${row.id} must name the invariant preserved`);
  }
});
