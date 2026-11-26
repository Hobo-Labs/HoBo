import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const GUARDRAIL_CONTRACT_SCHEMA = "hobo.guardrail-policy-gate/v1";
export const POLICY_DECISION_SCHEMA = "hobo.policy-ir.decision/v1";

const RELEASING_EFFECTS = new Set(["allow", "allow-degraded", "warn", "mutate"]);
const FAILING_CHECK_STATUSES = new Set(["fail", "error"]);

export function decideGuardrailStep(input) {
  const run = parseGuardrailRun(input);
  const failures = run.checks.filter((check) => FAILING_CHECK_STATUSES.has(check.status));
  const policyDecision = makeGuardrailPolicyDecision(run, failures);
  const events = [
    makeEvent(run, 1, "policy.Decided", {
      request: makeGuardrailPolicyRequest(run),
      decision: policyDecision,
    }),
  ];

  if (failures.length > 0) {
    events.push(makeEvent(run, 2, "guardrail.Blocked", {
      outputId: run.outputId,
      reason: policyDecision.reason,
      checks: failures,
      decisionEffect: policyDecision.effect,
      outputReleased: false,
    }));
  } else {
    events.push(makeEvent(run, 2, "guardrail.Passed", {
      outputId: run.outputId,
      outputReleased: true,
    }));
  }

  return {
    effect: guardrailEffect(policyDecision.effect),
    policyDecision,
    events,
  };
}

export function rebuildGuardrailRun(eventsInput) {
  const events = sortEvents(eventsInput);
  const state = {
    policyDecision: null,
    blocked: null,
    passed: null,
    released: false,
    obligationsSatisfied: new Map(),
  };

  for (const event of events) {
    switch (event.type) {
      case "policy.Decided":
        state.policyDecision = event.data.decision;
        break;
      case "guardrail.Blocked":
        state.blocked = event.data;
        state.released = false;
        break;
      case "guardrail.Passed":
        state.passed = event.data;
        state.released = true;
        break;
      case "policy.ObligationSatisfied":
        state.obligationsSatisfied.set(event.data.id, event.data);
        break;
      default:
        throw new Error(`unknown guardrail event type: ${event.type}`);
    }
  }

  return state;
}

export function releaseGuardedOutput(eventsInput) {
  const rebuilt = rebuildGuardrailRun(eventsInput);
  const decision = rebuilt.policyDecision;

  if (!decision) {
    return { released: false, reason: "missing policy.Decided" };
  }

  if (decision.effect === "require-approval") {
    const required = decision.obligations.find((obligation) => obligation.kind === "require-approval");
    const satisfied = required && rebuilt.obligationsSatisfied.get(required.id);
    const matchesEffect = satisfied?.effectRef === required.effectRef;
    return {
      released: Boolean(satisfied && matchesEffect),
      reason: satisfied && matchesEffect ? "approval satisfied" : "approval obligation unsatisfied",
    };
  }

  if (rebuilt.blocked && decision.effect === "mutate") {
    return { released: false, reason: "redaction required before release" };
  }

  if (rebuilt.blocked) {
    return { released: false, reason: decision.reason };
  }

  if (RELEASING_EFFECTS.has(decision.effect)) {
    return {
      released: rebuilt.passed?.outputReleased === true,
      reason: rebuilt.passed?.outputReleased === true ? decision.reason : "missing guardrail.Passed",
    };
  }

  return { released: false, reason: decision.reason };
}

export function decidePromptPromotion(input) {
  const candidate = parsePromotionCandidate(input);
  const lensResults = evaluatePromotionLenses(candidate.lenses);
  const failedLens = Object.entries(lensResults).find(([, result]) => result.passed !== true);
  const promote = failedLens === undefined;
  const policyDecision = {
    schemaVersion: POLICY_DECISION_SCHEMA,
    effect: promote ? "allow" : "deny",
    reason: promote ? "all promotion lenses passed" : `${failedLens[0]} lens failed`,
    violations: promote ? [] : failedLens[1].violations,
    mutations: [],
    approvals: [],
    obligations: [],
    evidence: {
      engine: "hobo.guardrail-policy-gate/contract@0.1.0",
      inputHash: hashJson({
        candidateId: candidate.candidateId,
        championId: candidate.championId,
        lenses: candidate.lenses,
      }),
      policyIds: ["guardrail-coverage-contract", "four-lens-promotion-gate"],
    },
  };
  const events = [
    makePromotionEvent(candidate, 1, "policy.Decided", {
      request: makePromotionPolicyRequest(candidate),
      decision: policyDecision,
    }),
    makePromotionEvent(candidate, 2, "model.PromotionGateDecided", {
      candidateId: candidate.candidateId,
      championId: candidate.championId,
      promote,
      lensResults,
      decision: policyDecision,
    }),
  ];

  if (promote) {
    events.push(makePromotionEvent(candidate, 3, "model.Promoted", {
      candidateId: candidate.candidateId,
      championId: candidate.championId,
      reason: policyDecision.reason,
    }));
  }

  return {
    promote,
    policyDecision,
    lensResults,
    events,
  };
}

