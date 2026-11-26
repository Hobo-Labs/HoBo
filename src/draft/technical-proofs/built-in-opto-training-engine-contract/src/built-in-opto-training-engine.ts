import { createHash } from "node:crypto";

import {
  BUILT_IN_ENGINE_ID,
  TRAINING_CANDIDATE_SCHEMA,
  canonicalJson,
  createTrainingEvent,
  hashTrajectory,
  optimizeTrainingCandidate,
  validateCandidatePatch
} from "../../training-engine-port-contract/src/training-engine-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const BUILT_IN_OPTO_TRAINING_ENGINE_CONTRACT = "hobo.built-in-opto-training-engine/v1";

const STOPWORDS = new Set([
  "about",
  "again",
  "copy",
  "from",
  "general",
  "help",
  "issue",
  "needed",
  "please",
  "question",
  "request",
  "route",
  "status",
  "support",
  "ticket",
  "with"
]);

export function createBuiltInOptoTrainingEngine({ engineId = BUILT_IN_ENGINE_ID } = {}) {
  return Object.freeze({
    engineId,
    optimize(request) {
      const rules = deriveRewriteRules(request);
      const replacement = renderRewriteProgram(rules, request.contract?.invariants?.requiredFallback ?? "general-support");
      const candidateCore = {
        engineId,
        region: structuredClone(request.generatedRegion),
        rules,
        replacement,
        requestId: request.requestId
      };

      return {
        schema: TRAINING_CANDIDATE_SCHEMA,
        id: `candidate-opto-${digest(candidateCore).slice(7, 19)}`,
        engineId,
        region: structuredClone(request.generatedRegion),
        edits: [
          {
            startOffset: request.generatedRegion.startOffset,
            endOffset: request.generatedRegion.endOffset,
            replacement
          }
        ],
        provenance: {
          optimizer: BUILT_IN_OPTO_TRAINING_ENGINE_CONTRACT,
          trajectoryHashes: request.trajectories.map(hashTrajectory),
          rubricRef: request.rubric.id,
          contractRef: request.contract.ref,
          selectedRules: rules
        }
      };
    }
  });
}

export function runBuiltInOptoTrainingRun({ request, heldOutTrajectories, engine = createBuiltInOptoTrainingEngine() }) {
  const optimized = optimizeTrainingCandidate(engine, request);
  if (!optimized.ok) {
    return {
      schema: BUILT_IN_OPTO_TRAINING_ENGINE_CONTRACT,
      outcome: "rejected",
      candidate: null,
      screening: null,
      evaluation: null,
      events: [],
      replayDigest: digest({ requestId: request?.requestId, errors: optimized.errors }),
      rejectionReasons: optimized.errors
    };
  }

  const screening = screenCandidateForPromotion({
    request,
    candidate: optimized.candidate,
    heldOutTrajectories
  });
  const events = trainingRunEvents({ request, candidate: optimized.candidate, screening });

  return {
    schema: BUILT_IN_OPTO_TRAINING_ENGINE_CONTRACT,
    outcome: screening.outcome,
    candidate: optimized.candidate,
    screening,
    evaluation: screening.evaluation,
    events,
    replayDigest: digest({ events }),
    rejectionReasons: screening.rejectionReasons
  };
}

export function screenCandidateForPromotion({ request, candidate, heldOutTrajectories }) {
  const patch = validateCandidatePatch(candidate, request.generatedRegion);
  const patchErrors = patch.ok ? [] : patch.errors;
  const contractCheck = patch.ok ? validateCandidateRewriteContract(candidate, request.contract) : { ok: false, reasons: [] };
  const evaluation = evaluateCandidateOffline({
    candidate,
    heldOutTrajectories,
    rubric: request.rubric,
    conformanceOk: patch.ok && contractCheck.ok
  });

  const rejectionReasons = [
    ...patchErrors,
    ...contractCheck.reasons,
    ...evaluation.rejectionReasons
  ];
  const conformance = patch.ok && contractCheck.ok;
  const heldOutEval = conformance && evaluation.passed;

  return {
    outcome: conformance && heldOutEval ? "ready-for-gate" : "rejected",
    passFlags: {
      conformance,
      heldOutEval
    },
    evaluation,
    rejectionReasons
  };
}

