import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createAllowRuleset,
  createPolicyRequest,
  createThrowingRuleset,
  evaluateCompositeGate,
  evaluateGuardedStep,
  evaluatePolicyWithFailClosedFallback,
  runEvaluatorFaultInjection,
} from "../src/policy-fail-closed.js";

describe("HOBO-215 policy fail-closed contract", () => {
  it("denies when the policy evaluator is unreachable", () => {
    const decision = evaluatePolicyWithFailClosedFallback({
      request: createPolicyRequest(),
      ruleset: createAllowRuleset(),
      evaluator: () => {
        throw new Error("ECONNREFUSED policy-evaluator");
      },
    });

    assert.equal(decision.effect, "deny");
    assert.equal(decision.failClosed, true);
    assert.match(decision.reason, /policy evaluator unavailable/);
    assert.deepEqual(decision.evidence.policyIds, ["policy-evaluator/unreachable"]);
  });

  it("fails closed when a ruleset cannot compile", () => {
    const decision = evaluatePolicyWithFailClosedFallback({
      request: createPolicyRequest(),
      ruleset: {
        schemaVersion: "hobo.policy-ruleset/v999",
        id: "policy-pack:broken",
        version: "not-semver",
        rules: [],
      },
    });

    assert.equal(decision.effect, "deny");
    assert.equal(decision.failClosed, true);
    assert.match(decision.reason, /ruleset compile failed/);
  });

  it("denies when a rule throws and does not skip the rule as pass", () => {
    const decision = evaluatePolicyWithFailClosedFallback({
      request: createPolicyRequest(),
      ruleset: createThrowingRuleset(),
    });

    assert.equal(decision.effect, "deny");
    assert.equal(decision.failClosed, true);
    assert.match(decision.reason, /rule evaluation failed/);
    assert.deepEqual(decision.evidence.policyIds, ["faulty-allow-rule"]);
    assert.match(decision.violations.join("\n"), /faulty-allow-rule.*boom/);
  });

  it("blocks verify composition when a required gate is missing or times out", () => {
    const missing = evaluateCompositeGate({
      target: "prod",
      engines: omit(greenGateEngines(), "policy"),
    });

    assert.equal(missing.deployable, false);
    assert.equal(missing.status, "blocked");
    assert.deepEqual(missing.failures.map((failure) => failure.gate), ["policy"]);
    assert.match(missing.failures[0].reason, /missing gate engine result/);

    const partial = evaluateCompositeGate({
      target: "prod",
      engines: {
        ...greenGateEngines(),
        eval: () => {
          throw new Error("timed out");
        },
      },
    });

    assert.equal(partial.deployable, false);
    assert.deepEqual(partial.failures.map((failure) => failure.gate), ["eval"]);
    assert.match(partial.failures[0].reason, /timed out/);
  });

  it("blocks when a guardrail or contract step errors", () => {
    const guardrail = evaluateGuardedStep({
      step: "guardrail.pii",
      execute: () => {
        throw new Error("moderation backend down");
      },
    });
    const contract = evaluateGuardedStep({
      step: "contract.consumer",
      execute: () => ({ ok: false, reason: "consumer pact mismatch" }),
    });

    assert.equal(guardrail.ok, false);
    assert.equal(guardrail.blocked, true);
    assert.match(guardrail.reason, /guardrail.pii errored/);

    assert.equal(contract.ok, false);
    assert.equal(contract.blocked, true);
    assert.equal(contract.reason, "consumer pact mismatch");
  });

  it("never emits allow under evaluator-path chaos faults", () => {
    const report = runEvaluatorFaultInjection({
      request: createPolicyRequest(),
      ruleset: createAllowRuleset(),
    });

    assert.deepEqual(
      report.probes.map((probe) => probe.fault),
      ["throw", "unreachable", "malformed-response", "stale-cache"],
    );
    assert.equal(report.allowed.length, 0);
    assert.equal(report.probes.every((probe) => probe.decision.effect === "deny"), true);
  });

  it("does not serve a stale cached allow past the revocation bound", () => {
    const decision = evaluatePolicyWithFailClosedFallback({
      request: createPolicyRequest(),
      ruleset: createAllowRuleset(),
      evaluator: () => {
        throw new Error("partitioned");
      },
      cache: {
        decision: { effect: "allow", reason: "cached allow before revocation" },
        decidedAt: 1_000,
        revocationBoundMs: 500,
      },
      now: 1_501,
    });

    assert.equal(decision.effect, "deny");
    assert.equal(decision.failClosed, true);
    assert.match(decision.reason, /cached allow exceeded revocation bound/);
  });
});

function greenGateEngines() {
  return Object.fromEntries(
    [
      "contracts",
      "policy",
      "eval",
      "conformance",
      "cost",
      "signing",
      "golden-suite",
      "deployment-plan",
    ].map((gate) => [
      gate,
      () => ({
        gate,
        ok: true,
        reason: `${gate} passed`,
        suggestedFixes: [],
        engineId: `engine/${gate}`,
      }),
    ]),
  );
}

function omit(source, key) {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
