import { createHash } from "node:crypto";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


export const TRAINING_TRAJECTORY_SCHEMA = "hobo.training.trajectory/v1";
export const TRAINING_EVENT_SCHEMA = "hobo.training.event/v1";
export const TRAINING_OPTIMIZE_REQUEST_SCHEMA = "hobo.training.optimize-request/v1";
export const TRAINING_CANDIDATE_SCHEMA = "hobo.training.candidate-patch/v1";
export const TELEMETRY_ENVELOPE_SCHEMA = "hobo.telemetry-envelope/v1";
export const TRAINING_ENGINE_PORT = "hobo:training-engine/training-engine@0.1.0";
export const BUILT_IN_ENGINE_ID = "hobo.training-engine/built-in-opto@0.1.0";

export const TRAINING_EVENT_TYPES = Object.freeze([
  "training.RunStarted",
  "training.TrajectoryCaptured",
  "training.RewardObserved",
  "training.CandidateProposed",
  "training.CandidateEvaluated",
  "training.Promoted",
  "training.Rejected"
]);

const TRACEPARENT_RE = /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const OPENINFERENCE_SPAN_KINDS = new Set([
  "LLM",
  "CHAIN",
  "TOOL",
  "RETRIEVER",
  "RERANKER",
  "EMBEDDING",
  "AGENT",
  "GUARDRAIL",
  "EVALUATOR",
  "PROMPT"
]);
const SENSITIVE_CLASSIFICATIONS = new Set(["pii", "secret", "confidential", "regulated"]);

export function createGoldenTrajectory(overrides = {}) {
  return deepMerge(
    {
      schema: TRAINING_TRAJECTORY_SCHEMA,
      id: "trajectory-1",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      run: {
        id: "run-2026-06-25-training-1",
        tenantId: "tenant-a",
        bindle: "bindle/support",
        agent: {
          id: "agent:support-classifier",
          principalRef: "spiffe://tenant-a/bindle/support/agent/support-classifier"
        }
      },
      subject: {
        method: "classifyTicket",
        contractRef: "contract://support/classification@1.0.0",
        generatedRegion: defaultGeneratedRegion()
      },
      spans: [
        {
          id: "span-root",
          parentId: null,
          name: "support.classifyTicket",
          startTime: "2026-06-25T09:00:00.000Z",
          endTime: "2026-06-25T09:00:00.120Z",
          attributes: {
            "openinference.span.kind": "CHAIN",
            "hobo.run.id": "run-2026-06-25-training-1",
            "hobo.agent.id": "agent:support-classifier",
            "input.value": "password reset request"
          },
          inputs: {
            ticketClass: "access"
          },
          outputs: {
            route: "identity-support"
          }
        },
        {
          id: "span-llm",
          parentId: "span-root",
          name: "llm.classifyTicket",
          startTime: "2026-06-25T09:00:00.010Z",
          endTime: "2026-06-25T09:00:00.100Z",
          attributes: {
            "openinference.span.kind": "LLM",
            "llm.model_name": "stub-classifier",
            "llm.provider": "local"
          },
          inputs: {
            promptTemplate: "classify support ticket"
          },
          outputs: {
            label: "password-reset"
          }
        }
      ],
      payloads: {
        "ticket.intent": {
          classification: "public",
          redaction: "none",
          value: "password-reset"
        }
      },
      reward: {
        source: "live-eval",
        rubricRef: "rubric://support/classifier@1.0.0",
        eventId: "eval-1",
        score: 0.94,
        observedAt: "2026-06-25T09:00:01.000Z"
      }
    },
    overrides
  );
}

