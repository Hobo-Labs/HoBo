import assert from "node:assert/strict";
import { test } from "vitest";

import {
  EVAL_EVENT_SCHEMA,
  EVAL_PROMOTION_GATE_SCHEMA,
  createClassifyTicketPromotionGate,
  deserializeEvalEvent,
  evaluatePromotionCandidate,
  makeEvalEvent,
  serializeEvalEvent,
  validateEvalEvent,
  validatePromotionGate,
} from "../src/eval-promotion-gate.js";

test("classifyTicket promotionGate fixture validates the contract surface", () => {
  const gate = createClassifyTicketPromotionGate();
  const parsed = validatePromotionGate(gate);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parsed.gate.schema, EVAL_PROMOTION_GATE_SCHEMA);
  assert.equal(parsed.gate.semanticFunction, "classifyTicket");
  assert.equal(parsed.gate.requireConformance, true);
  assert.deepEqual(parsed.gate.evalThresholds, {
    categoryCorrect: 0.92,
    piiSafe: 1,
    urgencyCalibrated: 0.9,
  });
  assert.equal(parsed.gate.shadowTraffic, "10%");
  assert.equal(parsed.gate.minSamples, 1000);
  assert.equal(parsed.gate.policy, "promote.semantic.prod");
});

test("promotion decision composes conformance eval and policy into one outcome", () => {
  const gate = createClassifyTicketPromotionGate();
  const belowThreshold = evaluatePromotionCandidate(gate, {
    candidateId: "candidate-shadow",
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: 1200,
    scores: {
      categoryCorrect: 0.91,
      urgencyCalibrated: 0.93,
      piiSafe: 1,
    },
  });

  assert.equal(belowThreshold.outcome, "stay-shadow");
  assert.deepEqual(belowThreshold.passFlags, {
    conformance: true,
    eval: false,
    policy: true,
  });
  assert.match(belowThreshold.failures.join("\n"), /categoryCorrect below 0\.92/);

  const policyDenied = evaluatePromotionCandidate(gate, {
    candidateId: "candidate-policy-denied",
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "deny" },
    samples: 1200,
    scores: {
      categoryCorrect: 0.94,
      urgencyCalibrated: 0.91,
      piiSafe: 1,
    },
  });

  assert.equal(policyDenied.outcome, "stay-shadow");
  assert.deepEqual(policyDenied.passFlags, {
    conformance: true,
    eval: true,
    policy: false,
  });
  assert.match(policyDenied.failures.join("\n"), /policy did not allow promotion/);

  const passing = evaluatePromotionCandidate(gate, {
    candidateId: "candidate-green",
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: 1200,
    scores: {
      categoryCorrect: 0.94,
      urgencyCalibrated: 0.91,
      piiSafe: 1,
    },
  });

  assert.equal(passing.outcome, "promote");
  assert.deepEqual(passing.passFlags, {
    conformance: true,
    eval: true,
    policy: true,
  });
  assert.deepEqual(passing.failures, []);
});

test("eval ran and gate decision events validate against the shared envelope", () => {
  const gate = createClassifyTicketPromotionGate();
  const passingDecision = evaluatePromotionCandidate(gate, {
    candidateId: "candidate-green",
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: 1200,
    scores: {
      categoryCorrect: 0.94,
      urgencyCalibrated: 0.91,
      piiSafe: 1,
    },
  });
  const failedDecision = evaluatePromotionCandidate(gate, {
    candidateId: "candidate-shadow",
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: 1200,
    scores: {
      categoryCorrect: 0.91,
      urgencyCalibrated: 0.93,
      piiSafe: 1,
    },
  });

  const ran = makeEvalEvent({
    id: "evt-001",
    type: "eval.Ran",
    semanticFunction: "classifyTicket",
    candidateId: "candidate-green",
    seq: 1,
    data: {
      samples: 1200,
      scores: {
        categoryCorrect: 0.94,
        urgencyCalibrated: 0.91,
        piiSafe: 1,
      },
    },
  });
  const passed = makeEvalEvent({
    id: "evt-002",
    type: "eval.GatePassed",
    semanticFunction: "classifyTicket",
    candidateId: "candidate-green",
    seq: 2,
    data: passingDecision,
  });
  const failed = makeEvalEvent({
    id: "evt-003",
    type: "eval.GateFailed",
    semanticFunction: "classifyTicket",
    candidateId: "candidate-shadow",
    seq: 3,
    data: failedDecision,
  });

  for (const event of [ran, passed, failed]) {
    const parsed = validateEvalEvent(event);
    assert.equal(parsed.ok, true, parsed.errors.join("\n"));
    assert.equal(parsed.event.data.schema, EVAL_EVENT_SCHEMA);
    assert.match(parsed.event.meta.traceparent, /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  }

  assert.deepEqual(deserializeEvalEvent(serializeEvalEvent(passed)), passed);
  assert.equal(validateEvalEvent({ ...ran, meta: { traceparent: "not-a-trace" } }).ok, false);
});

test("hard safety dimension and minSamples floor fail closed", () => {
  const missingSafety = validatePromotionGate(
    {
      ...createClassifyTicketPromotionGate(),
      evalThresholds: {
        categoryCorrect: 0.92,
        urgencyCalibrated: 0.9,
      },
    },
  );
  assert.equal(missingSafety.ok, false);
  assert.match(missingSafety.errors.join("\n"), /hard safety dimension piiSafe/);

  const softSafety = validatePromotionGate(createClassifyTicketPromotionGate({ evalThresholds: { piiSafe: 0.999 } }));
  assert.equal(softSafety.ok, false);
  assert.match(softSafety.errors.join("\n"), /piiSafe must be 1/);

  const gate = createClassifyTicketPromotionGate();
  const tooFewSamples = evaluatePromotionCandidate(gate, {
    candidateId: "candidate-under-sampled",
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: 999,
    scores: {
      categoryCorrect: 0.99,
      urgencyCalibrated: 0.99,
      piiSafe: 1,
    },
  });

  assert.equal(tooFewSamples.outcome, "stay-shadow");
  assert.deepEqual(tooFewSamples.passFlags, {
    conformance: true,
    eval: false,
    policy: true,
  });
  assert.match(tooFewSamples.failures.join("\n"), /samples below minSamples 1000/);
});
