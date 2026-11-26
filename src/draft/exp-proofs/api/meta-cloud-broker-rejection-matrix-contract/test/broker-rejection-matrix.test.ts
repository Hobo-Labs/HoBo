import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildBrokerRejectionMatrixFixtures,
  evaluateBrokerRejectionMatrix,
} from "../src/broker-rejection-matrix.ts";

test("each adversarial broker case emits the expected structured rejection only", () => {
  const matrix = evaluateBrokerRejectionMatrix({
    cases: buildBrokerRejectionMatrixFixtures(),
    yardFallbackResolver: () => {
      throw new Error("Yard-local planning must not run for broker rejection hardening");
    },
  });

  assert.deepEqual(
    matrix.rejections.map((entry) => [entry.caseId, entry.reason.code]),
    [
      ["stale-catalog", "catalog.stale"],
      ["incompatible-mapping", "mapping.incompatible"],
      ["ambiguous-mapping", "mapping.ambiguous"],
      ["missing-mapping", "mapping.missing"],
      ["unsupported-capability", "capability.unsupported"],
    ],
  );

  for (const rejection of matrix.rejections) {
    assert.equal(rejection.schema, "hobo.resolution-rejection/v1");
    assert.equal(rejection.resolutionAuthority, "meta-cloud-broker");
    assert.match(rejection.signature, /^signed:meta-cloud-broker:sha256:/);
    assert.match(rejection.digest, /^sha256:/);
    assert.equal(rejection.fallbackAttempted, false);
    assert.equal(rejection.yardPlanningAllowed, false);
    assert.equal(rejection.partialReceiptEmitted, false);
    assert.equal(rejection.reason.supportSafe, true);
    assert.ok(rejection.reason.remediationHint.length > 0);
    assert.ok(rejection.supportEvidence.evidenceId.length > 0);
    assert.deepEqual(Object.keys(rejection.replay.inputs).sort(), [
      "catalogSnapshotDigest",
      "environmentDigest",
      "manifestDigest",
    ]);
  }
});

test("ambiguous, stale, and default-fallback temptations fail closed", () => {
  let fallbackCalls = 0;
  const matrix = evaluateBrokerRejectionMatrix({
    cases: buildBrokerRejectionMatrixFixtures(),
    yardFallbackResolver: () => {
      fallbackCalls += 1;
      return "optimistic-yard-plan";
    },
  });

  const byId = Object.fromEntries(matrix.rejections.map((entry) => [entry.caseId, entry]));

  assert.equal(fallbackCalls, 0);
  assert.deepEqual(byId["ambiguous-mapping"].reason.blockedOptimism, [
    "best-effort-selection",
  ]);
  assert.deepEqual(byId["stale-catalog"].reason.blockedOptimism, [
    "stale-catalog-optimism",
  ]);
  assert.deepEqual(byId["missing-mapping"].reason.blockedOptimism, [
    "provider-default-fallback",
  ]);
});

test("support and debug output excludes secrets and raw customer payloads", () => {
  const matrix = evaluateBrokerRejectionMatrix({
    cases: buildBrokerRejectionMatrixFixtures({
      unsafeDebugMaterial: {
        token: "sk-live-secret-token",
        customerPayload: "customer database password",
      },
    }),
  });

  const serialized = JSON.stringify(matrix);

  assert.doesNotMatch(serialized, /sk-live/i);
  assert.doesNotMatch(serialized, /secret-token/i);
  assert.doesNotMatch(serialized, /customer database password/i);
  assert.doesNotMatch(serialized, /customerPayload/i);
});

test("rejection matrix output is deterministic across fixture order", () => {
  const forward = evaluateBrokerRejectionMatrix({
    cases: buildBrokerRejectionMatrixFixtures(),
  });
  const reverse = evaluateBrokerRejectionMatrix({
    cases: [...buildBrokerRejectionMatrixFixtures()].reverse(),
  });

  assert.deepEqual(reverse, forward);
});