export function makeOptimizeRequest({
  requestId = "optimize-request-1",
  trajectories,
  rubric,
  contract,
  generatedRegion
} = {}) {
  const selectedTrajectories = trajectories === undefined ? [createGoldenTrajectory()] : structuredClone(trajectories);
  const selectedRegion = generatedRegion ?? selectedTrajectories[0]?.subject?.generatedRegion ?? defaultGeneratedRegion();

  return {
    schema: TRAINING_OPTIMIZE_REQUEST_SCHEMA,
    requestId,
    generatedRegion: structuredClone(selectedRegion),
    trajectories: selectedTrajectories,
    rubric: structuredClone(
      rubric ?? {
        id: "rubric://support/classifier@1.0.0",
        objective: "maximize classification reward while preserving contract outputs"
      }
    ),
    contract: structuredClone(
      contract ?? {
        ref: "contract://support/classification@1.0.0",
        method: "classifyTicket",
        allowedRegionId: selectedRegion.regionId
      }
    )
  };
}

export function createStubTrainingEngine({ engineId = BUILT_IN_ENGINE_ID } = {}) {
  return {
    engineId,
    optimize(request) {
      return {
        schema: TRAINING_CANDIDATE_SCHEMA,
        id: "candidate-1",
        engineId,
        region: structuredClone(request.generatedRegion),
        edits: [
          {
            startOffset: 14,
            endOffset: 34,
            replacement: "return candidate.score;"
          }
        ],
        provenance: {
          trajectoryHashes: request.trajectories.map(hashTrajectory),
          rubricRef: request.rubric.id,
          contractRef: request.contract.ref
        }
      };
    }
  };
}

export function createOutOfRegionOptimizer({ engineId = "example.training-engine/out-of-region@0.1.0" } = {}) {
  return {
    engineId,
    optimize(request) {
      return {
        schema: TRAINING_CANDIDATE_SCHEMA,
        id: "candidate-1",
        engineId,
        region: structuredClone(request.generatedRegion),
        edits: [
          {
            startOffset: request.generatedRegion.endOffset + 1,
            endOffset: request.generatedRegion.endOffset + 4,
            replacement: "overwrite unrelated code"
          }
        ],
        provenance: {
          trajectoryHashes: request.trajectories.map(hashTrajectory),
          rubricRef: request.rubric.id,
          contractRef: request.contract.ref
        }
      };
    }
  };
}

export function optimizeTrainingCandidate(engine, request) {
  const requestValidation = validateOptimizeRequest(request);
  if (!requestValidation.ok) {
    return { ok: false, errors: requestValidation.errors, candidate: null };
  }
  if (!engine || !(engine.optimize instanceof Function)) {
    return { ok: false, errors: ["engine must implement optimize(request)"], candidate: null };
  }

  let candidate;
  try {
    candidate = engine.optimize(structuredClone(request));
  } catch (error) {
    return { ok: false, errors: [`engine threw during optimize: ${error.message}`], candidate: null };
  }

  const patchValidation = validateCandidatePatch(candidate, request.generatedRegion);
  return {
    ok: patchValidation.ok,
    errors: patchValidation.errors,
    candidate: patchValidation.ok ? patchValidation.candidate : null
  };
}

