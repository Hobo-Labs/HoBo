import {
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  createRuleset,
  defineTypescriptRule,
  evaluatePolicy,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import {
  evaluateGatekeeper,
} from "../../gatekeeper-verify-contract/src/gatekeeper-verify.js";
import { isJsonString, isJsonObject } from "./json.js";


export const POLICY_FAIL_CLOSED_SCHEMA_VERSION = "hobo.policy-fail-closed/v1";

export function createPolicyRequest(overrides = {}) {
  return createGoldenDecisionRequest(overrides);
}

export function createAllowRuleset() {
  return createRuleset({
    id: "policy-pack:fail-closed-fixture",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "explicit-allow-rule",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "explicit allow fixture" }),
      }),
    ],
  });
}

export function createThrowingRuleset() {
  return createRuleset({
    id: "policy-pack:throwing-fixture",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "faulty-allow-rule",
        when: () => true,
        decide: () => {
          throw new Error("boom");
        },
      }),
      defineTypescriptRule({
        id: "later-allow-rule",
        when: () => true,
        decide: () => ({ effect: "allow", reason: "must not be reached after throw" }),
      }),
    ],
  });
}

export function evaluatePolicyWithFailClosedFallback({
  request = createPolicyRequest(),
  ruleset = createAllowRuleset(),
  evaluator = builtInEvaluator,
  cache,
  now = Date.now(),
} = {}) {
  try {
    const decision = evaluator({ request, ruleset });
    if (!isStructuredDecision(decision)) {
      return failClosedDecision({
        reason: "policy evaluator returned malformed decision",
        policyIds: ["policy-evaluator/malformed-response"],
        violations: ["decision must include effect, reason, and evidence"],
      });
    }

    return {
      schemaVersion: POLICY_FAIL_CLOSED_SCHEMA_VERSION,
      ...decision,
      failClosed: decision.effect === "deny",
    };
  } catch (error) {
    if (cache?.decision?.effect === "allow" && cacheExpired({ cache, now })) {
      return failClosedDecision({
        reason: "cached allow exceeded revocation bound while evaluator unavailable",
        policyIds: ["decision-cache/stale-allow"],
        violations: [`cached allow decided at ${cache.decidedAt} expired before ${now}`],
      });
    }

    return failClosedDecision({
      reason: `policy evaluator unavailable: ${error.message}`,
      policyIds: ["policy-evaluator/unreachable"],
      violations: [error.message],
    });
  }
}

export function evaluateCompositeGate({ target = "prod", request = {}, engines = {} } = {}) {
  return evaluateGatekeeper({
    target,
    request,
    engines,
  });
}

export function evaluateGuardedStep({ step, execute }) {
  if (!isNonEmptyString(step)) {
    throw new TypeError("step is required");
  }
  if (!(execute instanceof Function)) {
    throw new TypeError("execute must be a function");
  }

  try {
    const result = execute();
    if (!result || result.ok !== true) {
      return {
        step,
        ok: false,
        blocked: true,
        reason: result?.reason ?? `${step} returned non-passing result`,
      };
    }

    return {
      step,
      ok: true,
      blocked: false,
      reason: result.reason ?? `${step} passed`,
    };
  } catch (error) {
    return {
      step,
      ok: false,
      blocked: true,
      reason: `${step} errored: ${error.message}`,
    };
  }
}

export function runEvaluatorFaultInjection({
  request = createPolicyRequest(),
  ruleset = createAllowRuleset(),
} = {}) {
  const probes = [
    {
      fault: "throw",
      decision: evaluatePolicyWithFailClosedFallback({
        request,
        ruleset,
        evaluator: () => {
          throw new Error("chaos throw");
        },
      }),
    },
    {
      fault: "unreachable",
      decision: evaluatePolicyWithFailClosedFallback({
        request,
        ruleset,
        evaluator: () => {
          throw new Error("network partition");
        },
      }),
    },
    {
      fault: "malformed-response",
      decision: evaluatePolicyWithFailClosedFallback({
        request,
        ruleset,
        evaluator: () => ({ effect: "allow" }),
      }),
    },
    {
      fault: "stale-cache",
      decision: evaluatePolicyWithFailClosedFallback({
        request,
        ruleset,
        evaluator: () => {
          throw new Error("partitioned");
        },
        cache: {
          decision: { effect: "allow", reason: "cached allow before partition" },
          decidedAt: 1_000,
          revocationBoundMs: 500,
        },
        now: 1_501,
      }),
    },
  ];

  return {
    schemaVersion: POLICY_FAIL_CLOSED_SCHEMA_VERSION,
    probes,
    allowed: probes.filter((probe) => probe.decision.effect === "allow"),
  };
}

function builtInEvaluator({ request, ruleset }) {
  return evaluatePolicy(createBuiltInPolicyEngine(), request, ruleset);
}

function failClosedDecision({ reason, policyIds, violations = [] }) {
  return {
    schemaVersion: POLICY_FAIL_CLOSED_SCHEMA_VERSION,
    effect: "deny",
    reason,
    failClosed: true,
    violations,
    mutations: [],
    approvals: [],
    obligations: [],
    evidence: {
      engine: "hobo.policy-fail-closed/fallback@0.1.0",
      policyIds,
    },
  };
}

function cacheExpired({ cache, now }) {
  return now >= cache.decidedAt + cache.revocationBoundMs;
}

function isStructuredDecision(decision) {
  return (
    decision &&
    isJsonObject(decision) &&
    ["allow", "deny", "warn", "mutate", "allow-degraded", "require-approval"].includes(decision.effect) &&
    isNonEmptyString(decision.reason) &&
    decision.evidence &&
    isJsonObject(decision.evidence) &&
    Array.isArray(decision.evidence.policyIds)
  );
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
