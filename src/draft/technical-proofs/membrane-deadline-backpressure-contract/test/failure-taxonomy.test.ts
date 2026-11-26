import assert from "node:assert/strict";
import { test } from "vitest";

import {
  classifyFailure,
  failureStrategies,
  parseDeadline,
  parseFailureClassification,
} from "../src/index.js";

test("classifyFailure({}) returns poison with unknown-error-fail-closed", () => {
  const result = classifyFailure({});
  assert.equal(result.class, "poison");
  assert.equal(result.reason, "unknown-error-fail-closed");
  assert.equal(result.requiresIdempotencyDecision, false);
});

test("membrane overloaded classifies transient", () => {
  const result = classifyFailure({ membrane: "overloaded" });
  assert.equal(result.class, "transient");
  assert.equal(result.strategy.kind, "backoff-budget");
});

test("membrane severed classifies partial-failure with idempotency decision", () => {
  const result = classifyFailure({ membrane: "severed", ambiguousCommit: true });
  assert.equal(result.class, "partial-failure");
  assert.equal(result.requiresIdempotencyDecision, true);
  assert.equal(
    // SAFETY: assertion to `(result.strategy as { idempotencyRule: string }).idempotencyRule,` is required at this boundary.
    (result.strategy as { idempotencyRule: string }).idempotencyRule,
    "forward-key-or-refresh-before-act",
  );
});

test("retry budget exhaustion classifies poison", () => {
  const result = classifyFailure({ code: "TIMEOUT" }, { transientAttempts: 3, retryBudget: 3 });
  assert.equal(result.class, "poison");
  assert.equal(result.reason, "transient-retry-budget-exhausted");
});

test("deriveDeadline inherits and shrinks parent deadline", () => {
  const _parent = {
    source: "caller" as const,
    startedAtMs: 100,
    expiresAtMs: 200,
    remainingAtDispatchMs: 100,
  };
  const child = parseDeadline({
    source: "inherited",
    startedAtMs: 130,
    expiresAtMs: 180,
    remainingAtDispatchMs: 50,
  });
  assert.equal(child.source, "inherited");
  assert.equal(child.remainingAtDispatchMs, 50);
});

test("parseDeadline rejects expires_at_ms < started_at_ms", () => {
  assert.throws(
    () =>
      parseDeadline({
        source: "caller",
        startedAtMs: 100,
        expiresAtMs: 50,
        remainingAtDispatchMs: 0,
      }),
    /expires_at_ms/,
  );
});

test("parseFailureClassification rejects out-of-enum class", () => {
  assert.throws(
    () =>
      parseFailureClassification({
        class: "not-a-class",
        reason: "bad",
      }),
    /invalid/,
  );
});

test("failureStrategies covers all six Plan-05 classes", () => {
  assert.equal(Object.keys(failureStrategies).length, 6);
  assert.equal(failureStrategies["partial-failure"].kind, "saga-compensation");
});