export function runTrainingEngineConformance(engine) {
  const errors = [];
  const request = makeOptimizeRequest();
  const first = optimizeTrainingCandidate(engine, request);
  const second = optimizeTrainingCandidate(engine, structuredClone(request));

  if (!first.ok) {
    errors.push(...first.errors);
  }
  if (!second.ok) {
    errors.push(...second.errors);
  }
  if (first.ok && second.ok && canonicalJson(first.candidate) !== canonicalJson(second.candidate)) {
    errors.push("determinism: same optimize request must return byte-stable candidate patch");
  }
  if (first.ok && first.candidate.region.regionId !== request.generatedRegion.regionId) {
    errors.push("candidate patch must bind to the requested generated region");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function validateTrajectory(trajectory) {
  const errors = [];

  if (!trajectory || !isJsonObject(trajectory) || Array.isArray(trajectory)) {
    return { ok: false, errors: ["trajectory must be an object"], trajectory: null };
  }
  if (trajectory.schema !== TRAINING_TRAJECTORY_SCHEMA) {
    errors.push(`trajectory.schema must be ${TRAINING_TRAJECTORY_SCHEMA}`);
  }
  if (!isNonEmptyString(trajectory.id)) {
    errors.push("trajectory.id must be a non-empty string");
  }
  if (!TRACEPARENT_RE.test(trajectory.traceparent ?? "")) {
    errors.push("trajectory.traceparent must be W3C traceparent");
  }

  validateRunCorrelation(trajectory.run, errors);
  validateGeneratedRegion(trajectory.subject?.generatedRegion, errors, "trajectory.subject.generatedRegion");
  validateSpans(trajectory.spans, errors);
  validateReward(trajectory.reward, errors);
  validatePayloads(trajectory.payloads, trajectory.run?.id, errors);

  return {
    ok: errors.length === 0,
    errors,
    trajectory: errors.length === 0 ? structuredClone(trajectory) : null
  };
}

export function validateCandidatePatch(candidate, generatedRegion) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["candidate patch must be an object"], candidate: null };
  }
  if (candidate.schema !== TRAINING_CANDIDATE_SCHEMA) {
    errors.push(`candidate.schema must be ${TRAINING_CANDIDATE_SCHEMA}`);
  }
  if (!isNonEmptyString(candidate.id)) {
    errors.push("candidate.id must be a non-empty string");
  }
  if (!isNonEmptyString(candidate.engineId)) {
    errors.push("candidate.engineId must identify the optimizer");
  }

  validateGeneratedRegion(candidate.region, errors, "candidate.region");
  const expectedRegion = generatedRegion ?? candidate.region;
  validateGeneratedRegion(expectedRegion, errors, "generated region");
  if (candidate.region && expectedRegion) {
    for (const key of ["regionId", "artifactRef", "startOffset", "endOffset"]) {
      if (candidate.region[key] !== expectedRegion[key]) {
        errors.push("candidate.region must match generated region");
        break;
      }
    }
  }

  if (!Array.isArray(candidate.edits) || candidate.edits.length === 0) {
    errors.push("candidate.edits must be a non-empty array");
  } else {
    candidate.edits.forEach((edit, index) => validateCandidateEdit(edit, index, expectedRegion, errors));
  }

  return {
    ok: errors.length === 0,
    errors,
    candidate: errors.length === 0 ? structuredClone(candidate) : null
  };
}

export function validateTrainingEvent(event) {
  const errors = [];

  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    return { ok: false, errors: ["event must be an object"], event: null };
  }
  if (event.schema !== TELEMETRY_ENVELOPE_SCHEMA) {
    errors.push(`event.schema must be ${TELEMETRY_ENVELOPE_SCHEMA}`);
  }
  if (!isNonEmptyString(event.id)) {
    errors.push("event.id must be a non-empty string");
  }
  if (!TRAINING_EVENT_TYPES.includes(event.type)) {
    errors.push(`event.type must be one of ${TRAINING_EVENT_TYPES.join(", ")}`);
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    errors.push("event.seq must be a non-negative integer");
  }
  if (!event.data || !isJsonObject(event.data) || Array.isArray(event.data)) {
    errors.push("event.data must be an object");
  } else {
    if (event.data.schema !== TRAINING_EVENT_SCHEMA) {
      errors.push(`event.data.schema must be ${TRAINING_EVENT_SCHEMA}`);
    }
    if (!isNonEmptyString(event.data.runId)) {
      errors.push("event.data.runId must be a non-empty string");
    }
  }
  if (!TRACEPARENT_RE.test(event.meta?.traceparent ?? "")) {
    errors.push("event.meta.traceparent must be W3C traceparent");
  }
  if (event.data?.runId && event.subject !== `training/${event.data.runId}`) {
    errors.push("event.subject must correlate to event.data.runId");
  }
  if (event.data?.runId && event.streamId !== `training:${event.data.runId}`) {
    errors.push("event.streamId must correlate to event.data.runId");
  }

  validateTrainingEventPayload(event, errors);

  return {
    ok: errors.length === 0,
    errors,
    event: errors.length === 0 ? structuredClone(event) : null
  };
}

