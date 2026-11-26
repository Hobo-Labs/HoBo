import { isJsonObject } from "./json.js";
import { createHash } from "node:crypto";

import { validateRemediationAction } from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";

const branchRestrictiveness = Object.freeze({
  escalate: 3,
  propose: 2,
  "auto-fix": 1,
});

export const failureTaxonomyEntries = Object.freeze([
  entry({
    failureClass: "transient",
    label: "Transient",
    actionKind: "retry",
    decisionBranch: "auto-fix",
    targetKind: "resource",
    strategy: "retry with capped backoff and circuit-break the dependency",
    predicate: (signal) =>
      signal.kind === "network-blip" ||
      (signal.kind === "provider-error" && (signal.retryable === true || [429, 503].includes(signal.status))),
  }),
  entry({
    failureClass: "provider-degraded-region",
    label: "Provider-degraded / region",
    actionKind: "failover",
    decisionBranch: "propose",
    targetKind: "region",
    strategy: "fail over Camp or region and widen the canary hold",
    predicate: (signal) =>
      signal.kind === "provider-region-health" ||
      signal.eventType === "provider.RegionDegraded" ||
      signal.providerDegraded === true,
  }),
  entry({
    failureClass: "capacity-exhausted",
    label: "Capacity-exhausted",
    actionKind: "scale",
    decisionBranch: "auto-fix",
    targetKind: "resource",
    strategy: "scale, shed load, or apply backpressure",
    predicate: (signal) =>
      signal.kind === "saturation" ||
      signal.eventType === "queue.DepthExceeded" ||
      signal.capacityExhausted === true,
  }),
  entry({
    failureClass: "durable-but-recoverable",
    label: "Durable-but-recoverable",
    actionKind: "retry",
    decisionBranch: "auto-fix",
    targetKind: "resource",
    strategy: "replay-resume the interrupted saga",
    predicate: (signal) =>
      signal.eventType === "run.Interrupted" ||
      signal.kind === "node-crash" ||
      signal.replayable === true,
  }),
  entry({
    failureClass: "partial-failure",
    label: "Partial failure",
    actionKind: "compensate",
    decisionBranch: "propose",
    targetKind: "resource",
    strategy: "compensate in reverse dependency order",
    predicate: (signal) =>
      signal.partialApply === true ||
      signal.kind === "saga-step-failed" ||
      signal.eventType === "exec.Failed",
  }),
  entry({
    failureClass: "poison-message",
    label: "Poison message",
    actionKind: "dead-letter",
    decisionBranch: "propose",
    targetKind: "resource",
    strategy: "dead-letter and quarantine before repair",
    predicate: (signal) =>
      signal.kind === "consumer-failure" ||
      signal.eventType === "message.Poisoned" ||
      signal.poison === true,
  }),
  entry({
    failureClass: "drift",
    label: "Drift",
    actionKind: "resync",
    decisionBranch: "propose",
    targetKind: "resource",
    strategy: "resync to desired Set or propose a diff",
    predicate: (signal) => signal.eventType === "resource.DriftDetected" || signal.kind === "drift",
  }),
  entry({
    failureClass: "split-brain-state-divergence",
    label: "Split-brain / state divergence",
    actionKind: "resync",
    decisionBranch: "escalate",
    targetKind: "camp",
    strategy: "fence stale owners and reconcile from the elected owner",
    predicate: (signal) =>
      signal.kind === "lease-conflict" ||
      signal.eventType === "actor.FenceConflict" ||
      signal.staleFenceToken === true,
  }),
  entry({
    failureClass: "contract-skew",
    label: "Contract skew",
    actionKind: "propose",
    decisionBranch: "propose",
    targetKind: "resource",
    strategy: "open a shim, deploy-order, or migration-window proposal",
    predicate: (signal) => signal.eventType === "compat.GateFailed" || signal.kind === "contract-skew",
  }),
  entry({
    failureClass: "semantic-drift",
    label: "Semantic drift",
    actionKind: "revert-champion",
    decisionBranch: "propose",
    targetKind: "resource",
    strategy: "revert to champion and keep the candidate in shadow",
    predicate: (signal) =>
      signal.eventType === "eval.GateFailed" ||
      signal.kind === "semantic-drift" ||
      signal.evalRegression === true,
  }),
  entry({
    failureClass: "security-anomaly",
    label: "Security anomaly",
    actionKind: "rotate-credential",
    decisionBranch: "escalate",
    targetKind: "resource",
    strategy: "rotate credentials, tighten allow, or bump dependency through approval",
    predicate: (signal) =>
      signal.eventType === "security.Finding" ||
      signal.kind === "security-anomaly" ||
      signal.securityFinding === true,
  }),
  entry({
    failureClass: "runaway-spend",
    label: "Runaway spend",
    actionKind: "halt-spend",
    decisionBranch: "escalate",
    targetKind: "camp",
    strategy: "halt spend-incurring actions until acknowledged",
    predicate: (signal) => signal.eventType === "spend.CircuitTripped" || signal.kind === "runaway-spend",
  }),
  entry({
    failureClass: "cost-induced-degradation",
    label: "Cost-induced degradation",
    actionKind: "degrade",
    decisionBranch: "propose",
    targetKind: "camp",
    strategy: "shed QoS by priority through costAvailabilityProfile tiers",
    predicate: (signal) =>
      signal.eventType === "spend.DegradationRequired" || signal.kind === "cost-induced-degradation",
  }),
]);

