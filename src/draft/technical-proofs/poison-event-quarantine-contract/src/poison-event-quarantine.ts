import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export class FoldExecutionError extends Error {
  constructor({ fold, event, cause }) {
    super(`fold ${fold.name} failed at ${event.streamId}@${event.seq}: ${cause.message}`);
    this.name = "FoldExecutionError";
    this.fold = fold.name;
    this.event = clone(event);
    this.cause = cause;
  }
}

export class QuarantineFactError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuarantineFactError";
  }
}

export function createProjectionFold(input) {
  return createFold({ ...input, kind: "projection" });
}

export function createAggregateFold(input) {
  return createFold({ ...input, kind: "aggregate" });
}

export function replayWithQuarantine({ fold, events }) {
  const definition = normalizeFold(fold);
  const baseLog = normalizeEvents(events);
  const quarantineFacts = [];
  const quarantinesByStreamSeq = new Map();
  const policyFindings = [];

  for (const current of baseLog) {
    if (current.type !== definition.quarantineType) continue;
    const fact = validateQuarantineFact(current);
    if (!isQuarantineForFold(fact, definition)) continue;
    quarantineFacts.push(current);
    quarantinesByStreamSeq.set(quarantineKey(current.streamId, fact.targetSeq), current);
  }

  let state = clone(definition.initialState);
  const emittedQuarantines = [];
  const nextSeqByStream = maxSeqByStream(baseLog);

  for (const current of baseLog) {
    if (current.type === definition.quarantineType) {
      continue;
    }
    if (!definition.readSet.has(current.type)) {
      continue;
    }

    const existingQuarantine = quarantinesByStreamSeq.get(quarantineKey(current.streamId, current.seq));
    if (existingQuarantine) {
      if (canFold(definition, state, current)) {
        policyFindings.push({
          code: "event-log.quarantine-reprocess-policy-required",
          streamId: current.streamId,
          seq: current.seq,
          eventId: current.id,
        });
      }
      continue;
    }

    try {
      state = clone(definition.fold(clone(state), clone(current)));
    } catch (cause) {
      const classification = definition.classifyFailure(cause, current);
      if (classification !== "poison") {
        throw new FoldExecutionError({ fold: definition, event: current, cause });
      }

      const quarantine = createQuarantineFact({
        fold: definition,
        event: current,
        reason: cause.message,
        seq: nextSeq(current.streamId, nextSeqByStream),
      });
      emittedQuarantines.push(quarantine);
      quarantineFacts.push(quarantine);
      quarantinesByStreamSeq.set(quarantineKey(current.streamId, current.seq), quarantine);
    }
  }

  const fullLog = normalizeEvents([...baseLog, ...emittedQuarantines]);
  const quarantinedSeqs = quarantineFacts
    .map((fact) => validateQuarantineFact(fact).targetSeq)
    .sort((left, right) => left - right);
  const digestMaterial = {
    fold: definition.name,
    kind: definition.kind,
    state,
    quarantinedSeqs,
  };

  return Object.freeze({
    fold: definition.name,
    foldKind: definition.kind,
    state: freezeClone(state),
    log: freezeClone(fullLog),
    quarantines: freezeClone(emittedQuarantines),
    quarantineFacts: freezeClone(quarantineFacts),
    quarantinedSeqs: freezeClone(quarantinedSeqs),
    policyFindings: freezeClone(policyFindings),
    replayEqualsLiveDigest: sha256(canonicalJson(digestMaterial)),
  });
}

export function doctorQuarantineReport(result) {
  const facts = result.quarantineFacts ?? result.quarantines ?? [];
  const findings = facts.map((fact) => {
    const data = validateQuarantineFact(fact);
    return {
      code: "event-log.poison-quarantined",
      severity: "incident",
      streamId: fact.streamId,
      seq: data.targetSeq,
      eventId: data.targetEventId,
      reason: data.reason,
      remediation: "investigate the fold/upcaster and choose explicit keep-quarantined or reprocess policy",
    };
  });

  return Object.freeze({
    ok: findings.length === 0,
    findings: freezeClone(findings),
  });
}

