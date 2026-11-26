import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
export const EVAL_PROMOTION_GATE_SCHEMA = "hobo.eval-promotion-gate/v1";
export const EVAL_EVENT_SCHEMA = "hobo.eval.event/v1";
export const TELEMETRY_ENVELOPE_SCHEMA = "hobo.telemetry-envelope/v1";

const EVAL_EVENT_TYPES = new Set(["eval.Ran", "eval.GatePassed", "eval.GateFailed"]);
const HARD_SAFETY_DIMENSIONS = ["piiSafe"];
const DEFAULT_TRACEPARENT = "00-00000000000000000000000000000001-0000000000000001-01";

export function createClassifyTicketPromotionGate(overrides = {}) {
  return deepMerge(
    {
      schema: EVAL_PROMOTION_GATE_SCHEMA,
      semanticFunction: "classifyTicket",
      requireConformance: true,
      evalThresholds: {
        categoryCorrect: 0.92,
        urgencyCalibrated: 0.9,
        piiSafe: 1,
      },
      shadowTraffic: "10%",
      minSamples: 1000,
      policy: "promote.semantic.prod",
    },
    overrides,
  );
}

export function validatePromotionGate(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["promotionGate must be an object"], gate: null };
  }

  if (candidate.schema !== EVAL_PROMOTION_GATE_SCHEMA) {
    errors.push(`schema must be ${EVAL_PROMOTION_GATE_SCHEMA}`);
  }
  if (!isNonEmptyString(candidate.semanticFunction)) {
    errors.push("semanticFunction must be a non-empty string");
  }
  if (candidate.requireConformance !== true) {
    errors.push("requireConformance must be true");
  }
  validateThresholds(candidate.evalThresholds, errors);
  if (!isPercent(candidate.shadowTraffic)) {
    errors.push("shadowTraffic must be a percentage string like 10%");
  }
  if (!Number.isInteger(candidate.minSamples) || candidate.minSamples <= 0) {
    errors.push("minSamples must be a positive integer");
  }
  if (!isNonEmptyString(candidate.policy)) {
    errors.push("policy must be a non-empty string");
  }

  return {
    ok: errors.length === 0,
    errors,
    gate: errors.length === 0 ? sortKeys(candidate) : null,
  };
}

export function evaluatePromotionCandidate(gate, candidate) {
  const parsedGate = validatePromotionGate(gate);
  if (!parsedGate.ok) {
    throw new Error(parsedGate.errors.join("\n"));
  }

  const failures = [];
  const conformancePassed = candidate?.conformance?.passed === true;
  if (!conformancePassed) {
    failures.push("conformance did not pass");
  }

  if (!Number.isInteger(candidate?.samples) || candidate.samples < parsedGate.gate.minSamples) {
    failures.push(`samples below minSamples ${parsedGate.gate.minSamples}`);
  }

  for (const [name, threshold] of Object.entries(parsedGate.gate.evalThresholds)) {
    const score = candidate?.scores?.[name];
    if (!isJsonNumber(score) || score < threshold) {
      failures.push(`${name} below ${threshold}`);
    }
  }

  const policyPassed = candidate?.policy?.effect === "allow";
  if (!policyPassed) {
    failures.push("policy did not allow promotion");
  }

  const evalPassed = failures.every(
    (failure) => failure === "conformance did not pass" || failure === "policy did not allow promotion",
  );
  const passFlags = {
    conformance: conformancePassed,
    eval: evalPassed,
    policy: policyPassed,
  };

  return {
    candidateId: candidate?.candidateId,
    championId: candidate?.championId,
    outcome: Object.values(passFlags).every(Boolean) ? "promote" : "stay-shadow",
    passFlags,
    failures,
  };
}

export function makeEvalEvent({ id, type, semanticFunction, candidateId, seq, data = {}, time = "2026-06-25T00:00:00.000Z" }) {
  return {
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    id,
    type,
    source: `hobo://semantic-function/${semanticFunction}`,
    subject: `semantic-function/${semanticFunction}`,
    streamId: `eval:${semanticFunction}:${candidateId}`,
    seq,
    time,
    meta: {
      traceparent: DEFAULT_TRACEPARENT,
    },
    data: {
      schema: EVAL_EVENT_SCHEMA,
      semanticFunction,
      candidateId,
      ...data,
    },
  };
}

export function validateEvalEvent(event) {
  const errors = [];

  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    return { ok: false, errors: ["event must be an object"], event: null };
  }

  if (event.schema !== TELEMETRY_ENVELOPE_SCHEMA) {
    errors.push(`schema must be ${TELEMETRY_ENVELOPE_SCHEMA}`);
  }
  if (!isNonEmptyString(event.id)) {
    errors.push("id must be a non-empty string");
  }
  if (!EVAL_EVENT_TYPES.has(event.type)) {
    errors.push("type must be eval.Ran, eval.GatePassed, or eval.GateFailed");
  }
  if (!isNonEmptyString(event.source)) {
    errors.push("source must be a non-empty string");
  }
  if (!isNonEmptyString(event.subject)) {
    errors.push("subject must be a non-empty string");
  }
  if (!isNonEmptyString(event.streamId)) {
    errors.push("streamId must be a non-empty string");
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }
  if (!isIsoDateTime(event.time)) {
    errors.push("time must be an ISO timestamp");
  }
  if (!event.meta || !isJsonObject(event.meta) || !isTraceparent(event.meta.traceparent)) {
    errors.push("meta.traceparent must be a W3C traceparent");
  }

  validateEvalEventData(event.type, event.data, errors);

  return {
    ok: errors.length === 0,
    errors,
    event: errors.length === 0 ? sortKeys(event) : null,
  };
}