export function classifyFailureSignal(signal) {
  const normalized = normalizeSignal(signal);

  if (normalized.requiresHuman === true) {
    return classification({
      entry: requiresHumanEntry,
      signal: normalized,
      reason: "requires-human-short-circuit",
      matchedClasses: [],
    });
  }

  const matches = failureTaxonomyEntries.filter((candidate) => candidate.predicate(normalized));

  if (matches.length === 0) {
    return classification({
      entry: unclassifiableEntry,
      signal: normalized,
      reason: "unmatched-signal-fail-closed",
      matchedClasses: [],
    });
  }

  const selected = [...matches].sort(compareRestrictiveness)[0];

  return classification({
    entry: selected,
    signal: normalized,
    reason: selected.failureClass,
    matchedClasses: matches.map((match) => match.failureClass),
  });
}

const requiresHumanEntry = entry({
  failureClass: "requires-human",
  label: "Requires human",
  actionKind: "escalate",
  decisionBranch: "escalate",
  targetKind: "camp",
  strategy: "enter A2H handoff immediately",
  predicate: () => false,
});

const unclassifiableEntry = entry({
  failureClass: "unclassifiable",
  label: "Unclassifiable",
  actionKind: "escalate",
  decisionBranch: "escalate",
  targetKind: "camp",
  strategy: "escalate to on-call",
  predicate: () => false,
});

function entry(candidate) {
  return Object.freeze({
    specificity: 1,
    ...candidate,
  });
}

function classification({ entry, signal, reason, matchedClasses }) {
  const idempotencyKey = `failure-taxonomy:${entry.failureClass}:${hashSignal(signal)}`;
  const action = validateRemediationAction({
    kind: entry.actionKind,
    target: targetFor(entry, signal),
    blastRadius: blastRadiusFor(entry),
    environment: signal.environment ?? "staging",
    idempotencyKey,
    conformanceState: signal.conformanceState ?? "green",
  });

  return Object.freeze({
    failureClass: entry.failureClass,
    label: entry.label,
    strategy: entry.strategy,
    decisionBranch: entry.decisionBranch,
    action,
    idempotencyKey,
    reason,
    matchedClasses: Object.freeze(matchedClasses),
  });
}

function compareRestrictiveness(left, right) {
  const restrictiveness =
    branchRestrictiveness[right.decisionBranch] - branchRestrictiveness[left.decisionBranch];

  if (restrictiveness !== 0) {
    return restrictiveness;
  }

  if (right.specificity !== left.specificity) {
    return right.specificity - left.specificity;
  }

  return left.failureClass.localeCompare(right.failureClass);
}

function targetFor(entry, signal) {
  if (entry.targetKind === "region") {
    return Object.freeze({ kind: "region", id: signal.region ?? signal.targetId ?? "unknown-region" });
  }

  if (entry.targetKind === "camp") {
    return Object.freeze({ kind: "camp", id: signal.campId ?? signal.targetId ?? "current-camp" });
  }

  return Object.freeze({ kind: "resource", id: signal.resourceId ?? signal.targetId ?? "affected-resource" });
}

function blastRadiusFor(entry) {
  if (entry.decisionBranch === "escalate") {
    return Object.freeze({
      scope: entry.targetKind,
      reversible: false,
      estimatedImpact: "high",
    });
  }

  return Object.freeze({
    scope: entry.targetKind,
    reversible: true,
    compensationPath: `${entry.actionKind}:compensate`,
    estimatedImpact: entry.decisionBranch === "propose" ? "medium" : "low",
  });
}

function normalizeSignal(signal) {
  if (!signal || !isJsonObject(signal) || Array.isArray(signal)) {
    throw new TypeError("failure signal must be an object");
  }

  return Object.freeze({ ...signal });
}

function hashSignal(signal) {
  return createHash("sha256").update(stableJson(signal)).digest("hex").slice(0, 16);
}

function stableJson(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