export function rebuildPromotionDecision(eventsInput) {
  const events = sortEvents(eventsInput);
  const state = {
    policyDecision: null,
    promote: false,
    lensResults: {},
    promoted: null,
  };

  for (const event of events) {
    switch (event.type) {
      case "policy.Decided":
        state.policyDecision = event.data.decision;
        break;
      case "model.PromotionGateDecided":
        state.promote = event.data.promote;
        state.lensResults = event.data.lensResults;
        break;
      case "model.Promoted":
        state.promoted = event.data;
        state.promote = true;
        break;
      default:
        throw new Error(`unknown promotion event type: ${event.type}`);
    }
  }

  return state;
}

function makeGuardrailPolicyRequest(run) {
  return {
    schemaVersion: "hobo.policy-ir/v1",
    subject: run.subject,
    action: "ai.output.guardrail",
    resource: {
      kind: "ai-output",
      id: run.outputId,
    },
    phase: run.phase,
    context: {
      checks: run.checks,
      outputId: run.outputId,
    },
  };
}

function makePromotionPolicyRequest(candidate) {
  return {
    schemaVersion: "hobo.policy-ir/v1",
    subject: candidate.subject,
    action: "model.prompt.promote",
    resource: {
      kind: "prompt",
      id: candidate.candidateId,
    },
    phase: "promote",
    context: {
      championId: candidate.championId,
      lenses: candidate.lenses,
    },
  };
}

function makeGuardrailPolicyDecision(run, failures) {
  if (failures.length === 0) {
    return makeDecision({
      effect: "allow",
      reason: "guardrail checks passed",
      input: run,
      policyIds: ["guardrail-output-step"],
    });
  }

  const failingRails = failures.map((failure) => failure.rail);
  const effect = normalizePolicyEffect(run.policyEffect);
  const obligation =
    effect === "require-approval"
      ? [{
          kind: "require-approval",
          id: `approval:${run.outputId}`,
          effectRef: `guardrail:${run.outputId}`,
          deadline: "PT30M",
        }]
      : [];

  return makeDecision({
    effect,
    reason: `guardrail failure: ${failingRails.join(",")}`,
    input: run,
    policyIds: ["guardrail-output-step"],
    violations: failures.map((failure) =>
      `${failure.rail}: ${failure.finding ?? failure.status}`,
    ),
    obligations: obligation,
  });
}

function makeDecision({
  effect,
  reason,
  input,
  policyIds,
  violations = [],
  obligations = [],
}) {
  return {
    schemaVersion: POLICY_DECISION_SCHEMA,
    effect,
    reason,
    violations,
    mutations: [],
    approvals: [],
    obligations,
    evidence: {
      engine: "hobo.guardrail-policy-gate/contract@0.1.0",
      inputHash: hashJson(input),
      policyIds,
    },
  };
}

function guardrailEffect(policyEffect) {
  if (policyEffect === "require-approval") {
    return "require-approval";
  }
  if (policyEffect === "mutate") {
    return "redact";
  }
  if (RELEASING_EFFECTS.has(policyEffect)) {
    return "allow";
  }
  return "block";
}

function evaluatePromotionLenses(lenses) {
  return {
    contract: evaluateContractLens(lenses.contract),
    eval: evaluateEvalLens(lenses.eval),
    policy: evaluatePolicyLens(lenses.policy),
    trace: evaluateTraceLens(lenses.trace),
  };
}

function evaluateContractLens(lens) {
  if (!lens?.guardrailCoverage) {
    return {
      passed: false,
      missingRails: [],
      violations: ["guardrail coverage contract is missing"],
    };
  }

  const champion = uniqueSorted(lens.guardrailCoverage.champion ?? []);
  const candidate = new Set(lens.guardrailCoverage.candidate ?? []);
  const missingRails = champion.filter((rail) => !candidate.has(rail));

  return {
    passed: missingRails.length === 0,
    missingRails,
    violations: missingRails.map((rail) => `candidate removed guardrail coverage: ${rail}`),
  };
}

