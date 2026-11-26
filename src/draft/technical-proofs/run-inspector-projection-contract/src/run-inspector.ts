import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const RUN_INSPECTOR_PROJECTION_CONTRACT_VERSION =
  "hobo.run-inspector-projection/v1";

export function createRunInspectorProjection(seedEvents = []) {
  const events = normalizeEvents(seedEvents);

  return Object.freeze({
    headSeq: events.at(-1)?.seq ?? 0,

    inspectRun(runId, options = {}) {
      const id = requireNonEmptyString(runId, "runId");
      const atSeq = normalizeAtSeq(options.atSeq, this.headSeq);
      const pageSize = normalizePageSize(options.pageSize ?? 100);
      const cursor = normalizeCursor(options.cursor ?? 0);
      const scoped = events.filter((event) => event.seq <= atSeq && belongsToRun(event, id));
      if (scoped.length === 0) {
        throw new RunInspectorError(`Unknown run "${id}". No run-inspector events exist.`);
      }

      return deepFreeze(materializeRun({ runId: id, events: scoped, atSeq, pageSize, cursor }));
    },

    replayDiff(runId, replayOutcomes, options = {}) {
      const view = this.inspectRun(runId, {
        atSeq: options.atSeq,
        pageSize: Number.MAX_SAFE_INTEGER,
      });
      const replayByStep = new Map(
        normalizeReplayOutcomes(replayOutcomes).map((outcome) => [outcome.stepId, outcome]),
      );
      const diffs = view.steps.items.map((step) => diffStep(step, replayByStep.get(step.id)));

      return deepFreeze({
        runId: view.id,
        atSeq: view.atSeq,
        status: diffs.some((diff) => diff.status !== "unchanged") ? "changed" : "unchanged",
        diffs,
      });
    },
  });
}

export class RunInspectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunInspectorError";
  }
}

function materializeRun({ runId, events, atSeq, pageSize, cursor }) {
  const steps = new Map();
  const sagas = new Map();
  const actors = new Map();
  const eventById = new Map(events.map((event) => [event.id, event]));
  let status = "in-flight";
  let partial = true;

  for (const event of events) {
    if (event.type === "run.Completed") {
      status = "completed";
      partial = false;
    }
    if (event.type === "run.Failed") {
      status = "failed";
      partial = false;
    }

    if (event.type.startsWith("run.Step")) {
      applyStepEvent(steps, event);
    }
    if (event.type.startsWith("saga.")) {
      applySagaEvent(sagas, event);
    }
    if (event.type.startsWith("actor.")) {
      applyActorEvent(actors, event);
    }
  }

  const timeline = events.map(toTimelineEntry);
  const allSteps = [...steps.values()].sort(compareByFirstSeqThenId);
  const pagedSteps = paginate(allSteps, cursor, pageSize);

  return {
    contract: RUN_INSPECTOR_PROJECTION_CONTRACT_VERSION,
    id: runId,
    status,
    partial,
    atSeq,
    headSeq: events.at(-1)?.seq ?? 0,
    steps: {
      items: pagedSteps.items,
      total: allSteps.length,
      nextCursor: pagedSteps.nextCursor,
    },
    sagas: [...sagas.values()].sort(compareByFirstSeqThenId),
    actors: [...actors.values()].sort(compareByFirstSeqThenId),
    timeline,
    causality: events
      .filter((event) => event.causationId)
      .map((event) => ({
        from: event.causationId,
        to: event.id,
        type: eventById.has(event.causationId) ? "event" : "external",
      })),
  };
}

function applyStepEvent(steps, event) {
  const stepId = requireNonEmptyString(event.data.stepId ?? event.data.name, "stepId");
  const step = ensure(steps, stepId, () => ({
    id: stepId,
    status: "pending",
    attempts: 0,
    input: undefined,
    output: undefined,
    memoizedResult: undefined,
    memoizedDigest: undefined,
    durationMs: undefined,
    signature: undefined,
    firstSeq: event.seq,
    lastSeq: event.seq,
    causality: [],
  }));
  step.firstSeq = Math.min(step.firstSeq, event.seq);
  step.lastSeq = Math.max(step.lastSeq, event.seq);
  if (event.causationId) {
    step.causality.push({ from: event.causationId, to: event.id });
  }

  if (event.type === "run.StepStarted") {
    step.status = "running";
    step.attempts = Math.max(step.attempts, event.data.attempt ?? event.data.attempts ?? 1);
    step.input = clone(event.data.input);
    step.signature = event.data.signature ?? step.signature;
    return;
  }

  if (event.type === "run.StepRetried") {
    step.status = "running";
    step.attempts = Math.max(step.attempts, event.data.attempt ?? event.data.attempts ?? 1);
    return;
  }

  if (event.type === "run.StepCompleted") {
    const output = event.data.output ?? event.data.result;
    const memoizedResult = event.data.memoizedResult ?? output;
    step.status = "completed";
    step.attempts = Math.max(step.attempts, event.data.attempt ?? event.data.attempts ?? 1);
    step.output = clone(output);
    step.memoizedResult = clone(memoizedResult);
    step.memoizedDigest = event.data.resultDigest ?? stableDigest(memoizedResult);
    step.durationMs = event.data.durationMs;
    step.signature = event.data.signature ?? step.signature;
    return;
  }

  if (event.type === "run.StepFailed") {
    step.status = "failed";
    step.attempts = Math.max(step.attempts, event.data.attempt ?? event.data.attempts ?? 1);
    step.error = {
      message: event.data.message ?? event.data.error ?? "step failed",
      failureClass: event.data.failureClass,
    };
  }
}

