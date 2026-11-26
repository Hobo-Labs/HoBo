import { parseContract } from "../../hobo-contract-ir/src/contract-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const OBSERVED_CONTRACT_PROMOTION_SCHEMA = "hobo.observed-contract-promotion/v1";
export const CONTRACT_OBSERVATION_EVENT_SCHEMA = "hobo.contract-observation.event/v1";

const CONTRACT_IR_SCHEMA = "contract.ir/v1";
const TRACE_OBSERVED = "contract.TraceObserved";

export function mineObservedContract({
  contractId,
  version = "1.0.0",
  edge,
  corpus = [],
  traceWindow = "P14D",
  fieldThresholdPct = 100,
  excludeLaneOrigin = true,
} = {}) {
  const errors = [];
  if (!isNonEmptyString(contractId)) {
    errors.push("contractId must be a non-empty string");
  }
  validateEdge(edge, errors);
  if (!Array.isArray(corpus)) {
    errors.push("corpus must be an array");
  }
  if (errors.length > 0) {
    return failed(errors);
  }

  const matching = corpus.filter((event) => event?.type === TRACE_OBSERVED && sameEdge(event.edge, edge));
  const baseline = excludeLaneOrigin ? matching.filter((event) => !hasLane(event)) : matching;
  const fieldCounts = new Map();

  for (const event of baseline) {
    const poison = validateTracePayload(event);
    if (poison) {
      return failed([poison]);
    }

    for (const field of Object.keys(event.payload)) {
      fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
    }
  }

  if (baseline.length === 0) {
    return failed(["no baseline trace samples"]);
  }

  const fieldCoverage = {};
  for (const [field, count] of [...fieldCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    fieldCoverage[field] = {
      samples: count,
      coveragePct: pct(count, baseline.length),
    };
  }

  const requiredFields = Object.entries(fieldCoverage)
    .filter(([, coverage]) => coverage.coveragePct >= fieldThresholdPct)
    .map(([field]) => field)
    .sort();

  const sampleCoverage = {
    samples: baseline.length,
    coveragePct: requiredFields.length === 0
      ? 0
      : Math.min(...requiredFields.map((field) => fieldCoverage[field].coveragePct)),
    traceWindow,
  };

  const contract = {
    schema: CONTRACT_IR_SCHEMA,
    id: contractId,
    version,
    mode: "observed",
    edge: normalizeEdge(edge),
    requiredRecord: {
      format: "trace-mined-json",
      schemaVersion: "2020-12",
      requiredFields,
      ["shape"]: {
        type: "object",
        required: requiredFields,
        properties: Object.fromEntries(requiredFields.map((field) => [field, { type: "observed" }])),
      },
    },
    provenance: {
      source: "trace-mined",
      verifiedByConstruction: false,
      sampleCoverage,
      fieldCoverage,
    },
    consumerRequirements: [
      {
        consumer: edge.consumer,
        requiredFields,
      },
    ],
    interop: {
      importTargets: ["trace-corpus"],
      exportTargets: ["contract-ir"],
    },
  };
  const parsed = parseContract(contract);
  if (!parsed.ok) {
    return failed(parsed.errors);
  }

  return {
    ok: true,
    errors: [],
    contract: parsed.contract,
    excludedLaneSamples: matching.length - baseline.length,
  };
}

export function promoteObservedContract(observedContract, {
  gateId,
  promotedVersion,
  migrationWindowDays = 14,
  minSamples = 1,
  minCoveragePct = 0,
  startedAt = "2026-06-26T00:00:00.000Z",
} = {}) {
  const parsed = parseContract(observedContract);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  if (parsed.contract.mode !== "observed") {
    throw new Error("only observed contracts can be promoted");
  }
  if (!isNonEmptyString(gateId)) {
    throw new Error("gateId must be a non-empty string");
  }

  const coverage = parsed.contract.provenance.sampleCoverage;
  const warnings = [];
  if (coverage.samples < minSamples) {
    warnings.push(`sample count ${coverage.samples} below promotion floor ${minSamples}`);
  }
  if (coverage.coveragePct < minCoveragePct) {
    warnings.push(`coverage ${coverage.coveragePct} below promotion floor ${minCoveragePct}`);
  }

  const migrationWindow = {
    days: migrationWindowDays,
    startedAt,
  };
  const contract = {
    ...parsed.contract,
    version: promotedVersion ?? parsed.contract.version,
    mode: "promoted",
    provenance: {
      ...parsed.contract.provenance,
      source: "promotion-gate",
      verifiedByConstruction: false,
      sampleCoverage: coverage,
      migrationWindow,
      promotedFrom: parsed.contract.id,
    },
  };
  const promoted = parseContract(contract);
  if (!promoted.ok) {
    throw new Error(promoted.errors.join("\n"));
  }

  const gate = {
    schema: OBSERVED_CONTRACT_PROMOTION_SCHEMA,
    id: gateId,
    contractId: promoted.contract.id,
    contractVersion: promoted.contract.version,
    edge: promoted.contract.edge,
    requiredFields: promoted.contract.requiredRecord.requiredFields,
    observedFieldSet: sortedUnique(Object.keys(promoted.contract.provenance.fieldCoverage ?? {})),
    coverage,
    minSamples,
    minCoveragePct,
    migrationWindow,
    confidence: warnings.length === 0 ? "enforceable" : "low-confidence",
    effect: warnings.length === 0 ? "enforce" : "require-review",
    warnings,
  };

  return {
    contract: promoted.contract,
    gate,
    events: [
      {
        type: "contract.Promoted",
        gateId,
        contractId: promoted.contract.id,
        contractVersion: promoted.contract.version,
        coverage,
        confidence: gate.confidence,
        migrationWindow,
      },
    ],
  };
}

export function evaluatePromotedContractGate(gate, {
  producer,
  fields = [],
  observedAt = "2026-06-26T00:00:00.000Z",
} = {}) {
  validateGate(gate);
  const observedFields = sortedUnique(fields);
  const knownFields = sortedUnique(gate.observedFieldSet);
  const expectedFields = sortedUnique(gate.requiredFields);
  const unexpectedFields = difference(observedFields, knownFields);
  const missingFields = difference(expectedFields, observedFields);
  const inWindow = isWithinMigrationWindow(observedAt, gate.migrationWindow);
  const failures = [];

  if (inWindow && (unexpectedFields.length > 0 || missingFields.length > 0)) {
    failures.push({
      reason: "unobserved-variant-during-migration",
      producer,
      expectedFields,
      observedFields,
      unexpectedFields,
      missingFields,
    });
  }

  const ok = failures.length === 0;
  const summary = ok
    ? "compatible promoted observed-contract shape"
    : `blocked: unobserved producer variant for ${producer} during migration window`;
  const suggestedFixes = ok
    ? []
    : [
        "dual-publish through the migration window",
        "promote a new observed contract from baseline traffic",
        "add a compatibility shim",
      ];
  const event = {
    type: ok ? "compat.GatePassed" : "compat.GateFailed",
    gateId: gate.id,
    producer,
    failures,
    suggestedFixes,
    summary,
  };

  return {
    ok,
    gateId: gate.id,
    producer,
    observedFields,
    expectedFields,
    failures,
    suggestedFixes,
    summary,
    events: [event],
  };
}

function failed(errors) {
  return {
    ok: false,
    errors,
    contract: null,
    excludedLaneSamples: 0,
  };
}

function validateEdge(edge, errors) {
  if (!edge || !isJsonObject(edge) || Array.isArray(edge)) {
    errors.push("edge must be an object");
    return;
  }
  for (const key of ["kind", "producer", "consumer", "operation"]) {
    if (!isNonEmptyString(edge[key])) {
      errors.push(`edge.${key} must be a non-empty string`);
    }
  }
}

function validateTracePayload(event) {
  if (!isPlainObject(event.payload)) {
    return `poisoned trace ${event.traceId ?? "<JsonValue>"}: payload must be an object`;
  }
  for (const field of Object.keys(event.payload)) {
    if (!isNonEmptyString(field)) {
      return `poisoned trace ${event.traceId ?? "<JsonValue>"}: field names must be non-empty`;
    }
  }
  return null;
}

function validateGate(gate) {
  if (!gate || !isJsonObject(gate) || Array.isArray(gate)) {
    throw new Error("gate must be an object");
  }
  if (gate.schema !== OBSERVED_CONTRACT_PROMOTION_SCHEMA) {
    throw new Error(`gate.schema must be ${OBSERVED_CONTRACT_PROMOTION_SCHEMA}`);
  }
  if (!Array.isArray(gate.observedFieldSet)) {
    throw new Error("gate.observedFieldSet must be an array");
  }
}

function sameEdge(left, right) {
  return (
    left?.kind === right?.kind &&
    left?.producer === right?.producer &&
    left?.consumer === right?.consumer &&
    left?.operation === right?.operation
  );
}

function normalizeEdge(edge) {
  return {
    kind: edge.kind,
    producer: edge.producer,
    consumer: edge.consumer,
    operation: edge.operation,
  };
}

function hasLane(event) {
  return Boolean(event.lane ?? event.meta?.lane ?? event.envelope?.lane ?? event.data?.lane);
}

function isPlainObject(value) {
  return Boolean(value) && isJsonObject(value) && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function sortedUnique(values = []) {
  return [...new Set(values.filter(isNonEmptyString))].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function pct(count, total) {
  return Number(((count / total) * 100).toFixed(3));
}

function isWithinMigrationWindow(observedAt, migrationWindow) {
  const startMs = Date.parse(migrationWindow?.startedAt);
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(observedMs)) {
    return true;
  }
  const days = Number.isInteger(migrationWindow.days) ? migrationWindow.days : 0;
  const endMs = startMs + days * 24 * 60 * 60 * 1000;
  return observedMs >= startMs && observedMs <= endMs;
}