export function serializeEvalEvent(event) {
  const parsed = validateEvalEvent(event);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return canonicalJson(parsed.event);
}

export function deserializeEvalEvent(serialized) {
  const event = JSON.parse(serialized);
  const parsed = validateEvalEvent(event);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return parsed.event;
}

function validateEvalEventData(type, data, errors) {
  if (!data || !isJsonObject(data) || Array.isArray(data)) {
    errors.push("data must be an object");
    return;
  }

  if (data.schema !== EVAL_EVENT_SCHEMA) {
    errors.push(`data.schema must be ${EVAL_EVENT_SCHEMA}`);
  }
  if (!isNonEmptyString(data.semanticFunction)) {
    errors.push("data.semanticFunction must be a non-empty string");
  }
  if (!isNonEmptyString(data.candidateId)) {
    errors.push("data.candidateId must be a non-empty string");
  }

  if (type === "eval.Ran") {
    if (!Number.isInteger(data.samples) || data.samples <= 0) {
      errors.push("data.samples must be a positive integer");
    }
    validateScores(data.scores, "data.scores", errors);
    return;
  }

  validateDecisionData(type, data, errors);
}

function validateDecisionData(type, data, errors) {
  if (!["promote", "stay-shadow"].includes(data.outcome)) {
    errors.push("data.outcome must be promote or stay-shadow");
  }
  if (!data.passFlags || !isJsonObject(data.passFlags)) {
    errors.push("data.passFlags must be an object");
    return;
  }

  const flags = ["conformance", "eval", "policy"];
  for (const flag of flags) {
    if (!isJsonBoolean(data.passFlags[flag])) {
      errors.push(`data.passFlags.${flag} must be boolean`);
    }
  }

  if (type === "eval.GatePassed") {
    if (data.outcome !== "promote") {
      errors.push("eval.GatePassed outcome must be promote");
    }
    if (!flags.every((flag) => data.passFlags[flag] === true)) {
      errors.push("eval.GatePassed requires all pass flags true");
    }
    if (Array.isArray(data.failures) && data.failures.length > 0) {
      errors.push("eval.GatePassed must not include failures");
    }
  }

  if (type === "eval.GateFailed") {
    if (data.outcome !== "stay-shadow") {
      errors.push("eval.GateFailed outcome must be stay-shadow");
    }
    if (flags.every((flag) => data.passFlags[flag] === true)) {
      errors.push("eval.GateFailed requires at least one failed pass flag");
    }
    if (!Array.isArray(data.failures) || data.failures.length === 0) {
      errors.push("eval.GateFailed requires failures");
    }
  }
}

function validateScores(scores, path, errors) {
  if (!scores || !isJsonObject(scores) || Array.isArray(scores)) {
    errors.push(`${path} must be an object`);
    return;
  }

  for (const [name, score] of Object.entries(scores)) {
    if (!isNonEmptyString(name)) {
      errors.push(`${path} keys must be non-empty strings`);
    }
    if (!isJsonNumber(score) || score < 0 || score > 1) {
      errors.push(`${path}.${name} must be between 0 and 1`);
    }
  }
}

function validateThresholds(thresholds, errors) {
  if (!thresholds || !isJsonObject(thresholds) || Array.isArray(thresholds)) {
    errors.push("evalThresholds must be an object");
    return;
  }

  for (const [name, threshold] of Object.entries(thresholds)) {
    if (!isNonEmptyString(name)) {
      errors.push("evalThresholds keys must be non-empty strings");
    }
    if (!isJsonNumber(threshold) || threshold < 0 || threshold > 1) {
      errors.push(`evalThresholds.${name} must be between 0 and 1`);
    }
  }

  for (const dimension of HARD_SAFETY_DIMENSIONS) {
    if (!Object.hasOwn(thresholds, dimension)) {
      errors.push(`hard safety dimension ${dimension} is required`);
    } else if (thresholds[dimension] !== 1) {
      errors.push(`${dimension} must be 1`);
    }
  }
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isPercent(value) {
  return isJsonString(value) && /^(0|[1-9][0-9]?|100)%$/.test(value);
}

function isTraceparent(value) {
  return isJsonString(value) && /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value);
}

function isIsoDateTime(value) {
  return isJsonString(value) && !Number.isNaN(Date.parse(value));
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? structuredClone(base) : structuredClone(overrides);
  }
  if (!base || !isJsonObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const output = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
