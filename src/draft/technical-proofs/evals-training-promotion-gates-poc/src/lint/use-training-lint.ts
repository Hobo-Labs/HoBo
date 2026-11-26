import { isJsonString } from "../json.js";
export const USE_TRAINING_LINT_SCHEMA = "hobo.lint.use-training/v1";

const REQUIRED_GROUNDINGS = ["intent", "contract", "rubric"] as const;

export function lintUseTrainingSource(source) {
  if (!isJsonString(source) || source.length === 0) {
    throw new TypeError("source must be a non-empty string");
  }

  if (!source.includes('"use training"') && !source.includes("'use training'")) {
    return { schema: USE_TRAINING_LINT_SCHEMA, ok: true, findings: [] };
  }

  const findings = [];
  const hasIntent = /@intent\b/.test(source) || /\bintent\s*:/.test(source);
  const hasContract = /\bcontract\s*:/.test(source) || /\bContract\b/.test(source) || /contractRef/.test(source);
  const hasRubric = /\brubric\s*:/.test(source) || /rubricRef/.test(source) || /categoryCorrect/.test(source);

  if (!hasIntent) {
    findings.push(finding("intent", "missing @intent docstring or training() intent option"));
  }
  if (!hasContract) {
    findings.push(finding("contract", "missing contract grounding (contract: or Contract type)"));
  }
  if (!hasRubric) {
    findings.push(finding("rubric", "missing rubric thresholds or rubricRef"));
  }

  return {
    schema: USE_TRAINING_LINT_SCHEMA,
    ok: findings.length === 0,
    findings,
    required: [...REQUIRED_GROUNDINGS],
  };
}

function finding(kind, message) {
  return { kind, message, severity: "error" };
}