export function evaluateCandidateOffline({ candidate, heldOutTrajectories, rubric, conformanceOk = true }) {
  const trajectories = Array.isArray(heldOutTrajectories) ? heldOutTrajectories : [];
  if (trajectories.length === 0) {
    return {
      baselineScore: 0,
      candidateScore: 0,
      improvement: 0,
      passed: false,
      decisions: [],
      rejectionReasons: ["held-out.required"]
    };
  }

  const program = parseRewriteProgram(candidateReplacement(candidate));
  const decisions = trajectories.map((trajectory) => {
    const expectedRoute = extractExpectedRoute(trajectory);
    const baselineRoute = extractBaselineRoute(trajectory);
    const candidateRoute = predictRoute(program, extractTicket(trajectory));
    return {
      trajectoryId: trajectory.id,
      expectedRoute,
      baselineRoute,
      candidateRoute,
      baselineCorrect: baselineRoute === expectedRoute,
      candidateCorrect: candidateRoute === expectedRoute
    };
  });

  const baselineScore = average(decisions.map((decision) => Number(decision.baselineCorrect)));
  const candidateScore = conformanceOk ? average(decisions.map((decision) => Number(decision.candidateCorrect))) : 0;
  const improvement = candidateScore - baselineScore;
  const minimumImprovement = Number.isFinite(rubric?.minimumImprovement) ? rubric.minimumImprovement : 0;
  const heldOutThreshold = Number.isFinite(rubric?.heldOutThreshold) ? rubric.heldOutThreshold : 0;
  const rejectionReasons = [];

  if (improvement < minimumImprovement) {
    rejectionReasons.push(`held-out.improvement-below:${minimumImprovement}`);
  }
  if (candidateScore < heldOutThreshold) {
    rejectionReasons.push(`held-out.score-below:${heldOutThreshold}`);
  }

  return {
    baselineScore,
    candidateScore,
    improvement,
    passed: rejectionReasons.length === 0,
    decisions,
    rejectionReasons
  };
}

function deriveRewriteRules(request) {
  const byRoute = new Map();
  for (const trajectory of request.trajectories) {
    const expectedRoute = extractExpectedRoute(trajectory);
    if (!expectedRoute || extractBaselineRoute(trajectory) === expectedRoute) {
      continue;
    }

    const routeTokens = byRoute.get(expectedRoute) ?? new Map();
    for (const token of ticketTokens(extractTicket(trajectory))) {
      routeTokens.set(token, (routeTokens.get(token) ?? 0) + 1);
    }
    byRoute.set(expectedRoute, routeTokens);
  }

  return [...byRoute.entries()]
    .map(([route, tokenCounts]) => ({
      route,
      keywords: [...tokenCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 4)
        .map(([token]) => token)
    }))
    .filter((rule) => rule.keywords.length > 0)
    .sort((left, right) => left.route.localeCompare(right.route));
}

function renderRewriteProgram(rules, fallbackRoute) {
  const lines = [
    "// hobo:opto-rules v1",
    "const normalized = ticket.toLowerCase();"
  ];

  for (const rule of rules) {
    lines.push(
      `if (${JSON.stringify(rule.keywords)}.some((keyword) => normalized.includes(keyword))) return ${JSON.stringify(rule.route)};`
    );
  }

  lines.push(`return ${JSON.stringify(fallbackRoute)};`);
  return lines.join("\n");
}

