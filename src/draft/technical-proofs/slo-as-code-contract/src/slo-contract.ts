import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";


export const SLO_CONTRACT_SCHEMA = "hobo.slo/v1";
export const SLO_EVENT_SCHEMA = "hobo.slo.event/v1";
export const TELEMETRY_ENVELOPE_SCHEMA = "hobo.telemetry-envelope/v1";
export const OPEN_SLO_API_VERSION = "openslo/v1";

export const SLO_EVENT_TYPES = Object.freeze([
  "slo.Declared",
  "slo.BudgetBurned",
  "slo.BudgetExhausted",
]);

const BUDGETING_METHODS = new Set(["Occurrences", "Timeslices", "RatioTimeslices"]);
const TRACEPARENT_RE = /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/;

export function createGoldenSlo(overrides = {}) {
  return deepMerge(
    {
      schema: SLO_CONTRACT_SCHEMA,
      apiVersion: OPEN_SLO_API_VERSION,
      kind: "SLO",
      metadata: {
        name: "checkout-availability",
        labels: {
          "hobo.dev/scope": "bindle",
        },
      },
      spec: {
        service: "checkout-api",
        indicator: {
          ratioMetric: {
            counter: true,
            good: {
              telemetry: {
                query: "sum(rate(http_requests_total{code=~'2..|3..'}[5m]))",
                unit: "requests",
              },
            },
            total: {
              telemetry: {
                query: "sum(rate(http_requests_total[5m]))",
                unit: "requests",
              },
            },
          },
        },
        timeWindow: {
          duration: "30d",
          isRolling: true,
        },
        budgetingMethod: "Occurrences",
        objectives: [
          {
            displayName: "availability",
            target: 0.99,
          },
        ],
        burnRateThresholds: [
          {
            name: "fast-burn",
            threshold: 14.4,
            lookbackWindow: "5m",
            samplingInterval: "1m",
          },
          {
            name: "slow-burn",
            threshold: 2,
            lookbackWindow: "1h",
            samplingInterval: "5m",
          },
        ],
      },
    },
    overrides,
  );
}

export function parseSloDefinition(candidate) {
  const errors = [];
  const warnings = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["SLO definition must be an object"], warnings, slo: null };
  }

  if (candidate.schema !== SLO_CONTRACT_SCHEMA) {
    errors.push(`schema must be ${SLO_CONTRACT_SCHEMA}`);
  }
  if (candidate.apiVersion !== OPEN_SLO_API_VERSION) {
    errors.push(`apiVersion must be ${OPEN_SLO_API_VERSION}`);
  }
  if (candidate.kind !== "SLO") {
    errors.push("kind must be SLO");
  }
  if (!isNonEmptyString(candidate.metadata?.name)) {
    errors.push("metadata.name must be a non-empty string");
  }
  if (!isNonEmptyString(candidate.spec?.service)) {
    errors.push("spec.service must be a non-empty string");
  }
  if (!BUDGETING_METHODS.has(candidate.spec?.budgetingMethod)) {
    errors.push("spec.budgetingMethod must be Occurrences, Timeslices, or RatioTimeslices");
  }

  validateTimeWindow(candidate.spec?.timeWindow, "spec.timeWindow", errors);
  validateIndicator(candidate.spec?.indicator, "spec.indicator", errors);
  validateObjectives(candidate.spec?.objectives, errors, warnings);
  validateBurnRateThresholds(candidate.spec, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    slo: errors.length === 0 ? sortKeys(candidate) : null,
  };
}

export function serializeSloDefinition(slo) {
  const parsed = parseSloDefinition(slo);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return canonicalJson(parsed.slo);
}

export function deserializeSloDefinition(text) {
  return parseSloDefinition(JSON.parse(text));
}

export function makeSloEvent({ id, type, sloName, seq, data = {}, time = "2026-06-25T00:00:00.000Z" }) {
  return {
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    id,
    type,
    source: "hobo://camp/prod-us",
    subject: `slo/${sloName}`,
    streamId: `slo:${sloName}`,
    seq,
    time,
    meta: {
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    },
    data: {
      schema: SLO_EVENT_SCHEMA,
      sloName,
      ...data,
    },
  };
}

export function validateSloEvent(event) {
  const errors = [];

  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    return { ok: false, errors: ["event envelope must be an object"], event: null };
  }

  validateEnvelope(event, errors);

  if (!SLO_EVENT_TYPES.includes(event.type)) {
    errors.push(`type must be one of ${SLO_EVENT_TYPES.join(", ")}`);
  }
  if (event.data?.schema !== SLO_EVENT_SCHEMA) {
    errors.push(`data.schema must be ${SLO_EVENT_SCHEMA}`);
  }
  if (!isNonEmptyString(event.data?.sloName)) {
    errors.push("data.sloName must be a non-empty string");
  }

  if (event.type === "slo.Declared") {
    if (!isSha256Digest(event.data?.definitionHash)) {
      errors.push("data.definitionHash must be sha256:<64 hex chars>");
    }
  }

  if (event.type === "slo.BudgetBurned") {
    validateBudgetBurnedPayload(event.data, errors);
  }

  if (event.type === "slo.BudgetExhausted" && event.data?.remainingBudgetRatio !== 0) {
    errors.push("data.remainingBudgetRatio must be 0 for slo.BudgetExhausted");
  }

  return {
    ok: errors.length === 0,
    errors,
    event: errors.length === 0 ? sortKeys(event) : null,
  };
}

