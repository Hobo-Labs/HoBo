import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_RELEASE_DEPENDENCY_DOMAINS,
  V1_CRITICAL_PATH_DEPENDENCY_MAP,
  criticalPathByLaunchGate,
  validateCriticalPathDependencyMap,
} from "../src/v1-critical-path-dependency-map.ts";

test("critical path map covers every productization dependency domain", () => {
  const result = validateCriticalPathDependencyMap(V1_CRITICAL_PATH_DEPENDENCY_MAP);

  assert.deepEqual(result.errors, []);
  assert.equal(V1_CRITICAL_PATH_DEPENDENCY_MAP.issue, "HOBO-484");
  assert.deepEqual(
    V1_CRITICAL_PATH_DEPENDENCY_MAP.dependencies.map((dependency) => dependency.domain),
    REQUIRED_RELEASE_DEPENDENCY_DOMAINS,
  );
});

test("each dependency names blocker type, upstream project, downstream gate, and owner", () => {
  const result = validateCriticalPathDependencyMap(V1_CRITICAL_PATH_DEPENDENCY_MAP);

  assert.deepEqual(result.errors, []);
  assert.equal(
    V1_CRITICAL_PATH_DEPENDENCY_MAP.dependencies.every(
      (dependency) =>
        dependency.blockerType &&
        dependency.upstreamProject &&
        dependency.downstreamGate &&
        dependency.owner,
    ),
    true,
  );
});

test("critical path distinguishes private beta, release-candidate, and GA blockers", () => {
  const gates = criticalPathByLaunchGate(V1_CRITICAL_PATH_DEPENDENCY_MAP);

  assert.deepEqual(
    gates.privateBeta.map((dependency) => dependency.domain),
    ["product-ux", "tenant-model", "install", "support", "security"],
  );
  assert.deepEqual(
    gates.releaseCandidate.map((dependency) => dependency.domain),
    ["testing"],
  );
  assert.deepEqual(
    gates.ga.map((dependency) => dependency.domain),
    ["billing", "docs", "compliance", "operations"],
  );
});

test("out-of-scope dependencies are recorded as known limitations", () => {
  assert.deepEqual(
    V1_CRITICAL_PATH_DEPENDENCY_MAP.knownLimitations.map((limitation) => limitation.id),
    [
      "known-limitation.live-customer-production-proof",
      "known-limitation.final-legal-approval",
      "known-limitation.live-payment-provider-integration",
      "known-limitation.runtime-feature-implementation",
    ],
  );
  assert.equal(
    V1_CRITICAL_PATH_DEPENDENCY_MAP.knownLimitations.every(
      (limitation) => limitation.blockerType === "known-limitation" && limitation.customerDisposition,
    ),
    true,
  );

  const missingKnownLimitations = {
    ...V1_CRITICAL_PATH_DEPENDENCY_MAP,
    knownLimitations: [],
  };

  assert.match(
    validateCriticalPathDependencyMap(missingKnownLimitations).errors.join("\n"),
    /known limitations/,
  );
});
