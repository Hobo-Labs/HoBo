import {
  createBuiltInPolicyEngine,
  createRuleset,
  defineTypescriptRule,
  evaluateAndRecordPolicyDecision,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import { createFlagChanged } from "../../flag-event-contract/src/flag-event-contract.js";
import { POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const POLICY_GATED_FLAG_FLIPS_SCHEMA_VERSION = "hobo.policy-gated-flag-flips/v1";
export const FLAG_CHANGE_ACTION = "hobo:flag:change";
export const FLAG_CHANGE_PHASE = "runtime";
export const AUTO_REVERT_OBLIGATION_KIND = "flag.auto-revert-on-slo-burn";
export const DEFAULT_PERCENT_JUMP_THRESHOLD = 25;
export const DEFAULT_VELOCITY_WINDOW_MS = 10 * 60 * 1000;

const POLICY_EFFECTS_THAT_COMMIT = new Set(["allow", "allow-degraded", "warn", "mutate"]);
const SUBJECT_KINDS = new Set(["user", "service", "agent", "system"]);

export function createDefaultFlagFlipRuleset({
  id = "policy-pack:flag-flips",
  version = "1.0.0",
} = {}) {
  return createRuleset({
    id,
    version,
    rules: [
      defineTypescriptRule({
        id: "prod-kill-switch-requires-approval",
        when: ({ request }) =>
          request.action === FLAG_CHANGE_ACTION &&
          request.phase === FLAG_CHANGE_PHASE &&
          request.context.risk.reasons.includes("prod-kill-switch"),
        decide: () => ({
          effect: "require-approval",
          reason: "prod kill-switch flip requires approval before commit",
          approvals: [
            {
              kind: "human-approval",
              role: "flag-governor",
              reason: "prod kill-switch blast radius",
            },
          ],
        }),
      }),
      defineTypescriptRule({
        id: "risky-percent-bump-requires-auto-revert",
        when: ({ request }) =>
          request.action === FLAG_CHANGE_ACTION &&
          request.phase === FLAG_CHANGE_PHASE &&
          request.context.risk.reasons.some((reason) =>
            ["large-percent-jump", "cumulative-percent-velocity"].includes(reason),
          ),
        decide: ({ request }) => ({
          effect: "allow",
          reason: "risky percentage flip allowed with SLO-triggered auto-revert obligation",
          obligations: [
            {
              kind: AUTO_REVERT_OBLIGATION_KIND,
              flagKey: request.context.flag.key,
              environment: request.context.environment,
              trigger: "slo.BudgetBurned",
              previousValue: request.context.flag.from,
              committedValue: request.context.flag.to,
              cumulativePercentDelta: request.context.risk.cumulativePercentDelta,
            },
          ],
        }),
      }),
      defineTypescriptRule({
        id: "ordinary-prod-flag-change-allowed",
        when: ({ request }) =>
          request.action === FLAG_CHANGE_ACTION &&
          request.phase === FLAG_CHANGE_PHASE &&
          request.context.environment === "prod",
        decide: () => ({
          effect: "allow",
          reason: "ordinary prod flag change passed policy",
        }),
      }),
    ],
  });
}

export async function applyPolicyGatedFlagFlip(input) {
  const normalized = normalizeFlipInput(input);
  const risk = classifyFlipRisk(normalized, input);
  const events = [];

  if (!mustRouteThroughPolicy(normalized, risk)) {
    const flagChanged = createCommittedFlagChanged(normalized, {
      reason: normalized.reason,
      risk,
    });
    events.push(flagChanged);
    return {
      schemaVersion: POLICY_GATED_FLAG_FLIPS_SCHEMA_VERSION,
      status: "committed-ungated",
      committed: true,
      risk,
      decision: null,
      events,
    };
  }

  const engine = input.engine ?? createBuiltInPolicyEngine();
  const ruleset = input.ruleset ?? createDefaultFlagFlipRuleset();
  const request = createPolicyRequest(normalized, risk, input.policySubject);
  const decision = await evaluateAndRecordPolicyDecision({
    engine,
    request,
    ruleset,
    auditSink: async (event) => {
      events.push(event);
      await input.auditSink?.(event);
    },
  });
  const decisionEvent = events.find((event) => event.type === "policy.Decided");

  if (decision.effect === "require-approval" && !isApprovalSatisfied(input.approval)) {
    return {
      schemaVersion: POLICY_GATED_FLAG_FLIPS_SCHEMA_VERSION,
      status: "blocked-pending-approval",
      committed: false,
      risk,
      request,
      decision,
      events,
    };
  }

  if (!POLICY_EFFECTS_THAT_COMMIT.has(decision.effect) && decision.effect !== "require-approval") {
    return {
      schemaVersion: POLICY_GATED_FLAG_FLIPS_SCHEMA_VERSION,
      status: "denied",
      committed: false,
      risk,
      request,
      decision,
      events,
    };
  }

  const committedTo = applyPolicyMutations(normalized.to, decision.mutations);
  const flagChanged = createCommittedFlagChanged(
    { ...normalized, to: committedTo },
    {
      decision,
      decisionEvent,
      reason: normalized.reason,
      risk,
    },
  );
  events.push(flagChanged);

  const obligationEvents = decision.obligations.flatMap((obligation, index) =>
    createObligationCreatedEvent({
      obligation,
      decision,
      decisionEvent,
      flagChanged,
      index,
      time: normalized.time,
    }),
  );
  events.push(...obligationEvents);

  const signalResults = obligationEvents.flatMap((obligationEvent) =>
    handleFlagFlipObligationSignal({
      obligationEvent,
      flagChanged,
      actor: normalized.actor,
      sloBurnEvent: input.sloBurnEvent,
      autoRevertAvailable: input.autoRevertAvailable ?? true,
      time: normalized.time,
    }).events,
  );
  events.push(...signalResults);

  return {
    schemaVersion: POLICY_GATED_FLAG_FLIPS_SCHEMA_VERSION,
    status: statusForEvents(events),
    committed: true,
    risk,
    request,
    decision,
    events,
  };
}

export function classifyFlipRisk(input, options = {}) {
  const normalized = normalizeFlipInput(input);
  const threshold = options.percentJumpThreshold ?? DEFAULT_PERCENT_JUMP_THRESHOLD;
  const velocityWindowMs = options.velocityWindowMs ?? DEFAULT_VELOCITY_WINDOW_MS;
  const reasons = [];
  const currentDelta = numericDelta(normalized);

  if (normalized.environment === "prod" && normalized.killSwitch) {
    reasons.push("prod-kill-switch");
  }

  let cumulativePercentDelta = currentDelta;
  if (normalized.percentage && currentDelta > 0) {
    const nowMs = toMillis(normalized.time);
    cumulativePercentDelta += normalized.history
      .filter((change) => isRecentSameDirectionPercentChange(change, normalized, nowMs, velocityWindowMs))
      .reduce((total, change) => total + Math.abs(Number(change.to) - Number(change.from)), 0);

    if (currentDelta >= threshold) {
      reasons.push("large-percent-jump");
    } else if (cumulativePercentDelta >= threshold) {
      reasons.push("cumulative-percent-velocity");
    }
  }

  return {
    level: reasons.length === 0 ? "low" : "risky",
    reasons,
    currentPercentDelta: currentDelta,
    cumulativePercentDelta,
    threshold,
    velocityWindowMs,
  };
}

export function replayPolicyGatedFlagFlips(events) {
  const decisions = new Map();
  const gatedChanges = [];
  const ungatedChanges = [];
  const obligations = [];

  for (const event of events) {
    if (event.type === "policy.Decided") {
      decisions.set(event.id, event);
    } else if (event.type === "flag.Changed" && event.data.policyDecisionId) {
      gatedChanges.push(event);
    } else if (event.type === "flag.Changed") {
      ungatedChanges.push(event);
    } else if (event.type?.startsWith("policy.Obligation")) {
      obligations.push(event);
    }
  }

  for (const change of gatedChanges) {
    const decision = decisions.get(change.data.policyDecisionId);
    if (!decision) {
      throw new Error(`missing policy.Decided for flag.Changed ${change.data.key}`);
    }
    if (decision.data.evidence.inputHash !== change.data.policyDecisionInputHash) {
      throw new Error(`policy.Decided hash mismatch for flag.Changed ${change.data.key}`);
    }
  }

  return {
    decisions: [...decisions.values()],
    gatedChanges,
    ungatedChanges,
    obligations,
  };
}

export function handleFlagFlipObligationSignal({
  obligationEvent,
  flagChanged,
  actor,
  sloBurnEvent,
  autoRevertAvailable = true,
  time = new Date().toISOString(),
}) {
  if (!obligationEvent || obligationEvent.type !== "policy.ObligationCreated") {
    return { status: "ignored", events: [] };
  }
  if (obligationEvent.data.obligation.kind !== AUTO_REVERT_OBLIGATION_KIND || !isSloBurnEvent(sloBurnEvent)) {
    return { status: "waiting", events: [] };
  }

  if (!autoRevertAvailable) {
    return {
      status: "escalated",
      events: [
        createPolicyObligationEvent("policy.ObligationEscalated", {
          obligationEvent,
          status: "escalated",
          time,
          reason: "auto-revert-unavailable",
          signal: sloBurnEvent,
        }),
      ],
    };
  }

  const revert = createFlagChanged(
    { key: flagChanged.data.key, type: flagChanged.data.valueType },
    {
      from: flagChanged.data.diff.value.to,
      to: flagChanged.data.diff.value.from,
      actor,
      reason: "auto-revert-slo-burn",
    },
  );
  revert.data.policyDecisionId = flagChanged.data.policyDecisionId;
  revert.data.policyDecisionInputHash = flagChanged.data.policyDecisionInputHash;
  revert.data.obligationId = obligationEvent.id;
  revert.data.sloBurnEventId = sloBurnEvent.id;

  return {
    status: "satisfied",
    events: [
      revert,
      createPolicyObligationEvent("policy.ObligationSatisfied", {
        obligationEvent,
        status: "satisfied",
        time,
        reason: "auto-revert-applied",
        signal: sloBurnEvent,
        resultEventId: revert.id,
      }),
    ],
  };
}

function normalizeFlipInput(input) {
  if (!input || !isJsonObject(input)) {
    throw new TypeError("flag flip input must be an object");
  }
  const ref = input.ref ?? input.flagRef;
  if (!ref || !isJsonString(ref.key) || !isJsonString(ref.type)) {
    throw new TypeError("flag flip input requires ref { key, type }");
  }
  if (!input.actor) {
    throw new TypeError("flag flip input requires actor");
  }

  return {
    ref,
    from: input.from,
    to: input.to,
    actor: input.actor,
    environment: input.environment ?? "dev",
    reason: input.reason ?? "flag-flip",
    time: input.time ?? new Date().toISOString(),
    killSwitch: input.killSwitch === true || input.metadata?.killSwitch === true,
    percentage: input.percentage === true || input.metadata?.percentage === true,
    history: Array.isArray(input.history) ? input.history : [],
  };
}

function mustRouteThroughPolicy(input, risk) {
  return input.environment === "prod" || risk.level === "risky";
}

function createPolicyRequest(input, risk, subjectOverride) {
  const subject = subjectOverride ?? {
    kind: SUBJECT_KINDS.has(input.actor.kind) ? input.actor.kind : "user",
    id: input.actor.id,
    roles: input.actor.claims
      ?.filter((claim) => claim.key === "role" && isJsonString(claim.value))
      .map((claim) => claim.value),
  };
  if (subject.roles?.length === 0) {
    delete subject.roles;
  }

  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject,
    action: FLAG_CHANGE_ACTION,
    resource: {
      kind: "flag",
      id: `flag:${input.ref.key}`,
    },
    phase: FLAG_CHANGE_PHASE,
    context: {
      environment: input.environment,
      flag: {
        key: input.ref.key,
        type: input.ref.type,
        from: input.from,
        to: input.to,
        killSwitch: input.killSwitch,
        percentage: input.percentage,
      },
      risk,
    },
  };
}

function createCommittedFlagChanged(input, { decision, decisionEvent, reason, risk }) {
  const event = createFlagChanged(input.ref, {
    from: input.from,
    to: input.to,
    actor: input.actor,
    reason,
  });
  if (decision && decisionEvent) {
    event.data.policyDecisionId = decisionEvent.id;
    event.data.policyDecisionInputHash = decision.evidence.inputHash;
    event.data.policyEffect = decision.effect;
  }
  event.data.risk = risk;
  return event;
}

function createObligationCreatedEvent({ obligation, decision, decisionEvent, flagChanged, index, time }) {
  const obligationId =
    obligation.id ?? `${decisionEvent.id}:obligation:${String(index + 1).padStart(2, "0")}`;

  return [
    createPolicyObligationEvent("policy.ObligationCreated", {
      id: obligationId,
      status: "open",
      time,
      obligation,
      decision,
      decisionEvent,
      flagChanged,
      reason: "policy decision attached durable obligation",
    }),
  ];
}

function createPolicyObligationEvent(type, input) {
  const id = input.id ?? `${input.obligationEvent.id}:${type.split(".").at(-1).toLowerCase()}`;
  return {
    id,
    type,
    schemaVersion: POLICY_GATED_FLAG_FLIPS_SCHEMA_VERSION,
    streamId: `policy-obligation:${input.obligationEvent?.id ?? input.id}`,
    data: {
      status: input.status,
      reason: input.reason,
      obligation: cloneJson(input.obligation ?? input.obligationEvent.data.obligation),
      policyDecisionId: input.decisionEvent?.id ?? input.obligationEvent.data.policyDecisionId,
      policyDecisionInputHash:
        input.decision?.evidence.inputHash ?? input.obligationEvent.data.policyDecisionInputHash,
      flagChangeEventId: input.flagChanged?.id ?? input.obligationEvent?.data.flagChangeEventId,
      signalEventId: input.signal?.id,
      resultEventId: input.resultEventId,
      time: input.time,
    },
  };
}

function applyPolicyMutations(value, mutations) {
  return mutations.reduce((current, mutation) => {
    if (mutation.kind === "flag.value.override" && Object.hasOwn(mutation, "value")) {
      return mutation.value;
    }
    if (mutation.op === "replace-value" && Object.hasOwn(mutation, "value")) {
      return mutation.value;
    }
    if (mutation.path === "$.to" && Object.hasOwn(mutation, "value")) {
      return mutation.value;
    }
    return current;
  }, value);
}

function isApprovalSatisfied(approval) {
  return approval?.approved === true && isJsonString(approval.approvedBy) && approval.approvedBy.length > 0;
}

function statusForEvents(events) {
  if (events.some((event) => event.type === "policy.ObligationEscalated")) {
    return "committed-obligation-escalated";
  }
  if (events.some((event) => event.type === "policy.ObligationSatisfied")) {
    return "committed-auto-reverted";
  }
  return "committed";
}

function numericDelta(input) {
  if (!input.percentage || input.ref.type !== "number") {
    return 0;
  }
  return Math.abs(Number(input.to) - Number(input.from));
}

function isRecentSameDirectionPercentChange(change, input, nowMs, velocityWindowMs) {
  if (!change || change.key !== input.ref.key || change.environment !== input.environment) {
    return false;
  }
  if (change.percentage !== true) {
    return false;
  }
  const changeMs = toMillis(change.time);
  if (nowMs - changeMs > velocityWindowMs) {
    return false;
  }
  const direction = Math.sign(Number(input.to) - Number(input.from));
  const changeDirection = Math.sign(Number(change.to) - Number(change.from));
  return direction !== 0 && direction === changeDirection;
}

function isSloBurnEvent(event) {
  return event?.type === "slo.BudgetBurned";
}

function toMillis(value) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return millis;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
