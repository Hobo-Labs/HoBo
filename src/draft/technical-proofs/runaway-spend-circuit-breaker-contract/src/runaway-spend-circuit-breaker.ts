import { createHash } from "node:crypto";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


export const RUNAWAY_SPEND_BREAKER_ENGINE_ID =
  "hobo.runaway-spend-circuit-breaker/contract@0.1.0";
export const RUNAWAY_SPEND_BREAKER_SCHEMA_VERSION =
  "hobo.runaway-spend-circuit-breaker/v1";

const SCOPE_KINDS = new Set(["tenant", "camp", "agent"]);
const DEFAULT_SPEND_ACTION_KINDS = new Set([
  "hobo:deployment:apply",
  "hobo:agent:provision",
  "hobo:generation:run",
]);

export function evaluateRunawaySpendCircuitBreaker(input) {
  const source = expectObject(input, "input");
  const policy = normalizePolicy(source.policy);
  const meteringView = normalizeMeteringView(source.meteringView);
  const samples = normalizeVelocitySamples(source.samples ?? []);
  const action = normalizeAction(source.action);
  const ack = normalizeAck(source.ack);
  const now = normalizeInstant(source.now ?? new Date().toISOString(), "input.now");
  const eventLog = source.eventLog ?? [];

  const replay = replaySpendCircuitEvents(eventLog);
  let state = replay.state;
  const evaluations = [];
  const emittedEvents = [];
  const breach = evaluateVelocityWindow({
    policy,
    meteringView,
    samples,
    now,
  });
  evaluations.push(breach.evaluation);

  if (ack && state.status === "open") {
    const reset = evaluateReset({ state, policy, ack, breach, samples, meteringView, now });
    evaluations.push(reset.evaluation);
    if (reset.event) {
      emittedEvents.push(reset.event);
      state = replaySpendCircuitEvents([...eventLog, ...emittedEvents]).state;
    }
  }

  if (state.status === "closed" && breach.shouldTrip) {
    const event = createSpendCircuitEvent({
      type: "spend.CircuitTripped",
      policy,
      meteringView,
      occurredAt: now,
      generation: state.generation + 1,
      data: {
        reason: "runaway spend velocity",
        thresholdUsdPerHour: policy.velocityThresholdUsdPerHour,
        maxVelocityUsdPerHour: breach.maxVelocityUsdPerHour,
        evidenceSampleIds: breach.evidenceSampleIds,
        windowSeconds: breach.windowSeconds,
        debounce: policy.debounce,
        degradationExhausted: policy.requireDegradationExhausted,
        lastResort: true,
      },
    });
    emittedEvents.push(event);
    state = replaySpendCircuitEvents([...eventLog, ...emittedEvents]).state;
  }

  const decision = decideAction({ policy, state, action });

  return {
    schemaVersion: RUNAWAY_SPEND_BREAKER_SCHEMA_VERSION,
    engine: RUNAWAY_SPEND_BREAKER_ENGINE_ID,
    policy,
    meteringView: {
      view: meteringView.view,
      seq: meteringView.seq,
      digest: meteringView.digest,
      currency: meteringView.currency,
    },
    state,
    decision,
    events: emittedEvents,
    evaluations,
    ignoredEvents: replay.ignoredEvents,
  };
}

export function replaySpendCircuitEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  const state = {
    status: "closed",
    generation: 0,
    scope: null,
    policyId: null,
    trippedAt: null,
    resetAt: null,
    openEventId: null,
    meteringViewSeq: null,
    meteringViewDigest: null,
  };
  const ignoredEvents = [];
  const seenEventIds = new Set();

  for (const event of events) {
    if (!event || !isJsonObject(event) || Array.isArray(event)) {
      ignoredEvents.push({ event, reason: "malformed-event" });
      continue;
    }
    if (event.id && seenEventIds.has(event.id)) {
      ignoredEvents.push({ event, reason: "duplicate-event-id" });
      continue;
    }
    if (event.id) {
      seenEventIds.add(event.id);
    }

    if (event.type === "spend.CircuitTripped") {
      if (state.status === "open") {
        ignoredEvents.push({ event, reason: "already-open" });
        continue;
      }
      state.status = "open";
      state.generation = readGeneration(event, state.generation + 1);
      state.scope = readEventScope(event);
      state.policyId = optionalString(event.policyId);
      state.trippedAt = readEventTime(event);
      state.resetAt = null;
      state.openEventId = optionalString(event.id);
      state.meteringViewSeq = optionalNonNegativeInteger(event.meteringViewSeq);
      state.meteringViewDigest = optionalString(event.meteringViewDigest);
      continue;
    }

    if (event.type === "spend.CircuitReset") {
      if (state.status === "closed") {
        ignoredEvents.push({ event, reason: "already-closed" });
        continue;
      }
      const eventGeneration = readGeneration(event, state.generation);
      if (eventGeneration < state.generation) {
        ignoredEvents.push({ event, reason: "stale-reset-generation" });
        continue;
      }
      state.status = "closed";
      state.generation = eventGeneration;
      state.scope = readEventScope(event) ?? state.scope;
      state.policyId = optionalString(event.policyId) ?? state.policyId;
      state.resetAt = readEventTime(event);
      state.openEventId = null;
      state.meteringViewSeq = optionalNonNegativeInteger(event.meteringViewSeq);
      state.meteringViewDigest = optionalString(event.meteringViewDigest);
      continue;
    }

    ignoredEvents.push({ event, reason: "unknown-event-type" });
  }

  return { state, ignoredEvents };
}