function validateCandidateRewriteContract(candidate, contract) {
  const program = parseRewriteProgram(candidateReplacement(candidate));
  const allowedRoutes = new Set(contract?.invariants?.allowedRoutes ?? []);
  const forbiddenOutputs = new Set(contract?.invariants?.forbiddenOutputs ?? []);
  const reasons = [...program.parseErrors];

  for (const route of program.returnedRoutes) {
    if (forbiddenOutputs.has(route)) {
      reasons.push(`contract.forbidden-output:${route}`);
    }
    if (allowedRoutes.size > 0 && !allowedRoutes.has(route)) {
      reasons.push(`contract.unapproved-output:${route}`);
    }
  }

  const requiredFallback = contract?.invariants?.requiredFallback;
  if (requiredFallback && program.fallback !== requiredFallback) {
    reasons.push(`contract.required-fallback:${requiredFallback}`);
  }
  if (program.rules.length === 0) {
    reasons.push("contract.rules-required");
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

function candidateReplacement(candidate) {
  if (!Array.isArray(candidate?.edits)) {
    return "";
  }
  return candidate.edits.map((edit) => (isJsonString(edit?.replacement) ? edit.replacement : "")).join("\n");
}

function parseRewriteProgram(source) {
  const rules = [];
  const parseErrors = [];
  const rulePattern =
    /^if \((\[[^\]]+\])\.some\(\(keyword\) => normalized\.includes\(keyword\)\)\) return "([^"]+)";$/gm;
  for (const match of source.matchAll(rulePattern)) {
    try {
      const keywords = JSON.parse(match[1]);
      if (!Array.isArray(keywords) || keywords.some((keyword) => !isJsonString(keyword) || keyword.length === 0)) {
        parseErrors.push("contract.keyword-list-invalid");
        continue;
      }
      rules.push({ keywords, route: match[2] });
    } catch {
      parseErrors.push("contract.keyword-list-invalid");
    }
  }

  const returnedRoutes = [...source.matchAll(/return "([^"]+)";/g)].map((match) => match[1]);
  return {
    rules,
    fallback: returnedRoutes.at(-1),
    returnedRoutes: [...new Set(returnedRoutes)],
    parseErrors
  };
}

function predictRoute(program, ticket) {
  const normalized = ticket.toLowerCase();
  for (const rule of program.rules) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.route;
    }
  }
  return program.fallback;
}

function trainingRunEvents({ request, candidate, screening }) {
  const runId = request.requestId;
  return [
    createTrainingEvent({
      id: `${runId}-started`,
      type: "training.RunStarted",
      runId,
      seq: 0,
      data: {
        requestId: request.requestId,
        engineId: candidate.engineId
      }
    }),
    createTrainingEvent({
      id: `${runId}-candidate-proposed`,
      type: "training.CandidateProposed",
      runId,
      seq: 1,
      data: { candidate }
    }),
    createTrainingEvent({
      id: `${runId}-candidate-evaluated`,
      type: "training.CandidateEvaluated",
      runId,
      seq: 2,
      data: {
        candidateId: candidate.id,
        conformance: {
          ok: screening.passFlags.conformance,
          errors: screening.rejectionReasons
        },
        heldOutEval: screening.evaluation
      }
    })
  ];
}

function extractTicket(trajectory) {
  return (
    payloadValue(trajectory, "ticket") ??
    trajectory.spans?.[0]?.inputs?.ticket ??
    trajectory.spans?.[0]?.attributes?.["input.value"] ??
    ""
  );
}

function extractExpectedRoute(trajectory) {
  return payloadValue(trajectory, "expectedRoute");
}

function extractBaselineRoute(trajectory) {
  return payloadValue(trajectory, "baselineRoute") ?? trajectory.spans?.[0]?.outputs?.route;
}

function payloadValue(trajectory, key) {
  const payload = trajectory.payloads?.[key];
  if (!payload || !isJsonObject(payload)) {
    return undefined;
  }
  return isJsonString(payload.value) ? payload.value : undefined;
}

function ticketTokens(ticket) {
  return [...new Set(ticket.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (token) => token.length >= 4 && !STOPWORDS.has(token)
  );
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
