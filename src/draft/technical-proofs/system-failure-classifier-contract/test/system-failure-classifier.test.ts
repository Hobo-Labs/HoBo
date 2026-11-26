import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  CLASSIFICATION_EVENT_TYPE,
  classifyFailure,
  crossesNoGoThreshold,
  failureStrategies,
  makeClassificationEvent,
} from "../src/classifier.js";

describe("system-level failure classifier contract", () => {
  it("maps representative runtime failures to the expected class and strategy", () => {
    const cases = [
      {
        name: "provider throttling",
        error: { status: 429, source: "provider", operation: "apply" },
        expectedClass: "transient",
        expectedStrategy: "backoff-budget",
      },
      {
        name: "yard node crash",
        error: { code: "NODE_CRASH", phase: "deploy" },
        expectedClass: "durable-recoverable",
        expectedStrategy: "replay-resume",
      },
      {
        name: "three of five resources failed",
        error: { code: "PARTIAL_APPLY", provisioned: 2, failed: 3, total: 5 },
        expectedClass: "partial-failure",
        expectedStrategy: "saga-compensation",
      },
      {
        name: "malformed plan",
        error: { code: "MALFORMED_PLAN", phase: "plan" },
        expectedClass: "poison",
        expectedStrategy: "mark-failed-fatal",
      },
      {
        name: "out-of-band resource change",
        error: { code: "DRIFT_DETECTED", resourceId: "db" },
        expectedClass: "drift",
        expectedStrategy: "resync",
      },
      {
        name: "dual leader",
        error: { code: "STALE_FENCE_REJECTED", owner: "old-yard-node" },
        expectedClass: "split-brain",
        expectedStrategy: "leases-and-fencing",
      },
    ];

    for (const testCase of cases) {
      const result = classifyFailure(testCase.error);

      assert.equal(result.class, testCase.expectedClass, testCase.name);
      assert.equal(result.strategy.kind, testCase.expectedStrategy, testCase.name);
      assert.deepEqual(result.strategy, failureStrategies[testCase.expectedClass]);
    }
  });

  it("fails unknown errors closed instead of retrying possible poison forever", () => {
    const result = classifyFailure({ code: "NEW_PROVIDER_FATAL_SHAPE" });

    assert.equal(result.class, "poison");
    assert.equal(result.strategy.kind, "mark-failed-fatal");
    assert.equal(result.reason, "unknown-error-fail-closed");
  });

  it("maps membrane severed and overloaded signals into the system taxonomy", () => {
    assert.equal(
      classifyFailure({ membrane: "overloaded", import: "wasi:keyvalue/get" }).class,
      "transient",
    );
    assert.equal(
      classifyFailure({ membrane: "severed", ambiguousCommit: true }).class,
      "partial-failure",
    );
  });

  it("applies precedence when one error matches multiple classes", () => {
    const result = classifyFailure({
      status: 503,
      code: "MALFORMED_PLAN",
      phase: "apply",
    });

    assert.equal(result.class, "poison");
    assert.equal(result.reason, "matched-poison-before-transient");
  });

  it("reclassifies exhausted transient budgets to fatal poison", () => {
    const result = classifyFailure(
      { status: 429, source: "provider" },
      { transientAttempts: 4, retryBudget: 3 },
    );

    assert.equal(result.class, "poison");
    assert.equal(result.reason, "transient-retry-budget-exhausted");
    assert.equal(result.strategy.kind, "mark-failed-fatal");
  });

  it("defers ambiguous commit classification to the idempotency rule", () => {
    const result = classifyFailure({
      code: "AMBIGUOUS_COMMIT",
      operation: "provider-call",
      ambiguousCommit: true,
    });

    assert.equal(result.class, "partial-failure");
    assert.equal(result.strategy.idempotencyRule, "forward-key-or-refresh-before-act");
    assert.equal(result.requiresIdempotencyDecision, true);
  });

  it("evaluates no-go threshold descriptors without embedding compensation logic", () => {
    assert.equal(
      crossesNoGoThreshold(
        [{ class: "transient" }, { class: "poison" }],
        { kind: "any-fatal" },
      ),
      true,
    );
    assert.equal(
      crossesNoGoThreshold(
        [{ class: "transient" }, { class: "transient" }, { class: "drift" }],
        { kind: "transient-exhaustions", count: 2 },
      ),
      true,
    );
    assert.equal(
      crossesNoGoThreshold(
        [{ class: "transient" }, { class: "drift" }],
        { kind: "transient-exhaustions", count: 2 },
      ),
      false,
    );
  });

  it("emits a stable classification event payload", () => {
    const result = classifyFailure({ code: "DRIFT_DETECTED", resourceId: "api" });
    const event = makeClassificationEvent({
      id: "evt-1",
      correlationId: "deploy-1",
      sourceEventId: "exec-9",
      classification: result,
    });

    assert.equal(event.type, CLASSIFICATION_EVENT_TYPE);
    assert.equal(event.id, "evt-1");
    assert.equal(event.correlationId, "deploy-1");
    assert.equal(event.payload.sourceEventId, "exec-9");
    assert.equal(event.payload.failureClass, "drift");
    assert.equal(event.payload.strategy.kind, "resync");
  });
});
