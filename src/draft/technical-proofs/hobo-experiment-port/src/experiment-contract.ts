import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
const maxBasisPoints = 10_000;

const validMetricKinds = new Set(["counter", "gauge", "histogram", "duration", "ratio"]);
const validVerdicts = new Set(["inconclusive", "promote", "rollback", "needs-human"]);
const validEventTypes = new Set([
  "experiment.Assigned",
  "experiment.Exposed",
  "experiment.Concluded"
]);

export class ExperimentContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ExperimentContractError";
    this.code = code;
  }
}

export function validateExperimentDefinition(definition) {
  assertObject(definition, "experiment definition");
  assertNonEmptyString(definition.key, "experiment key");
  assertNonEmptyString(definition.flagKey, "flag key");
  assertBasisPoints(definition.sampleRatioBasisPoints, "sample ratio");

  if (!Array.isArray(definition.variants) || definition.variants.length < 2) {
    throw new TypeError("experiment definition requires at least two variants");
  }

  let allocationTotal = 0;
  const variantKeys = new Set();
  for (const variant of definition.variants) {
    assertNonEmptyString(variant.key, "variant key");
    assertNonEmptyString(variant.flagVariant, "flag variant");
    assertBasisPoints(variant.allocationBasisPoints, "variant allocation");
    if (variantKeys.has(variant.key)) {
      throw new TypeError(`duplicate variant key: ${variant.key}`);
    }
    variantKeys.add(variant.key);
    allocationTotal += variant.allocationBasisPoints;
  }

  if (allocationTotal > maxBasisPoints) {
    throw new TypeError("variant allocations exceed 100 percent");
  }

  if (!Array.isArray(definition.metrics) || definition.metrics.length === 0) {
    throw new TypeError("experiment definition requires at least one metric");
  }

  let primaryCount = 0;
  for (const metric of definition.metrics) {
    assertNonEmptyString(metric.name, "metric name");
    assertNonEmptyString(metric.source, "metric source");
    if (!validMetricKinds.has(metric.kind)) {
      throw new TypeError(`unknown metric kind: ${metric.kind}`);
    }
    if (metric.primary) {
      primaryCount += 1;
    }
  }

  if (primaryCount !== 1) {
    throw new TypeError("experiment definition requires exactly one primary metric");
  }

  return definition;
}

export function roundTripDefinition(definition) {
  validateExperimentDefinition(definition);
  return JSON.parse(JSON.stringify(definition));
}

export function assign(definition, request) {
  validateExperimentDefinition(definition);
  assertObject(request, "assignment request");
  if (request.experimentKey !== definition.key) {
    throw new TypeError("assignment request experiment key must match definition");
  }
  assertPrincipalRef(request.subject);

  const variant = pickVariant(definition.variants, request.contextHash);
  return {
    experimentKey: definition.key,
    subject: request.subject,
    variantKey: variant.key,
    flagKey: definition.flagKey,
    flagVariant: variant.flagVariant,
    sampled: isSampled(definition.sampleRatioBasisPoints, request.contextHash),
    reason: "split"
  };
}

export function recordExposure(assignment, input = {}) {
  assertObject(assignment, "assignment");
  const subject = input.subject ?? assignment.subject;
  assertPrincipalRef(subject);

  if (!sameSubject(subject, assignment.subject)) {
    throw new ExperimentContractError(
      "unassigned-subject",
      "experiment.Exposed subject must match assignment"
    );
  }

  if (input.experimentKey && input.experimentKey !== assignment.experimentKey) {
    throw new TypeError("experiment.Exposed experiment key must match assignment");
  }

  if (input.variantKey && input.variantKey !== assignment.variantKey) {
    throw new TypeError("experiment.Exposed variant key must match assignment");
  }

  return {
    experimentKey: assignment.experimentKey,
    subject,
    variantKey: assignment.variantKey,
    sampled: Boolean(assignment.sampled),
    occurredAt: input.occurredAt ?? new Date(0).toISOString()
  };
}

export function conclude(definition, input = {}) {
  validateExperimentDefinition(definition);
  const verdict = input.verdict ?? "inconclusive";
  if (!validVerdicts.has(verdict)) {
    throw new TypeError(`unknown analysis verdict: ${verdict}`);
  }

  if (input.winningVariant !== undefined) {
    const hasWinner = definition.variants.some((variant) => variant.key === input.winningVariant);
    if (!hasWinner) {
      throw new TypeError("winning variant must be part of experiment definition");
    }
  }

  const confidence = input.confidence ?? 0;
  if (!isJsonNumber(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError("analysis confidence must be between 0 and 1");
  }

  return {
    experimentKey: definition.key,
    verdict,
    winningVariant: input.winningVariant,
    confidence,
    reason: input.reason ?? "analysis pending"
  };
}

export function createExperimentEvent(type, data) {
  if (!validEventTypes.has(type)) {
    throw new TypeError(`unknown experiment event type: ${type}`);
  }
  assertObject(data, "event data");
  validateEventData(type, data);
  return {
    type,
    source: "hobo:experiment",
    specversion: "1.0",
    time: data.occurredAt ?? new Date(0).toISOString(),
    data
  };
}

function validateEventData(type, data) {
  assertNonEmptyString(data.experimentKey, "event experiment key");

  if (type === "experiment.Assigned" || type === "experiment.Exposed") {
    assertPrincipalRef(data.subject);
    assertNonEmptyString(data.variantKey, "event variant key");
    if (!isJsonBoolean(data.sampled)) {
      throw new TypeError(`${type} requires sampled marker`);
    }
  }

  if (type === "experiment.Assigned") {
    assertNonEmptyString(data.flagKey, "assignment flag key");
    assertNonEmptyString(data.flagVariant, "assignment flag variant");
    if (!["split", "holdout", "override", "default"].includes(data.reason)) {
      throw new TypeError(`unknown assignment reason: ${data.reason}`);
    }
  }

  if (type === "experiment.Concluded") {
    if (!validVerdicts.has(data.verdict)) {
      throw new TypeError(`unknown analysis verdict: ${data.verdict}`);
    }
    if (!isJsonNumber(data.confidence) || data.confidence < 0 || data.confidence > 1) {
      throw new TypeError("analysis confidence must be between 0 and 1");
    }
  }
}

function pickVariant(variants, contextHash = "") {
  const total = variants.reduce((sum, variant) => sum + variant.allocationBasisPoints, 0);
  const bucket = stableHash(contextHash) % Math.max(total, 1);
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.allocationBasisPoints;
    if (bucket < cursor) {
      return variant;
    }
  }
  return variants[0];
}

function isSampled(sampleRatioBasisPoints, contextHash = "") {
  return stableHash(contextHash) % maxBasisPoints < sampleRatioBasisPoints;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertBasisPoints(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > maxBasisPoints) {
    throw new TypeError(`${name} must be 0..10000 basis points`);
  }
}

function assertPrincipalRef(value) {
  assertObject(value, "principal ref");
  assertNonEmptyString(value.kind, "principal kind");
  assertNonEmptyString(value.id, "principal id");
}

function sameSubject(left, right) {
  return left.kind === right.kind && left.id === right.id && left.tenant === right.tenant;
}