export function serializeSloEvent(event) {
  const parsed = validateSloEvent(event);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return canonicalJson(parsed.event);
}

export function deserializeSloEvent(text) {
  return validateSloEvent(JSON.parse(text));
}

export function hashSloDefinition(definition) {
  const parsed = parseSloDefinition(definition);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return `sha256:${createHash("sha256").update(canonicalJson(parsed.slo)).digest("hex")}`;
}

export function initialBudgetView(definition) {
  const parsed = parseSloDefinition(definition);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  const target = primaryObjectiveTarget(parsed.slo);
  if (target >= 1) {
    return {
      sloName: parsed.slo.metadata.name,
      gateable: false,
      consumedBudgetRatio: 0,
      remainingBudgetRatio: 0,
      exhausted: false,
      lastSeq: null,
      lastEventId: null,
      reason: "objective-has-no-error-budget",
    };
  }

  return {
    sloName: parsed.slo.metadata.name,
    gateable: true,
    consumedBudgetRatio: 0,
    remainingBudgetRatio: 1,
    exhausted: false,
    lastSeq: null,
    lastEventId: null,
  };
}

export function applyBudgetEvent(view, definition, event) {
  const parsedEvent = validateSloEvent(event);
  if (!parsedEvent.ok) {
    throw new Error(parsedEvent.errors.join("\n"));
  }
  if (!view.gateable || parsedEvent.event.data.sloName !== view.sloName) {
    return view;
  }

  if (parsedEvent.event.type === "slo.BudgetExhausted") {
    return {
      ...view,
      consumedBudgetRatio: 1,
      remainingBudgetRatio: 0,
      exhausted: true,
      lastSeq: parsedEvent.event.seq,
      lastEventId: parsedEvent.event.id,
    };
  }
  if (parsedEvent.event.type !== "slo.BudgetBurned") {
    return view;
  }

  const target = primaryObjectiveTarget(definition);
  const errorBudget = 1 - target;
  const errorRate = (parsedEvent.event.data.total - parsedEvent.event.data.good) / parsedEvent.event.data.total;
  const burnedBudgetRatio = errorRate / errorBudget;
  const consumedBudgetRatio = roundRatio(clamp(view.consumedBudgetRatio + burnedBudgetRatio, 0, 1));
  const remainingBudgetRatio = roundRatio(clamp(1 - consumedBudgetRatio, 0, 1));

  return {
    ...view,
    consumedBudgetRatio,
    remainingBudgetRatio,
    exhausted: remainingBudgetRatio === 0,
    lastSeq: parsedEvent.event.seq,
    lastEventId: parsedEvent.event.id,
  };
}

export function replayBudgetView(definition, events) {
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq || String(a.id).localeCompare(String(b.id)));
  return sortedEvents.reduce(
    (view, event) => applyBudgetEvent(view, definition, event),
    initialBudgetView(definition),
  );
}