export function createTrainingEvent({
  id,
  type,
  runId,
  seq,
  time = "2026-06-25T09:00:02.000Z",
  data = {}
}) {
  return {
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    id,
    type,
    source: "hobo://yard/training",
    subject: `training/${runId}`,
    streamId: `training:${runId}`,
    seq,
    time,
    meta: {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    },
    data: {
      schema: TRAINING_EVENT_SCHEMA,
      runId,
      ...structuredClone(data)
    }
  };
}

export function replayTrainingRun(events) {
  const sorted = [...events].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const projection = {
    runId: null,
    status: "unknown",
    trajectoryIds: [],
    rewardCount: 0,
    candidateIds: [],
    lastSeq: -1
  };

  for (const event of sorted) {
    const validation = validateTrainingEvent(event);
    if (!validation.ok) {
      throw new Error(`invalid training event ${event?.id ?? "unknown"}: ${validation.errors.join("; ")}`);
    }

    projection.runId ??= event.data.runId;
    projection.lastSeq = event.seq;

    if (event.type === "training.RunStarted") {
      projection.status = "running";
    } else if (event.type === "training.TrajectoryCaptured") {
      addUnique(projection.trajectoryIds, event.data.trajectoryId);
    } else if (event.type === "training.RewardObserved") {
      projection.rewardCount += 1;
    } else if (event.type === "training.CandidateProposed") {
      addUnique(projection.candidateIds, event.data.candidate.id);
    } else if (event.type === "training.CandidateEvaluated") {
      addUnique(projection.candidateIds, event.data.candidateId);
    } else if (event.type === "training.Promoted") {
      addUnique(projection.candidateIds, event.data.candidateId);
      projection.status = "promoted";
    } else if (event.type === "training.Rejected") {
      addUnique(projection.candidateIds, event.data.candidateId);
      projection.status = "rejected";
    }
  }

  return projection;
}

