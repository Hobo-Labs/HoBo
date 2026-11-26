import { createHash, randomUUID } from "node:crypto";

import {
  canonicalJson,
  parseDecision,
  parseDecisionRequest,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const OBLIGATION_EVENT_SCHEMA_VERSION = "hobo.policy-obligation/v1";
export const OBLIGATION_ENGINE_ID = "hobo.obligation-engine/contract@0.1.0";

export const REFERENCE_OBLIGATION_KINDS = Object.freeze({
  "require-approval": Object.freeze({
    effectKind: "human-approval",
    contract: "hobo.effect.human-approval/v1",
  }),
  "require-canary": Object.freeze({
    effectKind: "rollout-canary",
    contract: "hobo.effect.rollout-canary/v1",
  }),
  "auto-revert": Object.freeze({
    effectKind: "auto-revert-hook",
    contract: "hobo.effect.auto-revert-hook/v1",
  }),
});

export function createReferenceObligation(kind, options = {}) {
  const reference = REFERENCE_OBLIGATION_KINDS[kind];
  if (!reference) {
    throw new TypeError(`Unknown reference obligation kind: ${kind}`);
  }

  const effectId =
    optionalString(options.effectId) ??
    `effect:${kind}:${shortHash({
      kind,
      deadline: options.deadline ?? null,
      metadata: options.metadata ?? {},
    })}`;
  const obligationId =
    optionalString(options.id) ?? `obl:${kind}:${shortHash({ effectId, kind })}`;

  const obligation = {
    id: obligationId,
    kind,
    effect: {
      id: effectId,
      kind: reference.effectKind,
      contract: reference.contract,
    },
  };

  if (options.deadline !== undefined && options.deadline !== null) {
    obligation.deadline = requireIsoTimestamp(options.deadline, "options.deadline");
  }
  if (options.metadata !== undefined) {
    obligation.metadata = cloneJson(options.metadata);
  }

  return obligation;
}

export function startObligationsFromDecision({
  request: requestInput,
  decision: decisionInput,
  at = new Date().toISOString(),
  idFactory = randomEventId,
} = {}) {
  const request = parseDecisionRequest(requestInput);
  const decision = parseDecision(decisionInput, request);
  const decisionDigest = digestJson(decision);
  const eventTime = requireIsoTimestamp(at, "at");
  const events = decision.obligations.map((entry, index) => {
    const obligation = normalizeObligation(entry, {
      index,
      requestHash: request.inputHash,
      decisionDigest,
    });
    return makeObligationEvent({
      id: idFactory("policy-obligation-created"),
      type: "policy.ObligationCreated",
      obligationId: obligation.id,
      time: eventTime,
      data: {
        obligation,
        requestHash: request.inputHash,
        decisionDigest,
        decisionEffect: decision.effect,
        policyIds: [...decision.evidence.policyIds],
      },
    });
  });

  return {
    schemaVersion: OBLIGATION_EVENT_SCHEMA_VERSION,
    engine: OBLIGATION_ENGINE_ID,
    events,
  };
}

export function recordObligationEffectCompleted({
  obligationId,
  effectId,
  result = {},
  at = new Date().toISOString(),
  idFactory = randomEventId,
} = {}) {
  const payload = cloneJson(result);
  return makeObligationEvent({
    id: idFactory("policy-obligation-effect-completed"),
    type: "policy.ObligationEffectCompleted",
    obligationId: requireString(obligationId, "obligationId"),
    effectId: requireString(effectId, "effectId"),
    time: requireIsoTimestamp(at, "at"),
    data: {
      result: payload,
      resultDigest: digestJson(payload),
    },
  });
}

export function satisfyObligation({
  obligationId,
  effectId,
  at = new Date().toISOString(),
  idFactory = randomEventId,
} = {}) {
  return makeObligationEvent({
    id: idFactory("policy-obligation-satisfied"),
    type: "policy.ObligationSatisfied",
    obligationId: requireString(obligationId, "obligationId"),
    effectId: requireString(effectId, "effectId"),
    time: requireIsoTimestamp(at, "at"),
    data: {},
  });
}

export function escalateOverdueObligations({
  events,
  at = new Date().toISOString(),
  idFactory = randomEventId,
} = {}) {
  const replay = replayObligationEvents(events);
  const checkedAt = requireIsoTimestamp(at, "at");
  const escalations = [];

  for (const obligation of replay.obligations) {
    if (obligation.status !== "pending" || obligation.deadline === null) {
      continue;
    }
    if (!deadlineIsDue(obligation.deadline, checkedAt)) {
      continue;
    }

    escalations.push(
      makeObligationEvent({
        id: idFactory("policy-obligation-escalated"),
        type: "policy.ObligationEscalated",
        obligationId: obligation.id,
        effectId: obligation.effect.id,
        time: checkedAt,
        data: {
          deadline: obligation.deadline,
          reason: "deadline-expired-without-satisfaction",
        },
      }),
    );
  }

  return { events: escalations, replay };
}

export function evaluateObligationGate(events) {
  const replay = replayObligationEvents(events);
  const pending = replay.obligations.filter((obligation) => obligation.status === "pending");
  const escalated = replay.obligations.filter((obligation) => obligation.status === "escalated");
  const satisfied = replay.obligations.filter((obligation) => obligation.status === "satisfied");
  const blocking = [...pending, ...escalated];

  return {
    blocked: blocking.length > 0,
    pending,
    escalated,
    satisfied,
    ignoredEvents: replay.ignoredEvents,
    reasons: blocking.map((obligation) => ({
      obligationId: obligation.id,
      kind: obligation.kind,
      status: obligation.status,
      reason:
        obligation.status === "escalated"
          ? "obligation-deadline-escalated"
          : "obligation-not-satisfied",
    })),
  };
}

export function replayObligationEvents(events = []) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  const states = new Map();
  const lifecycle = [];
  const ignoredEvents = [];

  for (const event of events) {
    if (!event || !isJsonObject(event)) {
      ignoredEvents.push({ event, reason: "malformed-event" });
      continue;
    }

    switch (event.type) {
      case "policy.ObligationCreated": {
        const obligation = normalizeCreatedObligation(event);
        if (states.has(obligation.id)) {
          ignoredEvents.push({ event, reason: "duplicate-obligation-created" });
          break;
        }
        states.set(obligation.id, obligation);
        lifecycle.push(cloneJson(event));
        break;
      }
      case "policy.ObligationEffectCompleted": {
        const state = states.get(event.obligationId);
        if (!state) {
          ignoredEvents.push({ event, reason: "unknown-obligation" });
          break;
        }
        if (event.effectId !== state.effect.id) {
          ignoredEvents.push({ event, reason: "effect-mismatch" });
          break;
        }
        if (state.completedEffect) {
          ignoredEvents.push({ event, reason: "duplicate-effect-completed" });
          break;
        }
        state.completedEffect = {
          id: event.effectId,
          completedAt: event.time,
          resultDigest: event.data?.resultDigest,
          result: cloneJson(event.data?.result ?? {}),
        };
        lifecycle.push(cloneJson(event));
        break;
      }
      case "policy.ObligationSatisfied": {
        const state = states.get(event.obligationId);
        if (!state) {
          ignoredEvents.push({ event, reason: "unknown-obligation" });
          break;
        }
        if (event.effectId !== state.effect.id) {
          ignoredEvents.push({ event, reason: "effect-mismatch" });
          break;
        }
        if (!state.completedEffect) {
          ignoredEvents.push({ event, reason: "missing-durable-effect" });
          break;
        }
        if (state.status === "satisfied") {
          ignoredEvents.push({ event, reason: "duplicate-obligation-satisfied" });
          break;
        }
        state.status = "satisfied";
        state.satisfiedAt = event.time;
        lifecycle.push(cloneJson(event));
        break;
      }
      case "policy.ObligationEscalated": {
        const state = states.get(event.obligationId);
        if (!state) {
          ignoredEvents.push({ event, reason: "unknown-obligation" });
          break;
        }
        if (event.effectId !== state.effect.id) {
          ignoredEvents.push({ event, reason: "effect-mismatch" });
          break;
        }
        if (state.status === "satisfied") {
          ignoredEvents.push({ event, reason: "already-satisfied" });
          break;
        }
        if (state.status === "escalated") {
          ignoredEvents.push({ event, reason: "duplicate-obligation-escalated" });
          break;
        }
        state.status = "escalated";
        state.escalatedAt = event.time;
        state.escalationReason =
          optionalString(event.data?.reason) ?? "deadline-expired-without-satisfaction";
        lifecycle.push(cloneJson(event));
        break;
      }
      default: {
        ignoredEvents.push({ event, reason: "unknown-event-type" });
      }
    }
  }

  const obligations = [...states.values()].map((state) => cloneJson(state));
  obligations.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  return {
    schemaVersion: OBLIGATION_EVENT_SCHEMA_VERSION,
    obligations,
    lifecycle,
    ignoredEvents,
  };
}