function evaluateEvalLens(lens) {
  if (!lens) {
    return {
      passed: false,
      violations: ["eval lens is missing"],
    };
  }
  const championScore = assertNumber(lens.championScore, "eval.championScore");
  const candidateScore = assertNumber(lens.candidateScore, "eval.candidateScore");
  const minDelta = assertNumber(lens.minDelta ?? 0, "eval.minDelta");
  const delta = candidateScore - championScore;

  return {
    passed: delta >= minDelta,
    delta,
    violations: delta >= minDelta ? [] : [`eval delta ${delta} below ${minDelta}`],
  };
}

function evaluatePolicyLens(lens) {
  if (!lens) {
    return {
      passed: false,
      violations: ["policy lens is missing"],
    };
  }
  const effect = normalizePolicyEffect(lens.effect);
  return {
    passed: RELEASING_EFFECTS.has(effect),
    effect,
    violations: RELEASING_EFFECTS.has(effect) ? [] : [`policy effect ${effect} blocks promotion`],
  };
}

function evaluateTraceLens(lens) {
  const ref = lens?.openInferenceTrajectory;
  return {
    passed: isJsonString(ref) && ref.trim() !== "",
    openInferenceTrajectory: ref,
    violations: isJsonString(ref) && ref.trim() !== "" ? [] : ["trace lens lacks OpenInference trajectory"],
  };
}

function parseGuardrailRun(input) {
  const run = expectObject(input, "$");
  return {
    runId: expectString(run.runId, "$.runId"),
    outputId: expectString(run.outputId, "$.outputId"),
    subject: parseSubject(run.subject),
    phase: expectString(run.phase, "$.phase"),
    checks: parseChecks(run.checks),
    policyEffect: run.policyEffect ?? "deny",
    ts: expectIso(run.ts, "$.ts"),
  };
}

function parsePromotionCandidate(input) {
  const candidate = expectObject(input, "$");
  return {
    runId: expectString(candidate.runId, "$.runId"),
    candidateId: expectString(candidate.candidateId, "$.candidateId"),
    championId: expectString(candidate.championId, "$.championId"),
    subject: parseSubject(candidate.subject),
    lenses: expectObject(candidate.lenses ?? {}, "$.lenses"),
    ts: expectIso(candidate.ts, "$.ts"),
  };
}

function parseChecks(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("checks must be a non-empty array");
  }
  return input.map((check, index) => {
    const parsed = expectObject(check, `$.checks[${index}]`);
    const status = expectString(parsed.status, `$.checks[${index}].status`);
    if (!["pass", "fail", "error"].includes(status)) {
      throw new Error(`unknown guardrail status: ${status}`);
    }
    return {
      rail: expectString(parsed.rail, `$.checks[${index}].rail`),
      status,
      ...(parsed.finding ? { finding: expectString(parsed.finding, `$.checks[${index}].finding`) } : undefined),
    };
  });
}

function parseSubject(input) {
  const subject = expectObject(input, "$.subject");
  return {
    kind: expectString(subject.kind, "$.subject.kind"),
    id: expectString(subject.id, "$.subject.id"),
  };
}

function makeEvent(run, seq, type, data) {
  return {
    id: `${run.runId}:${seq}:${type}`,
    type,
    v: 1,
    schemaVersion: GUARDRAIL_CONTRACT_SCHEMA,
    streamId: `guardrail:${run.outputId}`,
    seq,
    ts: run.ts,
    correlationId: run.runId,
    data,
  };
}

function makePromotionEvent(candidate, seq, type, data) {
  return {
    id: `${candidate.runId}:${seq}:${type}`,
    type,
    v: 1,
    schemaVersion: GUARDRAIL_CONTRACT_SCHEMA,
    streamId: `model-promotion:${candidate.runId}`,
    seq,
    ts: candidate.ts,
    correlationId: candidate.runId,
    data,
  };
}

function sortEvents(eventsInput) {
  if (!Array.isArray(eventsInput)) {
    throw new Error("events must be an array");
  }
  return [...eventsInput].sort((left, right) => left.seq - right.seq);
}

function normalizePolicyEffect(effect) {
  if (["allow", "allow-degraded", "deny", "warn", "mutate", "require-approval"].includes(effect)) {
    return effect;
  }
  return "deny";
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function assertNumber(value, path) {
  if (!isJsonNumber(value) || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function expectObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function expectString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function expectIso(value, path) {
  const parsed = expectString(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
  return parsed;
}