function applySagaEvent(sagas, event) {
  const sagaId = requireNonEmptyString(event.data.sagaId ?? event.sagaId, "sagaId");
  const saga = ensure(sagas, sagaId, () => ({
    id: sagaId,
    status: "running",
    firstSeq: event.seq,
    lastSeq: event.seq,
    events: [],
  }));
  saga.firstSeq = Math.min(saga.firstSeq, event.seq);
  saga.lastSeq = Math.max(saga.lastSeq, event.seq);
  saga.events.push({ seq: event.seq, type: event.type, id: event.id });

  if (event.type === "saga.Completed") {
    saga.status = "completed";
  } else if (event.type === "saga.RolledBack") {
    saga.status = "rolled-back";
  } else if (event.type === "saga.Compensating") {
    saga.status = "compensating";
  } else if (event.type === "saga.StepFailed") {
    saga.status = "failed";
  }
}

function applyActorEvent(actors, event) {
  const actorId = requireNonEmptyString(event.data.actorId ?? event.actorId, "actorId");
  const actor = ensure(actors, actorId, () => ({
    id: actorId,
    status: "active",
    firstSeq: event.seq,
    lastSeq: event.seq,
    messages: [],
  }));
  actor.firstSeq = Math.min(actor.firstSeq, event.seq);
  actor.lastSeq = Math.max(actor.lastSeq, event.seq);
  actor.messages.push({
    seq: event.seq,
    type: event.type,
    id: event.id,
    message: clone(event.data.message),
  });
  if (event.type === "actor.Passivated") {
    actor.status = "passivated";
  }
}

function diffStep(step, replay) {
  if (!replay) {
    return {
      stepId: step.id,
      status: "missing-replay",
      recordedDigest: step.memoizedDigest,
    };
  }

  if (replay.error) {
    return {
      stepId: step.id,
      status: "replay-error",
      recordedDigest: step.memoizedDigest,
      error: replay.error,
    };
  }

  if (step.signature && replay.signature && step.signature !== replay.signature) {
    return {
      stepId: step.id,
      status: "signature-mismatch",
      recordedSignature: step.signature,
      replaySignature: replay.signature,
    };
  }

  const replayDigest = stableDigest(replay.output);
  return {
    stepId: step.id,
    status: step.memoizedDigest === replayDigest ? "unchanged" : "changed",
    recordedDigest: step.memoizedDigest,
    replayDigest,
  };
}

function normalizeReplayOutcomes(outcomes) {
  if (!Array.isArray(outcomes)) {
    throw new TypeError("replayOutcomes must be an array");
  }
  return outcomes.map((outcome) => ({
    ...outcome,
    stepId: requireNonEmptyString(outcome?.stepId, "replayOutcome.stepId"),
  }));
}

function toTimelineEntry(event) {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    ts: event.ts,
    causationId: event.causationId,
    correlationId: event.correlationId,
    label: timelineLabel(event),
  };
}

function timelineLabel(event) {
  if (event.type.startsWith("run.Step")) {
    return event.data.stepId ?? event.data.name;
  }
  if (event.type.startsWith("saga.")) {
    return event.data.sagaId ?? event.sagaId;
  }
  if (event.type.startsWith("actor.")) {
    return event.data.actorId ?? event.actorId;
  }
  return event.data.runId ?? event.runId ?? event.correlationId;
}

function belongsToRun(event, runId) {
  return event.data.runId === runId || event.runId === runId || event.correlationId === runId;
}

function paginate(items, cursor, pageSize) {
  const page = items.slice(cursor, cursor + pageSize);
  const nextCursor = cursor + page.length < items.length ? cursor + page.length : null;
  return { items: page, nextCursor };
}

function normalizeEvents(seedEvents) {
  return seedEvents
    .map((event, index) => ({
      ...event,
      id: requireNonEmptyString(event.id ?? `${event.seq}:${event.type}:${index}`, "event.id"),
      seq: normalizeSeq(event.seq, "event.seq"),
      type: requireNonEmptyString(event.type, "event.type"),
      ts: event.ts,
      data: clone(event.data ?? {}),
      index,
    }))
    .sort((left, right) => left.seq - right.seq || left.index - right.index);
}

function normalizeAtSeq(atSeq, headSeq) {
  if (atSeq === undefined || atSeq === null) {
    return headSeq;
  }
  const seq = normalizeSeq(atSeq, "atSeq");
  if (seq > headSeq) {
    throw new RunInspectorError(`Cannot inspect at seq ${seq} beyond log head ${headSeq}.`);
  }
  return seq;
}

function normalizePageSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("pageSize must be a positive safe integer");
  }
  return value;
}

function normalizeCursor(value) {
  return normalizeSeq(value, "cursor");
}

function normalizeSeq(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function ensure(map, key, factory) {
  if (!map.has(key)) {
    map.set(key, factory());
  }
  return map.get(key);
}

function compareByFirstSeqThenId(left, right) {
  return left.firstSeq - right.firstSeq || left.id.localeCompare(right.id);
}

function stableDigest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