export function makeObligationEvent({
  id,
  type,
  obligationId,
  effectId,
  time = new Date().toISOString(),
  data = {},
}) {
  return {
    id: requireString(id, "id"),
    type: requireString(type, "type"),
    schemaVersion: OBLIGATION_EVENT_SCHEMA_VERSION,
    time: requireIsoTimestamp(time, "time"),
    obligationId: requireString(obligationId, "obligationId"),
    ...(effectId === undefined ? undefined : { effectId: requireString(effectId, "effectId") }),
    data: cloneJson(data),
  };
}

function normalizeCreatedObligation(event) {
  const obligation = normalizeObligation(event.data?.obligation, {
    index: 0,
    requestHash: event.data?.requestHash ?? "unknown",
    decisionDigest: event.data?.decisionDigest ?? "unknown",
  });
  return {
    ...obligation,
    status: "pending",
    createdAt: requireIsoTimestamp(event.time, "event.time"),
    requestHash: event.data?.requestHash ?? null,
    decisionDigest: event.data?.decisionDigest ?? null,
    policyIds: cloneJson(event.data?.policyIds ?? []),
    completedEffect: null,
    satisfiedAt: null,
    escalatedAt: null,
    escalationReason: null,
  };
}

function normalizeObligation(entry, { index, requestHash, decisionDigest }) {
  const source = expectObject(entry, `obligations[${index}]`);
  const kind = requireString(source.kind, `obligations[${index}].kind`);
  const reference = REFERENCE_OBLIGATION_KINDS[kind];
  const effect = normalizeEffect(source.effect, {
    kind,
    reference,
    index,
    requestHash,
    decisionDigest,
  });
  const id =
    optionalString(source.id) ??
    `obl:${shortHash({
      kind,
      effectId: effect.id,
      index,
      requestHash,
      decisionDigest,
    })}`;

  return {
    id,
    kind,
    effect,
    deadline:
      source.deadline === undefined || source.deadline === null
        ? null
        : requireIsoTimestamp(source.deadline, `obligations[${index}].deadline`),
    metadata: cloneJson(source.metadata ?? {}),
  };
}

function normalizeEffect(sourceEffect, { kind, reference, index, requestHash, decisionDigest }) {
  const effect = sourceEffect === undefined ? {} : expectObject(sourceEffect, "obligation.effect");
  const effectKind =
    optionalString(effect.kind) ??
    reference?.effectKind ??
    `custom-${kind}`;
  const contract =
    optionalString(effect.contract) ??
    reference?.contract ??
    "hobo.effect.custom-obligation/v1";
  const id =
    optionalString(effect.id) ??
    `effect:${shortHash({ kind, effectKind, index, requestHash, decisionDigest })}`;

  return { id, kind: effectKind, contract };
}

function deadlineIsDue(deadline, checkedAt) {
  return Date.parse(deadline) <= Date.parse(checkedAt);
}

function randomEventId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function digestJson(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function shortHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

function requireIsoTimestamp(input, fieldName) {
  const value = requireString(input, fieldName);
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${fieldName} must be an ISO timestamp`);
  }
  return value;
}

function requireString(input, fieldName) {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function optionalString(input) {
  if (!isJsonString(input) || input.length === 0) {
    return null;
  }
  return input;
}

function expectObject(input, fieldName) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