function evaluateVelocityWindow({ policy, meteringView, samples, now }) {
  const latest = samples.at(-1) ?? null;
  const latestMs = latest ? Date.parse(latest.observedAt) : null;
  const nowMs = Date.parse(now);
  const stale =
    latestMs === null ||
    nowMs - latestMs > policy.debounce.maxSampleAgeSeconds * 1_000 ||
    latestMs > nowMs;
  const windowCandidates = stale
    ? []
    : samples.filter(
        (sample) => latestMs - Date.parse(sample.observedAt) <= policy.debounce.windowSeconds * 1_000,
      );
  const breaching = windowCandidates.filter((sample) =>
    isBreachingSample(sample, policy.velocityThresholdUsdPerHour, policy.requireDegradationExhausted),
  );
  const spanSeconds =
    breaching.length === 0
      ? 0
      : Math.round(
          (Date.parse(breaching.at(-1).observedAt) - Date.parse(breaching[0].observedAt)) / 1_000,
        );
  const shouldTrip =
    !stale &&
    breaching.length >= policy.debounce.minSamples &&
    spanSeconds >= policy.debounce.minDurationSeconds;

  return {
    shouldTrip,
    maxVelocityUsdPerHour: roundUsd(
      Math.max(0, ...breaching.map((sample) => sample.spendVelocityUsdPerHour)),
    ),
    evidenceSampleIds: breaching.map((sample) => sample.id),
    windowSeconds: spanSeconds,
    evaluation: {
      kind: "spend-velocity-window",
      policyId: policy.id,
      meteringViewSeq: meteringView.seq,
      meteringViewDigest: meteringView.digest,
      thresholdUsdPerHour: policy.velocityThresholdUsdPerHour,
      candidateSampleCount: windowCandidates.length,
      breachingSampleCount: breaching.length,
      evidenceSampleIds: breaching.map((sample) => sample.id),
      observedWindowSeconds: spanSeconds,
      staleMeteringSamples: stale,
      degradationRequiredBeforeTrip: policy.requireDegradationExhausted,
      shouldTrip,
    },
  };
}

function evaluateReset({ state, policy, ack, breach, samples, meteringView, now }) {
  const ackMs = Date.parse(ack.acknowledgedAt);
  const trippedMs = Date.parse(state.trippedAt);
  const secondsSinceTrip = Math.max(0, Math.floor((ackMs - trippedMs) / 1_000));
  const freshSpike = samples.some(
    (sample) =>
      Date.parse(sample.observedAt) >= ackMs &&
      isBreachingSample(
        sample,
        policy.velocityThresholdUsdPerHour,
        policy.requireDegradationExhausted,
      ),
  );
  const cooldownElapsed = secondsSinceTrip >= policy.minResetIntervalSeconds;
  const accepted = cooldownElapsed && !breach.shouldTrip && !freshSpike;
  const evaluation = {
    kind: "spend-circuit-reset",
    policyId: policy.id,
    ackId: ack.id,
    acknowledgedBy: ack.acknowledgedBy,
    acknowledgedAt: ack.acknowledgedAt,
    secondsSinceTrip,
    minResetIntervalSeconds: policy.minResetIntervalSeconds,
    cooldownElapsed,
    freshSpikeAfterAck: freshSpike,
    currentWindowStillBreaches: breach.shouldTrip,
    accepted,
    reason: accepted
      ? "ack accepted after half-open probe"
      : freshSpike
        ? "ack raced fresh spend spike"
        : !cooldownElapsed
          ? "reset cooldown not elapsed"
          : "current spend window still breaches threshold",
  };

  if (!accepted) {
    return { evaluation, event: null };
  }

  return {
    evaluation,
    event: createSpendCircuitEvent({
      type: "spend.CircuitReset",
      policy,
      meteringView,
      occurredAt: now,
      generation: state.generation,
      data: {
        ackId: ack.id,
        acknowledgedBy: ack.acknowledgedBy,
        acknowledgedAt: ack.acknowledgedAt,
        halfOpenProbeLimit: policy.halfOpenProbeLimit,
        resetMode: "operator-ack-half-open",
      },
    }),
  };
}