export function hashTrajectory(trajectory) {
  return `sha256:${createHash("sha256").update(canonicalJson(trajectory)).digest("hex")}`;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function validateOptimizeRequest(request) {
  const errors = [];

  if (!request || !isJsonObject(request) || Array.isArray(request)) {
    return { ok: false, errors: ["optimize request must be an object"] };
  }
  if (request.schema !== TRAINING_OPTIMIZE_REQUEST_SCHEMA) {
    errors.push(`request.schema must be ${TRAINING_OPTIMIZE_REQUEST_SCHEMA}`);
  }
  if (!isNonEmptyString(request.requestId)) {
    errors.push("request.requestId must be a non-empty string");
  }
  validateGeneratedRegion(request.generatedRegion, errors, "request.generatedRegion");
  if (!Array.isArray(request.trajectories) || request.trajectories.length === 0) {
    errors.push("request.trajectories must be a non-empty array");
  } else {
    request.trajectories.forEach((trajectory, index) => {
      const validation = validateTrajectory(trajectory);
      if (!validation.ok) {
        errors.push(...validation.errors.map((error) => `trajectory ${index}: ${error}`));
      }
    });
  }
  if (!isNonEmptyString(request.rubric?.id)) {
    errors.push("request.rubric.id must be a non-empty string");
  }
  if (!isNonEmptyString(request.contract?.ref)) {
    errors.push("request.contract.ref must be a non-empty string");
  }
  if (request.contract?.allowedRegionId !== request.generatedRegion?.regionId) {
    errors.push("request.contract.allowedRegionId must match request.generatedRegion.regionId");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function validateRunCorrelation(run, errors) {
  if (!run || !isJsonObject(run) || Array.isArray(run)) {
    errors.push("run must be an object");
    return;
  }
  if (!isNonEmptyString(run.id)) {
    errors.push("run.id must be a non-empty string");
  }
  if (!isNonEmptyString(run.tenantId)) {
    errors.push("run.tenantId must be a non-empty string");
  }
  if (!isNonEmptyString(run.bindle)) {
    errors.push("run.bindle must be a non-empty string");
  }
  if (!run.agent || !isJsonObject(run.agent) || Array.isArray(run.agent)) {
    errors.push("run.agent must be an object");
    return;
  }
  if (!isNonEmptyString(run.agent.id)) {
    errors.push("run.agent.id must be a non-empty string");
  }
  if (!isNonEmptyString(run.agent.principalRef)) {
    errors.push("run.agent.principalRef must be a non-empty string");
  }
}

function validateGeneratedRegion(region, errors, pathName) {
  if (!region || !isJsonObject(region) || Array.isArray(region)) {
    errors.push(`${pathName} must be an object`);
    return;
  }
  if (!isNonEmptyString(region.regionId)) {
    errors.push(`${pathName}.regionId must be a non-empty string`);
  }
  if (!isNonEmptyString(region.artifactRef)) {
    errors.push(`${pathName}.artifactRef must be a non-empty string`);
  }
  if (!Number.isInteger(region.startOffset) || region.startOffset < 0) {
    errors.push(`${pathName}.startOffset must be a non-negative integer`);
  }
  if (!Number.isInteger(region.endOffset) || region.endOffset <= region.startOffset) {
    errors.push(`${pathName}.endOffset must be greater than startOffset`);
  }
  if (!isNonEmptyString(region.owner)) {
    errors.push(`${pathName}.owner must be a non-empty string`);
  }
}

function validateSpans(spans, errors) {
  if (!Array.isArray(spans) || spans.length === 0) {
    errors.push("trajectory.spans must be a non-empty array");
    return;
  }

  const spanIds = new Set();
  for (const [index, span] of spans.entries()) {
    if (!span || !isJsonObject(span) || Array.isArray(span)) {
      errors.push(`spans.${index} must be an object`);
      continue;
    }
    if (!isNonEmptyString(span.id)) {
      errors.push(`spans.${index}.id must be a non-empty string`);
    } else if (spanIds.has(span.id)) {
      errors.push(`spans.${index}.id must be unique`);
    } else {
      spanIds.add(span.id);
    }
    const kind = span.attributes?.["openinference.span.kind"];
    if (!OPENINFERENCE_SPAN_KINDS.has(kind)) {
      errors.push(`spans.${index}.attributes.openinference.span.kind must be an OpenInference span kind`);
    }
    if (!span.attributes || !isJsonObject(span.attributes) || Array.isArray(span.attributes)) {
      errors.push(`spans.${index}.attributes must be an object`);
    }
  }

  for (const [index, span] of spans.entries()) {
    if (span?.parentId && !spanIds.has(span.parentId)) {
      errors.push(`spans.${index}.parentId must reference another span`);
    }
  }
}

function validateReward(reward, errors) {
  if (!reward || !isJsonObject(reward) || Array.isArray(reward)) {
    errors.push("trajectory.reward must be an object");
    return;
  }
  if (!Number.isFinite(reward.score) || reward.score < 0 || reward.score > 1) {
    errors.push("trajectory.reward.score must be between 0 and 1");
  }
  if (!isNonEmptyString(reward.rubricRef)) {
    errors.push("trajectory.reward.rubricRef must be a non-empty string");
  }
  if (!isNonEmptyString(reward.source)) {
    errors.push("trajectory.reward.source must be a non-empty string");
  }
}

function validatePayloads(payloads, runId, errors) {
  if (!payloads || !isJsonObject(payloads) || Array.isArray(payloads)) {
    errors.push("trajectory.payloads must be an object");
    return;
  }

  for (const [name, payload] of Object.entries(payloads)) {
    if (!payload || !isJsonObject(payload) || Array.isArray(payload)) {
      errors.push(`payload ${name} must be an object`);
      continue;
    }
    const classification = payload.classification ?? "public";
    if (!SENSITIVE_CLASSIFICATIONS.has(classification)) {
      continue;
    }
    if (payload.redaction === "tokenized" && isNonEmptyString(payload.tokenRef)) {
      continue;
    }
    if (
      payload.redaction === "encrypted" &&
      isNonEmptyString(payload.encryptedRef) &&
      payload.encryptedRef.startsWith(`run://${runId}/`)
    ) {
      continue;
    }
    errors.push(`sensitive payload ${name} must be tokenized or encrypted`);
  }
}

function validateCandidateEdit(edit, index, region, errors) {
  if (!edit || !isJsonObject(edit) || Array.isArray(edit)) {
    errors.push(`edit ${index} must be an object`);
    return;
  }
  if (!Number.isInteger(edit.startOffset) || !Number.isInteger(edit.endOffset)) {
    errors.push(`edit ${index} offsets must be integers`);
    return;
  }
  if (edit.endOffset < edit.startOffset) {
    errors.push(`edit ${index}.endOffset must be greater than or equal to startOffset`);
  }
  if (!isNonEmptyString(edit.replacement)) {
    errors.push(`edit ${index}.replacement must be a non-empty string`);
  }
  if (region && (edit.startOffset < region.startOffset || edit.endOffset > region.endOffset)) {
    errors.push(`edit ${index} must stay within generated region`);
  }
}

function validateTrainingEventPayload(event, errors) {
  if (!event?.data || !isJsonObject(event.data)) {
    return;
  }

  if (event.type === "training.TrajectoryCaptured") {
    if (!isNonEmptyString(event.data.trajectoryId)) {
      errors.push("TrajectoryCaptured.trajectoryId must be a non-empty string");
    }
    if (!HASH_RE.test(event.data.trajectoryHash ?? "")) {
      errors.push("TrajectoryCaptured.trajectoryHash must be sha256");
    }
    const trajectoryValidation = validateTrajectory(event.data.trajectory);
    if (!trajectoryValidation.ok) {
      errors.push(...trajectoryValidation.errors.map((error) => `TrajectoryCaptured.${error}`));
    } else if (event.data.trajectoryHash !== hashTrajectory(event.data.trajectory)) {
      errors.push("TrajectoryCaptured.trajectoryHash must match trajectory");
    }
  } else if (event.type === "training.RewardObserved") {
    if (!isNonEmptyString(event.data.trajectoryId)) {
      errors.push("RewardObserved.trajectoryId must be a non-empty string");
    }
    validateReward(event.data.reward, errors);
  } else if (event.type === "training.CandidateProposed") {
    const candidateValidation = validateCandidatePatch(event.data.candidate, event.data.candidate?.region);
    if (!candidateValidation.ok) {
      errors.push(...candidateValidation.errors.map((error) => `CandidateProposed.${error}`));
    }
  } else if (event.type === "training.CandidateEvaluated") {
    if (!isNonEmptyString(event.data.candidateId)) {
      errors.push("CandidateEvaluated.candidateId must be a non-empty string");
    }
    if (!isJsonBoolean(event.data.conformance?.ok)) {
      errors.push("CandidateEvaluated.conformance.ok must be boolean");
    }
  } else if (event.type === "training.Promoted") {
    if (!isNonEmptyString(event.data.candidateId)) {
      errors.push("Promoted.candidateId must be a non-empty string");
    }
    if (!isNonEmptyString(event.data.promotionRef)) {
      errors.push("Promoted.promotionRef must be a non-empty string");
    }
  } else if (event.type === "training.Rejected") {
    if (!isNonEmptyString(event.data.candidateId)) {
      errors.push("Rejected.candidateId must be a non-empty string");
    }
    if (!isNonEmptyString(event.data.reason)) {
      errors.push("Rejected.reason must be a non-empty string");
    }
  }
}

function defaultGeneratedRegion() {
  return {
    regionId: "region-classifyTicket-body",
    artifactRef: "git://repo/src/support.ts#classifyTicket",
    startOffset: 0,
    endOffset: 80,
    owner: "training-engine"
  };
}

function addUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
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
