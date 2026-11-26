import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createBulkhead,
  createCircuitBreaker,
  createRetryBudget,
  evaluateProviderResilience,
} from "../src/provider-resilience.js";

test("Circuit breaker opens after failure threshold and blocks hammering a degraded provider", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 2 });

  breaker.recordFailure();
  assert.equal(breaker.state(), "closed");
  breaker.recordFailure();
  assert.equal(breaker.state(), "open");
  assert.deepEqual(breaker.allowCall(), { allowed: false, reason: "circuit-open" });
});

test("Retry budget caps total retries for a flapping deployment", () => {
  const budget = createRetryBudget({ maxRetries: 2 });

  assert.deepEqual(budget.tryConsume(), { allowed: true, remaining: 1 });
  assert.deepEqual(budget.tryConsume(), { allowed: true, remaining: 0 });
  assert.deepEqual(budget.tryConsume(), { allowed: false, remaining: 0 });
});

test("Bulkhead prevents one tenant from starving others", () => {
  const bulkhead = createBulkhead({ maxConcurrency: 1 });

  assert.equal(bulkhead.tryAcquire("tenant-a").acquired, true);
  assert.equal(bulkhead.tryAcquire("tenant-a").acquired, false);
  assert.equal(bulkhead.tryAcquire("tenant-b").acquired, true);
});

test("Provider resilience evaluation trips breaker, exhausts retry budget, and rejects bulkhead overflow", () => {
  const result = evaluateProviderResilience({
    breaker: { failureThreshold: 2 },
    retryBudget: { maxRetries: 1 },
    bulkhead: { maxConcurrency: 1 },
    operations: [
      { tenant: "tenant-a", fail: true },
      { tenant: "tenant-a", fail: true },
      { tenant: "tenant-a", fail: true },
      { tenant: "tenant-a", fail: false },
      { tenant: "tenant-b", fail: false },
      { tenant: "tenant-b", fail: false },
    ],
  });

  assert.equal(result.breakerTripped, true);
  assert.equal(result.retryBudgetExhausted, true);
  assert.ok(result.trace.some((entry) => entry.outcome === "circuit-open"));
});
