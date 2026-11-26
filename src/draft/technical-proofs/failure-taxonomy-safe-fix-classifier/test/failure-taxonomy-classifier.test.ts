import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  classifyFailureSignal,
  failureTaxonomyEntries,
} from "../src/failure-taxonomy-classifier.js";

const documentedCases = [
  {
    name: "transient provider 503",
    signal: { kind: "provider-error", status: 503, retryable: true },
    failureClass: "transient",
    actionKind: "retry",
    decisionBranch: "auto-fix",
  },
  {
    name: "provider degraded region",
    signal: { kind: "provider-region-health", errorRate: 0.42, region: "us-east-1" },
    failureClass: "provider-degraded-region",
    actionKind: "failover",
    decisionBranch: "propose",
  },
  {
    name: "capacity exhausted",
    signal: { kind: "saturation", utilization: 0.97, queueDepth: 2500 },
    failureClass: "capacity-exhausted",
    actionKind: "scale",
    decisionBranch: "auto-fix",
  },
  {
    name: "durable but recoverable interruption",
    signal: { eventType: "run.Interrupted", replayable: true },
    failureClass: "durable-but-recoverable",
    actionKind: "retry",
    decisionBranch: "auto-fix",
  },
  {
    name: "partial failure",
    signal: { kind: "saga-step-failed", partialApply: true },
    failureClass: "partial-failure",
    actionKind: "compensate",
    decisionBranch: "propose",
  },
  {
    name: "poison message",
    signal: { kind: "consumer-failure", repeatedFailures: 4, fatal: true },
    failureClass: "poison-message",
    actionKind: "dead-letter",
    decisionBranch: "propose",
  },
  {
    name: "drift",
    signal: { eventType: "resource.DriftDetected" },
    failureClass: "drift",
    actionKind: "resync",
    decisionBranch: "propose",
  },
  {
    name: "split brain",
    signal: { kind: "lease-conflict", staleFenceToken: true },
    failureClass: "split-brain-state-divergence",
    actionKind: "resync",
    decisionBranch: "escalate",
  },
  {
    name: "contract skew",
    signal: { eventType: "compat.GateFailed", reason: "producer-broke-consumer" },
    failureClass: "contract-skew",
    actionKind: "propose",
    decisionBranch: "propose",
  },
  {
    name: "semantic drift",
    signal: { eventType: "eval.GateFailed", regression: "champion-beats-candidate" },
    failureClass: "semantic-drift",
    actionKind: "revert-champion",
    decisionBranch: "propose",
  },
  {
    name: "security anomaly",
    signal: { eventType: "security.Finding", severity: "high" },
    failureClass: "security-anomaly",
    actionKind: "rotate-credential",
    decisionBranch: "escalate",
  },
  {
    name: "runaway spend",
    signal: { eventType: "spend.CircuitTripped" },
    failureClass: "runaway-spend",
    actionKind: "halt-spend",
    decisionBranch: "escalate",
  },
  {
    name: "cost induced degradation",
    signal: { eventType: "spend.DegradationRequired", tier: "reduced" },
    failureClass: "cost-induced-degradation",
    actionKind: "degrade",
    decisionBranch: "propose",
  },
];

describe("failure taxonomy safe-fix classifier", () => {
  it("maps every documented signal class to a canonical safe-fix RemediationAction", () => {
    assert.equal(failureTaxonomyEntries.length, documentedCases.length);

    for (const example of documentedCases) {
      const result = classifyFailureSignal(example.signal);

      assert.equal(result.failureClass, example.failureClass, example.name);
      assert.equal(result.action.kind, example.actionKind, example.name);
      assert.equal(result.decisionBranch, example.decisionBranch, example.name);
      assert.equal(result.action.idempotencyKey, result.idempotencyKey, example.name);
    }
  });

  it("returns escalate for an unmatched signal instead of a silent action", () => {
    const result = classifyFailureSignal({ kind: "unknown", message: "not in taxonomy" });

    assert.equal(result.failureClass, "unclassifiable");
    assert.equal(result.decisionBranch, "escalate");
    assert.equal(result.action.kind, "escalate");
    assert.equal(result.reason, "unmatched-signal-fail-closed");
  });

  it("resolves ambiguous matches to the most restrictive class, not the riskier auto-fix", () => {
    const result = classifyFailureSignal({
      kind: "provider-error",
      status: 503,
      eventType: "resource.DriftDetected",
      retryable: true,
    });

    assert.deepEqual(result.matchedClasses, ["transient", "drift"]);
    assert.equal(result.failureClass, "drift");
    assert.equal(result.decisionBranch, "propose");
    assert.equal(result.action.kind, "resync");
  });

  it("short-circuits requiresHuman signals to escalation regardless of class", () => {
    const result = classifyFailureSignal({
      kind: "saturation",
      utilization: 0.99,
      requiresHuman: true,
    });

    assert.equal(result.failureClass, "requires-human");
    assert.equal(result.decisionBranch, "escalate");
    assert.equal(result.action.kind, "escalate");
    assert.equal(result.reason, "requires-human-short-circuit");
  });
});
