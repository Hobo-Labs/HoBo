import { isJsonString, isJsonObject } from "./json.js";
export const CLASSIFICATION_EVENT_TYPE = "failure.Classified";

export const failureClasses = Object.freeze({
  transient: "transient",
  durableRecoverable: "durable-recoverable",
  partialFailure: "partial-failure",
  poison: "poison",
  drift: "drift",
  splitBrain: "split-brain",
});

export const failureStrategies = Object.freeze({
  transient: Object.freeze({
    kind: "backoff-budget",
    retry: "capped-exponential-backoff-with-jitter",
    terminalAfter: "retry-budget",
  }),
  "durable-recoverable": Object.freeze({
    kind: "replay-resume",
    resumeFrom: "event-log",
  }),
  "partial-failure": Object.freeze({
    kind: "saga-compensation",
    order: "reverse-topological",
    idempotencyRule: "forward-key-or-refresh-before-act",
  }),
  poison: Object.freeze({
    kind: "mark-failed-fatal",
    retry: "never",
    surface: "human-or-agent",
  }),
  drift: Object.freeze({
    kind: "resync",
    policies: Object.freeze(["heal", "propose", "ignore"]),
  }),
  "split-brain": Object.freeze({
    kind: "leases-and-fencing",
    guard: "quorum-fenced-append",
  }),
});

const SPLIT_BRAIN_CODES = new Set([
  "DUAL_LEADER",
  "SPLIT_BRAIN",
  "STALE_FENCE_REJECTED",
  "STALE_LEADER_APPEND",
]);

const POISON_CODES = new Set([
  "FATAL_PROVIDER_ERROR",
  "MALFORMED_PLAN",
  "POISON",
  "SCHEMA_VALIDATION_FAILED",
  "VALIDATION_FAILED",
]);

const PARTIAL_CODES = new Set([
  "AMBIGUOUS_COMMIT",
  "AMBIGUOUS_RETURN",
  "PARTIAL_APPLY",
  "PARTIAL_FAILURE",
]);

const DRIFT_CODES = new Set(["DRIFT_DETECTED", "OUT_OF_BAND_CHANGE"]);
const DURABLE_CODES = new Set(["NODE_CRASH", "YARD_NODE_CRASH"]);
const TRANSIENT_CODES = new Set(["NETWORK_BLIP", "PROVIDER_429", "PROVIDER_503", "TIMEOUT"]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function classifyFailure(error, context = {}) {
  const normalized = normalizeError(error);
  const matchedTransient = isTransient(normalized);

  if (matchedTransient && isRetryBudgetExhausted(context)) {
    return classification("poison", "transient-retry-budget-exhausted");
  }

  if (isSplitBrain(normalized)) {
    return classification("split-brain", "matched-split-brain");
  }

  if (isPoison(normalized)) {
    return classification(
      "poison",
      matchedTransient ? "matched-poison-before-transient" : "matched-poison",
    );
  }

  if (isPartial(normalized)) {
    return classification("partial-failure", "matched-partial-or-ambiguous", {
      requiresIdempotencyDecision: Boolean(normalized.ambiguousCommit),
    });
  }

  if (isDrift(normalized)) {
    return classification("drift", "matched-drift");
  }

  if (isDurableRecoverable(normalized)) {
    return classification("durable-recoverable", "matched-durable-recoverable");
  }

  if (matchedTransient) {
    return classification("transient", "matched-transient");
  }

  return classification("poison", "unknown-error-fail-closed");
}

export function crossesNoGoThreshold(classifications, descriptor) {
  const classes = classifications.map((entry) => (isJsonString(entry) ? entry : entry.class));

  if (descriptor.kind === "any-fatal") {
    return classes.some((failureClass) => failureClass === "poison" || failureClass === "split-brain");
  }

  if (descriptor.kind === "transient-exhaustions") {
    const transientCount = classes.filter((failureClass) => failureClass === "transient").length;
    return transientCount >= descriptor.count;
  }

  throw new Error(`Unknown no-go threshold kind: ${descriptor.kind}`);
}

export function makeClassificationEvent({ id, correlationId, sourceEventId, classification }) {
  return {
    id,
    type: CLASSIFICATION_EVENT_TYPE,
    correlationId,
    payload: {
      sourceEventId,
      failureClass: classification.class,
      reason: classification.reason,
      strategy: classification.strategy,
      requiresIdempotencyDecision: classification.requiresIdempotencyDecision,
    },
  };
}

function isClassifiableFailure(value) {
  return isJsonObject(value) || value instanceof Error;
}

function normalizeError(error) {
  if (!isClassifiableFailure(error)) {
    return {};
  }

  return {
    ...error,
    code: isJsonString(error.code) ? error.code.toUpperCase() : undefined,
    membrane: isJsonString(error.membrane) ? error.membrane.toLowerCase() : undefined,
  };
}

function classification(failureClass, reason, extra = {}) {
  return {
    class: failureClass,
    reason,
    strategy: failureStrategies[failureClass],
    requiresIdempotencyDecision: false,
    ...extra,
  };
}

function isRetryBudgetExhausted(context) {
  return (
    Number.isInteger(context.transientAttempts) &&
    Number.isInteger(context.retryBudget) &&
    context.retryBudget >= 0 &&
    context.transientAttempts >= context.retryBudget
  );
}

function isSplitBrain(error) {
  return SPLIT_BRAIN_CODES.has(error.code);
}

function isPoison(error) {
  return POISON_CODES.has(error.code);
}

function isPartial(error) {
  return (
    PARTIAL_CODES.has(error.code) ||
    error.ambiguousCommit === true ||
    error.membrane === "severed" ||
    error.membrane === "ambiguous-return"
  );
}

function isDrift(error) {
  return DRIFT_CODES.has(error.code);
}

function isDurableRecoverable(error) {
  return DURABLE_CODES.has(error.code);
}

function isTransient(error) {
  return (
    TRANSIENT_CODES.has(error.code) ||
    TRANSIENT_STATUSES.has(error.status) ||
    error.membrane === "overloaded"
  );
}