function decideAction({ policy, state, action }) {
  if (!action) {
    return {
      effect: "observe",
      reason:
        state.status === "open"
          ? "breaker open; no action evaluated"
          : "breaker closed; no action evaluated",
      obligations: state.status === "open" ? [createHaltObligation(policy, state)] : [],
    };
  }

  const spendIncurring = action.spendIncurring ?? DEFAULT_SPEND_ACTION_KINDS.has(action.kind);
  const compensation =
    action.compensation === true ||
    action.category === "compensation" ||
    action.kind.includes("compensat");

  if (state.status === "open" && spendIncurring && !compensation) {
    return {
      effect: "deny",
      reason: "spend circuit open; spend-incurring action halted",
      action: { ...action, spendIncurring, compensation },
      obligations: [createHaltObligation(policy, state)],
      blockedByEventId: state.openEventId,
    };
  }

  if (state.status === "open" && spendIncurring && compensation) {
    return {
      effect: "allow",
      reason: "spend circuit open; in-flight compensation remains allowed",
      action: { ...action, spendIncurring, compensation },
      obligations: [createHaltObligation(policy, state)],
      blockedByEventId: state.openEventId,
    };
  }

  return {
    effect: "allow",
    reason:
      state.status === "open"
        ? "spend circuit open; action is not spend-incurring"
        : "spend circuit closed",
    action: { ...action, spendIncurring, compensation },
    obligations: state.status === "open" ? [createHaltObligation(policy, state)] : [],
  };
}

function createHaltObligation(policy, state) {
  return {
    kind: "spend.circuit-breaker-halt",
    policyId: policy.id,
    scope: policy.scope,
    durable: true,
    openEventId: state.openEventId,
    haltedActionKinds: policy.haltedActionKinds,
  };
}

function createSpendCircuitEvent({ type, policy, meteringView, occurredAt, generation, data }) {
  const payload = {
    type,
    schemaVersion: RUNAWAY_SPEND_BREAKER_SCHEMA_VERSION,
    policyId: policy.id,
    scopeKind: policy.scope.kind,
    scopeId: policy.scope.id,
    occurredAt,
    generation,
    meteringViewSeq: meteringView.seq,
    meteringViewDigest: meteringView.digest,
    currency: meteringView.currency,
    ...data,
  };

  return {
    id: `${type}:${shortHash(payload)}`,
    ...payload,
  };
}

function isBreachingSample(sample, thresholdUsdPerHour, requireDegradationExhausted) {
  if (sample.spendVelocityUsdPerHour < thresholdUsdPerHour) {
    return false;
  }
  return !requireDegradationExhausted || sample.degradationExhausted === true;
}

function normalizePolicy(input) {
  const policy = expectObject(input, "input.policy");
  const debounce = normalizeDebounce(policy.debounce ?? {});
  const haltedActionKinds = parseStringArray(
    policy.haltedActionKinds ?? [...DEFAULT_SPEND_ACTION_KINDS],
    "input.policy.haltedActionKinds",
  );

  return {
    id: requireString(policy.id, "input.policy.id"),
    scope: normalizeScope(policy.scope, "input.policy.scope"),
    velocityThresholdUsdPerHour: requirePositiveNumber(
      policy.velocityThresholdUsdPerHour,
      "input.policy.velocityThresholdUsdPerHour",
    ),
    debounce,
    requireDegradationExhausted:
      optionalBoolean(
        policy.requireDegradationExhausted,
        "input.policy.requireDegradationExhausted",
      ) ?? true,
    minResetIntervalSeconds:
      optionalNonNegativeInteger(
        policy.minResetIntervalSeconds,
        "input.policy.minResetIntervalSeconds",
      ) ?? 900,
    halfOpenProbeLimit:
      optionalPositiveInteger(policy.halfOpenProbeLimit, "input.policy.halfOpenProbeLimit") ?? 1,
    haltedActionKinds,
  };
}

function normalizeDebounce(input) {
  const debounce = expectObject(input, "input.policy.debounce");
  const minSamples =
    optionalPositiveInteger(debounce.minSamples, "input.policy.debounce.minSamples") ?? 3;
  const minDurationSeconds =
    optionalNonNegativeInteger(
      debounce.minDurationSeconds,
      "input.policy.debounce.minDurationSeconds",
    ) ?? 60;
  const windowSeconds =
    optionalPositiveInteger(debounce.windowSeconds, "input.policy.debounce.windowSeconds") ?? 300;
  const maxSampleAgeSeconds =
    optionalPositiveInteger(
      debounce.maxSampleAgeSeconds,
      "input.policy.debounce.maxSampleAgeSeconds",
    ) ?? windowSeconds;

  if (minDurationSeconds > windowSeconds) {
    throw new RangeError("input.policy.debounce.minDurationSeconds must fit inside windowSeconds");
  }

  return {
    minSamples,
    minDurationSeconds,
    windowSeconds,
    maxSampleAgeSeconds,
  };
}

