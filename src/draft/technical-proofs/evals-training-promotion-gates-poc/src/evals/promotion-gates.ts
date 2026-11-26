import {
  createClassifyTicketPromotionGate,
  evaluatePromotionCandidate,
  validatePromotionGate,
} from "../../../eval-promotion-gate-contract/src/eval-promotion-gate.js";

import { rubricToGateThresholds } from "./rubrics.js";

export const EVALS_PROMOTION_GATE_SCHEMA = "hobo.evals.promotion-gate/v1";

export function createPromotionGateFromRubric(rubric, overrides = {}) {
  return createClassifyTicketPromotionGate({
    semanticFunction: rubric.semanticFunction,
    evalThresholds: rubricToGateThresholds(rubric),
    ...overrides,
  });
}

export function evaluateThreePassGate(gate, candidate) {
  const parsed = validatePromotionGate(gate);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  const decision = evaluatePromotionCandidate(parsed.gate, candidate);
  const allPassed = decision.passFlags.conformance && decision.passFlags.eval && decision.passFlags.policy;

  return {
    schema: EVALS_PROMOTION_GATE_SCHEMA,
    outcome: allPassed ? "promote" : "refuse",
    passFlags: decision.passFlags,
    failures: decision.failures,
    candidateId: decision.candidateId,
    championId: decision.championId,
  };
}

export function gateEventTypesFor(decision) {
  if (decision.outcome === "promote") {
    return ["eval.GatePassed"];
  }
  return ["eval.GateFailed"];
}
