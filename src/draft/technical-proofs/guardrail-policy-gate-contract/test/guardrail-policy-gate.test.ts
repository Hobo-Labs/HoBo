import assert from "node:assert/strict";
import { test } from "vitest";

import {
  decideGuardrailStep,
  decidePromptPromotion,
  rebuildGuardrailRun,
  rebuildPromotionDecision,
  releaseGuardedOutput,
} from "../src/guardrail-policy-gate.js";

test("guardrail failure records policy.Decided and guardrail.Blocked replayably", () => {
  const decision = decideGuardrailStep(guardrailRun({
    checks: [
      { rail: "pii", status: "pass" },
      { rail: "jailbreak", status: "fail", finding: "disallowed jailbreak pattern" },
    ],
  }));

  assert.equal(decision.effect, "block");
  assert.equal(decision.policyDecision.effect, "deny");
  assert.deepEqual(decision.events.map((event) => event.type), [
    "policy.Decided",
    "guardrail.Blocked",
  ]);
  assert.equal(decision.events[1].data.outputReleased, false);

  const rebuilt = rebuildGuardrailRun(decision.events);
  assert.equal(rebuilt.policyDecision.reason, "guardrail failure: jailbreak");
  assert.equal(rebuilt.blocked.reason, "guardrail failure: jailbreak");
  assert.equal(rebuilt.released, false);
});

test("guardrail check errors fail closed and do not pass output through", () => {
  const decision = decideGuardrailStep(guardrailRun({
    checks: [
      { rail: "grounding", status: "error", finding: "checker timeout" },
    ],
  }));

  assert.equal(decision.effect, "block");
  assert.equal(decision.policyDecision.effect, "deny");
  assert.equal(decision.policyDecision.reason, "guardrail failure: grounding");
  assert.match(decision.policyDecision.violations.at(0), /checker timeout/);
  assert.equal(releaseGuardedOutput(decision.events).released, false);
});

test("redact decisions block the original guardrail output", () => {
  const decision = decideGuardrailStep(guardrailRun({
    policyEffect: "mutate",
    checks: [
      { rail: "pii", status: "fail", finding: "email address present" },
    ],
  }));

  assert.equal(decision.effect, "redact");
  assert.equal(decision.policyDecision.effect, "mutate");
  assert.equal(decision.events[1].type, "guardrail.Blocked");
  assert.equal(decision.events[1].data.outputReleased, false);
  assert.deepEqual(releaseGuardedOutput(decision.events), {
    released: false,
    reason: "redaction required before release",
  });
});

test("require-approval guardrail failure holds until durable obligation is satisfied", () => {
  const decision = decideGuardrailStep(guardrailRun({
    policyEffect: "require-approval",
    checks: [
      { rail: "human-review", status: "fail", finding: "ambiguous safety classification" },
    ],
  }));

  assert.equal(decision.effect, "require-approval");
  assert.equal(decision.policyDecision.obligations[0].kind, "require-approval");
  assert.equal(releaseGuardedOutput(decision.events).released, false);

  const forged = [
    ...decision.events,
    obligationSatisfied({ id: "approval:other-output", effectRef: "guardrail:other-output" }),
  ];
  assert.equal(releaseGuardedOutput(forged).released, false);

  const satisfied = [
    ...decision.events,
    obligationSatisfied({
      id: "approval:output-187",
      effectRef: "guardrail:output-187",
    }),
  ];
  assert.equal(releaseGuardedOutput(satisfied).released, true);
});

test("prompt promotion blocks coverage regression even when eval improves", () => {
  const decision = decidePromptPromotion(promotionCandidate({
    lenses: {
      contract: {
        guardrailCoverage: {
          champion: ["moderation", "pii", "jailbreak", "grounding"],
          candidate: ["moderation", "pii", "grounding"],
        },
      },
      eval: {
        championScore: 0.81,
        candidateScore: 0.93,
        minDelta: 0.02,
      },
      policy: { effect: "allow" },
      trace: { openInferenceTrajectory: "trace://candidate-187" },
    },
  }));

  assert.equal(decision.promote, false);
  assert.equal(decision.policyDecision.effect, "deny");
  assert.equal(decision.policyDecision.reason, "contract lens failed");
  assert.deepEqual(decision.lensResults.contract.missingRails, ["jailbreak"]);
  assert.equal(decision.lensResults.eval.passed, true);
  assert.equal(decision.events.some((event) => event.type === "model.Promoted"), false);

  const rebuilt = rebuildPromotionDecision(decision.events);
  assert.equal(rebuilt.promote, false);
  assert.equal(rebuilt.lensResults.contract.passed, false);
});

test("promotion composes all four lenses and never passes on eval alone", () => {
  const evalOnly = decidePromptPromotion(promotionCandidate({
    lenses: {
      eval: {
        championScore: 0.6,
        candidateScore: 0.95,
        minDelta: 0.02,
      },
    },
  }));

  assert.equal(evalOnly.promote, false);
  assert.equal(evalOnly.policyDecision.reason, "contract lens failed");

  const allGreen = decidePromptPromotion(promotionCandidate());

  assert.equal(allGreen.promote, true);
  assert.deepEqual(Object.fromEntries(
    Object.entries(allGreen.lensResults).map(([name, result]) => [name, result.passed]),
  ), {
    contract: true,
    eval: true,
    policy: true,
    trace: true,
  });
  assert.equal(allGreen.events.at(-1).type, "model.Promoted");
});

function guardrailRun(overrides = {}) {
  return {
    runId: "guardrail-run-187",
    outputId: "output-187",
    subject: { kind: "agent", id: "spiffe://tenant-a/yard/agent/codegen" },
    phase: "runtime",
    checks: [
      { rail: "moderation", status: "pass" },
      { rail: "pii", status: "pass" },
    ],
    policyEffect: "deny",
    ts: "2026-06-26T08:00:00.000Z",
    ...overrides,
  };
}

function promotionCandidate(overrides = {}) {
  return {
    runId: "prompt-promote-187",
    candidateId: "prompt@2.0.0",
    championId: "prompt@1.9.0",
    subject: { kind: "agent", id: "spiffe://tenant-a/yard/model-governor" },
    ts: "2026-06-26T08:00:00.000Z",
    lenses: {
      contract: {
        guardrailCoverage: {
          champion: ["moderation", "pii", "jailbreak", "grounding"],
          candidate: ["moderation", "pii", "jailbreak", "grounding"],
        },
      },
      eval: {
        championScore: 0.81,
        candidateScore: 0.88,
        minDelta: 0.02,
      },
      policy: { effect: "allow" },
      trace: { openInferenceTrajectory: "trace://candidate-187" },
    },
    ...overrides,
  };
}

function obligationSatisfied({ id, effectRef }) {
  return {
    id: `event:${id}`,
    type: "policy.ObligationSatisfied",
    v: 1,
    streamId: "guardrail:output-187",
    seq: 3,
    ts: "2026-06-26T08:05:00.000Z",
    correlationId: "guardrail-run-187",
    data: {
      id,
      effectRef,
    },
  };
}