export function resolveOverlappingSloConflicts(definitions) {
  const groups = new Map();

  for (const definition of definitions) {
    const parsed = parseSloDefinition(definition);
    if (!parsed.ok) {
      throw new Error(parsed.errors.join("\n"));
    }
    const key = `${parsed.slo.spec.service}|${indicatorIdentity(parsed.slo.spec.indicator)}`;
    const group = groups.get(key) ?? [];
    group.push(parsed.slo);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const sorted = [...group].sort(compareSloPrecedence);
      return {
        key,
        winner: sorted[0].metadata.name,
        candidates: sorted.map((definition) => definition.metadata.name).sort(),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function validateEnvelope(event, errors) {
  if (event.schema !== TELEMETRY_ENVELOPE_SCHEMA) {
    errors.push(`schema must be ${TELEMETRY_ENVELOPE_SCHEMA}`);
  }
  for (const field of ["id", "type", "source", "subject", "streamId", "time"]) {
    if (!isNonEmptyString(event[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }
  if (!TRACEPARENT_RE.test(event.meta?.traceparent ?? "")) {
    errors.push("meta.traceparent must be a W3C traceparent value");
  }
}

function validateTimeWindow(window, path, errors) {
  if (!window || !isJsonObject(window) || Array.isArray(window)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!parseDurationSeconds(window.duration)) {
    errors.push(`${path}.duration must be a duration like 30d or 5m`);
  }
  if (!isJsonBoolean(window.isRolling)) {
    errors.push(`${path}.isRolling must be boolean`);
  }
}

function validateIndicator(indicator, path, errors) {
  const ratioMetric = indicator?.ratioMetric;
  if (!ratioMetric || !isJsonObject(ratioMetric) || Array.isArray(ratioMetric)) {
    errors.push(`${path} must define an SLI source as ratioMetric`);
    return;
  }
  validateTelemetryQuery(ratioMetric.good, `${path}.ratioMetric.good`, errors);
  validateTelemetryQuery(ratioMetric.total, `${path}.ratioMetric.total`, errors);
}

function validateTelemetryQuery(query, path, errors) {
  if (!isNonEmptyString(query?.telemetry?.query)) {
    errors.push(`${path}.telemetry.query must be a non-empty string`);
  }
}

function validateObjectives(objectives, errors, warnings) {
  if (!Array.isArray(objectives) || objectives.length === 0) {
    errors.push("spec.objectives must be a non-empty array");
    return;
  }

  objectives.forEach((objective, index) => {
    const path = `spec.objectives.${index}`;
    if (!isNonEmptyString(objective?.displayName)) {
      errors.push(`${path}.displayName must be a non-empty string`);
    }
    if (!isJsonNumber(objective?.target) || objective.target <= 0 || objective.target > 1) {
      errors.push(`${path}.target must be > 0 and <= 1`);
    }
    if (objective?.target === 1) {
      warnings.push(`${path}.target has no error budget and is ungateable`);
    }
  });
}

function validateBurnRateThresholds(spec, errors) {
  const thresholds = spec?.burnRateThresholds ?? [];
  if (!Array.isArray(thresholds)) {
    errors.push("spec.burnRateThresholds must be an array when present");
    return;
  }

  const timeWindowSeconds = parseDurationSeconds(spec?.timeWindow?.duration);

  thresholds.forEach((threshold, index) => {
    const path = `spec.burnRateThresholds.${index}`;
    const lookbackSeconds = parseDurationSeconds(threshold?.lookbackWindow);
    const samplingSeconds = parseDurationSeconds(threshold?.samplingInterval);

    if (!isNonEmptyString(threshold?.name)) {
      errors.push(`${path}.name must be a non-empty string`);
    }
    if (!isJsonNumber(threshold?.threshold) || threshold.threshold <= 0) {
      errors.push(`${path}.threshold must be > 0`);
    }
    if (!lookbackSeconds) {
      errors.push(`${path}.lookbackWindow must be a duration like 5m`);
    }
    if (!samplingSeconds) {
      errors.push(`${path}.samplingInterval must be a duration like 1m`);
    }
    if (lookbackSeconds && samplingSeconds && lookbackSeconds < samplingSeconds) {
      errors.push(`${path}.lookbackWindow must be >= samplingInterval`);
    }
    if (timeWindowSeconds && samplingSeconds && timeWindowSeconds < samplingSeconds) {
      errors.push(`${path}.samplingInterval must not exceed spec.timeWindow.duration`);
    }
  });
}

function validateBudgetBurnedPayload(data, errors) {
  if (!isNonEmptyString(data?.window)) {
    errors.push("data.window must be a non-empty string");
  }
  if (!Number.isFinite(data?.good) || data.good < 0) {
    errors.push("data.good must be >= 0");
  }
  if (!Number.isFinite(data?.total) || data.total <= 0) {
    errors.push("data.total must be > 0");
  }
  if (Number.isFinite(data?.good) && Number.isFinite(data?.total) && data.good > data.total) {
    errors.push("data.good must be <= data.total");
  }
  if (!Number.isFinite(data?.burnRate) || data.burnRate < 0) {
    errors.push("data.burnRate must be >= 0");
  }
  if (!Number.isFinite(data?.remainingBudgetRatio) || data.remainingBudgetRatio < 0 || data.remainingBudgetRatio > 1) {
    errors.push("data.remainingBudgetRatio must be between 0 and 1");
  }
}

function primaryObjectiveTarget(definition) {
  return definition.spec.objectives[0].target;
}

function compareSloPrecedence(a, b) {
  return (
    primaryObjectiveTarget(b) - primaryObjectiveTarget(a) ||
    parseDurationSeconds(b.spec.timeWindow.duration) - parseDurationSeconds(a.spec.timeWindow.duration) ||
    a.metadata.name.localeCompare(b.metadata.name)
  );
}

function indicatorIdentity(indicator) {
  const ratio = indicator.ratioMetric;
  return canonicalJson({
    good: ratio.good.telemetry.query,
    total: ratio.total.telemetry.query,
  }).trim();
}

function parseDurationSeconds(duration) {
  if (!isJsonString(duration)) {
    return null;
  }
  const match = /^([1-9][0-9]*)(s|m|h|d|w|M|Q|Y)$/.exec(duration);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const units = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    M: 2592000,
    Q: 7776000,
    Y: 31536000,
  };
  return value * units[match[2]];
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isSha256Digest(value) {
  return isJsonString(value) && /^sha256:[a-f0-9]{64}$/.test(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundRatio(value) {
  return Number(value.toFixed(12));
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
