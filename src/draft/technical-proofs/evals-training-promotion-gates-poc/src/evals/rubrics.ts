export const EVALS_TRAINING_PROMOTION_GATES_SCHEMA = "hobo.evals-training-promotion-gates/v1";

export const CLASSIFY_TICKET_RUBRIC = Object.freeze({
  id: "rubric://support/classifier@1.0.0",
  semanticFunction: "classifyTicket",
  thresholds: {
    categoryCorrect: 0.92,
    urgencyCalibrated: 0.9,
    piiSafe: 1,
  },
});

export function listRubrics() {
  return [structuredClone(CLASSIFY_TICKET_RUBRIC)];
}

export function resolveRubric(ref) {
  const rubric = listRubrics().find((entry) => entry.id === ref);
  if (!rubric) {
    throw new Error(`unknown rubric: ${ref}`);
  }
  return rubric;
}

export function rubricToGateThresholds(rubric) {
  return structuredClone(rubric.thresholds);
}
