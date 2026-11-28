import { isJsonString, isJsonObject, type JsonValue, type JsonObject, type JsonBag } from "./json.js";
export type FailureClass =
  | "transient"
  | "durable-recoverable"
  | "partial-failure"
  | "poison"
  | "drift"
  | "split-brain";

export type FailureStrategy =
  | {
      kind: "backoff-budget";
      retry: "capped-exponential-backoff-with-jitter";
      terminalAfter: "retry-budget";
    }
  | { kind: "replay-resume"; resumeFrom: "event-log" }
  | {
      kind: "saga-compensation";
      order: "reverse-topological";
      idempotencyRule: "forward-key-or-refresh-before-act";
    }
  | { kind: "mark-failed-fatal"; retry: "never"; surface: "human-or-agent" }
  | { kind: "resync"; policies: readonly string[] }
  | { kind: "leases-and-fencing"; guard: "quorum-fenced-append" };

// domain-view: parse-produced draft-proof record; its wire form is the FailureClassification proto message in data-models/.
export interface FailureClassification {
  class: FailureClass;
  reason: string;
  strategy: FailureStrategy;
  requiresIdempotencyDecision: boolean;
}

export const failureStrategies: Readonly<Record<FailureClass, FailureStrategy>> = Object.freeze({
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

export const CLASSIFICATION_EVENT_TYPE = "failure.Classified";

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
const TRANSIENT_CODES = new Set([
  "NETWORK_BLIP",
  "PROVIDER_429",
  "PROVIDER_503",
  "TIMEOUT",
  "DEADLINE-EXCEEDED",
]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const FAILURE_CLASSES = new Set<FailureClass>([
  "transient",
  "durable-recoverable",
  "partial-failure",
  "poison",
  "drift",
  "split-brain",
]);

export function classifyFailure<T>(
  error: T,
  context: { transientAttempts?: number; retryBudget?: number } = {},
): FailureClassification {
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

export function parseFailureClassification(raw: JsonValue): FailureClassification {
  if (!raw || !isJsonObject(raw)) {
    throw new TypeError("failure classification must be an object");
  }

  // SAFETY: assertion to `const value = raw as JsonObject;` is required at this boundary.
  const value = raw as JsonObject;
  const failureClass = value.class;
  // SAFETY: assertion to `if (!isJsonString(failureClass) || !FAILURE_CLASSES.has(failureClass as FailureC` is required at this boundary.
  if (!isJsonString(failureClass) || !FAILURE_CLASSES.has(failureClass as FailureClass)) {
    throw new TypeError("failure classification class is invalid");
  }

  const reason = value.reason;
  if (!isJsonString(reason) || reason.length === 0) {
    throw new TypeError("failure classification reason is required");
  }

  // SAFETY: assertion to `const strategy = failureStrategies[failureClass as FailureClass];` is required at this boundary.
  const strategy = failureStrategies[failureClass as FailureClass];
  const requiresIdempotencyDecision = value.requiresIdempotencyDecision === true;

  return Object.freeze({
    // SAFETY: assertion to `class: failureClass as FailureClass,` is required at this boundary.
    class: failureClass as FailureClass,
    reason,
    strategy,
    requiresIdempotencyDecision,
  });
}

function isErrorRecord<T>(error: T): error is T & JsonObject {
  return error instanceof Error || isJsonObject(error);
}

function normalizeError<T>(error: T): JsonObject {
  if (!error || !isErrorRecord(error)) {
    return {};
  }

  // SAFETY: Error instances expose enumerable failure fields at this boundary.
  const bag: JsonBag = error as never;
  const record: JsonBag = { ...bag };
  return {
    ...record,
    code:
      isJsonString(record.code) ? record.code.toUpperCase() : undefined,
    membrane:
      isJsonString(record.membrane)
        ? record.membrane.toLowerCase()
        : undefined,
  };
}

function classification(
  failureClass: FailureClass,
  reason: string,
  extra: Partial<FailureClassification> = {},
): FailureClassification {
  return Object.freeze({
    class: failureClass,
    reason,
    strategy: failureStrategies[failureClass],
    requiresIdempotencyDecision: false,
    ...extra,
  });
}

function isRetryBudgetExhausted(context: {
  transientAttempts?: number;
  retryBudget?: number;
}): boolean {
  return (
    Number.isInteger(context.transientAttempts) &&
    Number.isInteger(context.retryBudget) &&
    // SAFETY: assertion to `(context.retryBudget as number) >= 0 &&` is required at this boundary.
    (context.retryBudget as number) >= 0 &&
    // SAFETY: assertion to `(context.transientAttempts as number) >= (context.retryBudget as number)` is required at this boundary.
    (context.transientAttempts as number) >= (context.retryBudget as number)
  );
}

function isSplitBrain(error: JsonObject): boolean {
  // SAFETY: assertion to `return SPLIT_BRAIN_CODES.has(error.code as string);` is required at this boundary.
  return SPLIT_BRAIN_CODES.has(error.code as string);
}

function isPoison(error: JsonObject): boolean {
  // SAFETY: assertion to `return POISON_CODES.has(error.code as string);` is required at this boundary.
  return POISON_CODES.has(error.code as string);
}

function isPartial(error: JsonObject): boolean {
  return (
    // SAFETY: assertion to `PARTIAL_CODES.has(error.code as string) ||` is required at this boundary.
    PARTIAL_CODES.has(error.code as string) ||
    error.ambiguousCommit === true ||
    error.membrane === "severed" ||
    error.membrane === "ambiguous-return"
  );
}

function isDrift(error: JsonObject): boolean {
  // SAFETY: assertion to `return DRIFT_CODES.has(error.code as string);` is required at this boundary.
  return DRIFT_CODES.has(error.code as string);
}

function isDurableRecoverable(error: JsonObject): boolean {
  // SAFETY: assertion to `return DURABLE_CODES.has(error.code as string);` is required at this boundary.
  return DURABLE_CODES.has(error.code as string);
}

function isTransient(error: JsonObject): boolean {
  return (
    // SAFETY: assertion to `TRANSIENT_CODES.has(error.code as string) ||` is required at this boundary.
    TRANSIENT_CODES.has(error.code as string) ||
    // SAFETY: assertion to `TRANSIENT_STATUSES.has(error.status as number) ||` is required at this boundary.
    TRANSIENT_STATUSES.has(error.status as number) ||
    error.membrane === "overloaded"
  );
}