function createFold(input) {
  if (input.kind !== "projection" && input.kind !== "aggregate") {
    throw new TypeError("fold kind must be projection or aggregate");
  }
  assertFunction(input.fold, "fold");

  return Object.freeze({
    name: assertNonEmptyString(input.name, "name"),
    kind: input.kind,
    quarantineType: assertNonEmptyString(input.quarantineType, "quarantineType"),
    readSet: freezeClone([...new Set(input.readSet?.map((value) => assertNonEmptyString(value, "readSet item")) ?? [])]),
    initialState: freezeClone(input.initialState ?? {}),
    fold: input.fold,
    classifyFailure: input.classifyFailure ?? defaultClassifyFailure,
  });
}

function normalizeFold(fold) {
  if (!fold || !isJsonObject(fold)) {
    throw new TypeError("fold is required");
  }
  assertNonEmptyString(fold.name, "fold.name");
  assertNonEmptyString(fold.kind, "fold.kind");
  assertNonEmptyString(fold.quarantineType, "fold.quarantineType");
  assertFunction(fold.fold, "fold.fold");
  assertFunction(fold.classifyFailure, "fold.classifyFailure");
  if (!Array.isArray(fold.readSet) || fold.readSet.length === 0) {
    throw new TypeError("fold.readSet must be a non-empty array");
  }

  return Object.freeze({
    ...fold,
    readSet: new Set(fold.readSet),
  });
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  return events.map(normalizeEvent).sort(compareEventOrder);
}

function normalizeEvent(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError("event must be an object");
  }
  const streamId = assertNonEmptyString(input.streamId, "event.streamId");
  const seq = assertSeq(input.seq, "event.seq");
  const type = assertNonEmptyString(input.type, "event.type");

  return Object.freeze({
    ...clone(input),
    id: input.id ?? `${streamId}:${seq}:${type}`,
    streamId,
    seq,
    type,
    data: clone(input.data ?? {}),
    meta: clone(input.meta ?? {}),
  });
}

function createQuarantineFact({ fold, event, reason, seq }) {
  return Object.freeze({
    type: fold.quarantineType,
    streamId: event.streamId,
    seq,
    data: Object.freeze({
      targetSeq: event.seq,
      targetEventId: event.id,
      targetType: event.type,
      fold: fold.name,
      foldKind: fold.kind,
      reason,
    }),
  });
}

function validateQuarantineFact(event) {
  if (!event || event.type === undefined) {
    throw new QuarantineFactError("quarantine fact event is required");
  }
  const data = event.data;
  if (!data || !isJsonObject(data) || Array.isArray(data)) {
    throw new QuarantineFactError("quarantine fact data must be an object");
  }

  return Object.freeze({
    targetSeq: assertSeqForQuarantine(data.targetSeq, "quarantine.data.targetSeq"),
    targetEventId: assertNonEmptyForQuarantine(data.targetEventId, "quarantine.data.targetEventId"),
    targetType: assertNonEmptyForQuarantine(data.targetType, "quarantine.data.targetType"),
    fold: assertNonEmptyForQuarantine(data.fold, "quarantine.data.fold"),
    foldKind: assertNonEmptyForQuarantine(data.foldKind, "quarantine.data.foldKind"),
    reason: assertNonEmptyForQuarantine(data.reason, "quarantine.data.reason"),
  });
}

function isQuarantineForFold(fact, definition) {
  return fact.fold === definition.name && fact.foldKind === definition.kind;
}

function canFold(definition, state, event) {
  try {
    definition.fold(clone(state), clone(event));
    return true;
  } catch {
    return false;
  }
}

function maxSeqByStream(events) {
  const max = new Map();
  for (const current of events) {
    max.set(current.streamId, Math.max(max.get(current.streamId) ?? 0, current.seq));
  }
  return max;
}

function nextSeq(streamId, nextSeqByStream) {
  const next = (nextSeqByStream.get(streamId) ?? 0) + 1;
  nextSeqByStream.set(streamId, next);
  return next;
}

function quarantineKey(streamId, seq) {
  return `${streamId}\0${seq}`;
}

function defaultClassifyFailure() {
  return "poison";
}

function compareEventOrder(left, right) {
  return (
    left.streamId.localeCompare(right.streamId) ||
    left.seq - right.seq ||
    left.type.localeCompare(right.type) ||
    left.id.localeCompare(right.id)
  );
}

function assertFunction(value, field) {
  if (!(value instanceof Function)) {
    throw new TypeError(`${field} must be a function`);
  }
}

function assertSeq(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertSeqForQuarantine(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QuarantineFactError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertNonEmptyForQuarantine(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new QuarantineFactError(`${field} must be a non-empty string`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function freezeClone(value) {
  return deepFreeze(clone(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
