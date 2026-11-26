export const PROVIDER_RESILIENCE_SCHEMA_VERSION = "hobo.provider-resilience/v1";

export function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold ?? 3;
  const halfOpenProbeBudget = options.halfOpenProbeBudget ?? 1;
  let state = "closed";
  let consecutiveFailures = 0;
  let halfOpenProbes = 0;

  return {
    state() {
      return state;
    },

    recordSuccess() {
      consecutiveFailures = 0;
      halfOpenProbes = 0;
      state = "closed";
    },

    recordFailure() {
      consecutiveFailures += 1;
      if (state === "half-open") {
        state = "open";
        halfOpenProbes = 0;
        return state;
      }
      if (consecutiveFailures >= failureThreshold) {
        state = "open";
      }
      return state;
    },

    allowCall() {
      if (state === "open") {
        return { allowed: false, reason: "circuit-open" };
      }
      if (state === "half-open" && halfOpenProbes >= halfOpenProbeBudget) {
        return { allowed: false, reason: "half-open-budget-exhausted" };
      }
      if (state === "half-open") {
        halfOpenProbes += 1;
      }
      return { allowed: true, reason: state };
    },

    probe() {
      if (state === "open") {
        state = "half-open";
        halfOpenProbes = 0;
      }
      return state;
    },
  };
}

export function createRetryBudget(options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  let spent = 0;

  return {
    spent() {
      return spent;
    },

    tryConsume() {
      if (spent >= maxRetries) {
        return { allowed: false, remaining: 0 };
      }
      spent += 1;
      return { allowed: true, remaining: maxRetries - spent };
    },

    reset() {
      spent = 0;
    },
  };
}

export function createBulkhead(options = {}) {
  const maxConcurrency = options.maxConcurrency ?? 2;
  const active = new Map();

  return {
    activeCount(scope) {
      return active.get(scope) ?? 0;
    },

    tryAcquire(scope) {
      const current = active.get(scope) ?? 0;
      if (current >= maxConcurrency) {
        return { acquired: false, active: current };
      }
      active.set(scope, current + 1);
      return { acquired: true, active: current + 1 };
    },

    release(scope) {
      const current = active.get(scope) ?? 0;
      const next = Math.max(0, current - 1);
      if (next === 0) {
        active.delete(scope);
      } else {
        active.set(scope, next);
      }
      return next;
    },
  };
}

export function evaluateProviderResilience(input) {
  const breaker = createCircuitBreaker(input.breaker ?? {});
  const retryBudget = createRetryBudget(input.retryBudget ?? {});
  const bulkhead = createBulkhead(input.bulkhead ?? {});
  const operations = input.operations ?? [];

  const trace = [];
  let breakerTripped = false;
  let retryBudgetExhausted = false;
  let bulkheadRejected = false;

  for (const operation of operations) {
    const scope = operation.tenant ?? "default";
    const bulkheadResult = bulkhead.tryAcquire(scope);
    if (!bulkheadResult.acquired) {
      bulkheadRejected = true;
      trace.push({ operation, outcome: "bulkhead-rejected" });
      continue;
    }

    const allow = breaker.allowCall();
    if (!allow.allowed) {
      breakerTripped = true;
      bulkhead.release(scope);
      trace.push({ operation, outcome: allow.reason });
      continue;
    }

    if (operation.fail) {
      breaker.recordFailure();
      const retry = retryBudget.tryConsume();
      if (!retry.allowed) {
        retryBudgetExhausted = true;
      }
      bulkhead.release(scope);
      trace.push({ operation, outcome: retry.allowed ? "retry-scheduled" : "retry-budget-exhausted" });
      continue;
    }

    breaker.recordSuccess();
    bulkhead.release(scope);
    trace.push({ operation, outcome: "success" });
  }

  return {
    schemaVersion: PROVIDER_RESILIENCE_SCHEMA_VERSION,
    breakerState: breaker.state(),
    breakerTripped,
    retryBudgetExhausted,
    bulkheadRejected,
    trace,
  };
}