function normalizeVelocitySamples(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.samples must be an array");
  }
  return input
    .map((sample, index) => normalizeVelocitySample(sample, `input.samples[${index}]`))
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
        left.seq - right.seq ||
        left.id.localeCompare(right.id),
    );
}

function normalizeVelocitySample(input, path) {
  const sample = expectObject(input, path);
  return {
    id: requireString(sample.id, `${path}.id`),
    seq: requireNonNegativeInteger(sample.seq, `${path}.seq`),
    observedAt: normalizeInstant(sample.observedAt, `${path}.observedAt`),
    spendVelocityUsdPerHour: requireNonNegativeNumber(
      sample.spendVelocityUsdPerHour,
      `${path}.spendVelocityUsdPerHour`,
    ),
    degradationExhausted:
      optionalBoolean(sample.degradationExhausted, `${path}.degradationExhausted`) ?? false,
  };
}

function normalizeMeteringView(input) {
  const view = expectObject(input, "input.meteringView");
  if (view.view !== "MeteringView") {
    throw new TypeError("input.meteringView must be a MeteringView snapshot");
  }
  return {
    view: view.view,
    seq: requireNonNegativeInteger(view.seq, "input.meteringView.seq"),
    digest: requireString(view.digest, "input.meteringView.digest"),
    currency: requireString(view.currency, "input.meteringView.currency"),
  };
}

function normalizeAction(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const action = expectObject(input, "input.action");
  return {
    id: requireString(action.id, "input.action.id"),
    kind: requireString(action.kind, "input.action.kind"),
    spendIncurring: optionalBoolean(action.spendIncurring, "input.action.spendIncurring"),
    compensation: optionalBoolean(action.compensation, "input.action.compensation"),
    category: optionalString(action.category),
  };
}

function normalizeAck(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const ack = expectObject(input, "input.ack");
  return {
    id: requireString(ack.id, "input.ack.id"),
    acknowledgedBy: requireString(ack.acknowledgedBy, "input.ack.acknowledgedBy"),
    acknowledgedAt: normalizeInstant(ack.acknowledgedAt, "input.ack.acknowledgedAt"),
  };
}

function normalizeScope(input, path) {
  const scope = expectObject(input, path);
  const kind = requireString(scope.kind, `${path}.kind`);
  if (!SCOPE_KINDS.has(kind)) {
    throw new TypeError(`${path}.kind must be one of ${[...SCOPE_KINDS].join(", ")}`);
  }
  return {
    kind,
    id: requireString(scope.id, `${path}.id`),
  };
}

function readEventScope(event) {
  const kind = optionalString(event.scopeKind);
  const id = optionalString(event.scopeId);
  if (!kind || !id) {
    return null;
  }
  return { kind, id };
}

function readEventTime(event) {
  return optionalString(event.occurredAt) ?? optionalString(event.time) ?? null;
}

function readGeneration(event, fallback) {
  return optionalNonNegativeInteger(event.generation) ?? fallback;
}

function expectObject(input, fieldName) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function requireString(input, fieldName) {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function optionalString(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!isJsonString(input) || input.length === 0) {
    return null;
  }
  return input;
}

function parseStringArray(input, fieldName) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function optionalBoolean(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!isJsonBoolean(input)) {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
  return input;
}

function requirePositiveNumber(input, fieldName) {
  if (!Number.isFinite(input) || input <= 0) {
    throw new TypeError(`${fieldName} must be a positive number`);
  }
  return roundUsd(input);
}

function requireNonNegativeNumber(input, fieldName) {
  if (!Number.isFinite(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }
  return roundUsd(input);
}

function optionalPositiveInteger(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Number.isInteger(input) || input <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return input;
}

function requireNonNegativeInteger(input, fieldName) {
  if (!Number.isInteger(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return input;
}

function optionalNonNegativeInteger(input, fieldName = "value") {
  if (input === undefined || input === null) {
    return null;
  }
  return requireNonNegativeInteger(input, fieldName);
}

function normalizeInstant(input, fieldName) {
  if (!isJsonString(input)) {
    throw new TypeError(`${fieldName} must be an ISO-8601 string`);
  }
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return new Date(timestamp).toISOString();
}

function roundUsd(value) {
  return Number(value.toFixed(12));
}

function shortHash(input) {
  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16);
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
