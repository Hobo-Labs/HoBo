import { isJsonString, isJsonObject } from "./json.js";
export const CREW_EVENT_TYPES = Object.freeze([
  "crew.AgentDispatched",
  "crew.ActionProposed",
  "crew.ActionApplied",
  "crew.ActionDenied",
  "crew.HandoffRequested",
]);

const crewEventTypes = new Set(CREW_EVENT_TYPES);
const policyEffects = new Set(["allow", "deny", "warn", "require-approval"]);
const actionApplyingPolicyEffects = new Set(["allow", "warn"]);
const actionDenyingPolicyEffects = new Set(["deny", "require-approval"]);
const targetKinds = new Set(["operator", "human"]);

export function createOperatorPrincipal(input) {
  const policy = input?.perAgentPolicy ?? {};

  return deepFreeze({
    name: requiredString(input?.name, "name"),
    svid: validateSvid(input?.svid),
    perAgentPolicy: {
      scopedCapabilities: validateStringList(policy.scopedCapabilities, "perAgentPolicy.scopedCapabilities"),
      spendCapUsd: validateNonNegativeNumber(policy.spendCapUsd, "perAgentPolicy.spendCapUsd"),
      requireApprovalGates: validateStringList(
        policy.requireApprovalGates,
        "perAgentPolicy.requireApprovalGates",
      ),
    },
    enginePort: requiredString(input?.enginePort, "enginePort"),
    disabled: input?.disabled === true,
  });
}

export function policyDecided(input) {
  return deepFreeze({
    id: requiredString(input?.id, "id"),
    type: "policy.Decided",
    v: 1,
    streamId: requiredString(input?.streamId, "streamId"),
    seq: validateSeq(input?.seq),
    ts: validateIso(input?.ts, "ts"),
    data: {
      effect: validateMember(field(input, "effect"), policyEffects, "effect"),
    },
  });
}

export function agentDispatched(input) {
  return crewEnvelope("crew.AgentDispatched", input, {
    trigger: validateRef(field(input, "trigger"), "trigger"),
  });
}

export function actionProposed(input) {
  return crewEnvelope("crew.ActionProposed", input, {
    action: validateAction(field(input, "action")),
    blastRadius: validateBlastRadius(field(input, "blastRadius")),
    policyDecisionId: requiredString(field(input, "policyDecisionId"), "policyDecisionId"),
  });
}

export function actionApplied(input) {
  return crewEnvelope("crew.ActionApplied", input, {
    proposalId: requiredString(field(input, "proposalId"), "proposalId"),
    policyDecisionId: requiredString(field(input, "policyDecisionId"), "policyDecisionId"),
  });
}

export function actionDenied(input) {
  return crewEnvelope("crew.ActionDenied", input, {
    proposalId: requiredString(field(input, "proposalId"), "proposalId"),
    policyDecisionId: requiredString(field(input, "policyDecisionId"), "policyDecisionId"),
    reason: requiredString(field(input, "reason"), "reason"),
  });
}

export function handoffRequested(input) {
  return crewEnvelope("crew.HandoffRequested", input, {
    target: validateTarget(field(input, "target")),
    reason: requiredString(field(input, "reason"), "reason"),
  });
}

export function roundTripCrewEvent(event) {
  return validateCrewEvent(JSON.parse(JSON.stringify(event)));
}

export function validateCrewEvent(event) {
  if (!event || !isJsonObject(event)) {
    throw new Error("event is required");
  }

  if (event.type === "policy.Decided") {
    return policyDecided(event);
  }

  if (!crewEventTypes.has(event.type)) {
    throw new Error(`unsupported event type: ${event.type}`);
  }

  switch (event.type) {
    case "crew.AgentDispatched":
      return agentDispatched(event);
    case "crew.ActionProposed":
      return actionProposed(event);
    case "crew.ActionApplied":
      return actionApplied(event);
    case "crew.ActionDenied":
      return actionDenied(event);
    case "crew.HandoffRequested":
      return handoffRequested(event);
    default:
      throw new Error(`unsupported event type: ${event.type}`);
  }
}

export function foldCrewStream(events) {
  const policyDecisions = new Map();
  const proposals = new Map();
  const closedProposals = new Set();
  const handoffsByCorrelation = new Map();
  const actions = [];
  const handoffs = [];

  for (const event of events.map(validateCrewEvent)) {
    if (event.type === "policy.Decided") {
      policyDecisions.set(event.id, event);
      continue;
    }

    if (event.type === "crew.ActionProposed") {
      if (proposals.has(event.id)) {
        throw new Error(`duplicate crew.ActionProposed id: ${event.id}`);
      }
      proposals.set(event.id, event);
      continue;
    }

    if (event.type === "crew.ActionApplied" || event.type === "crew.ActionDenied") {
      const proposal = proposals.get(event.data.proposalId);
      if (!proposal) {
        throw new Error(`${event.type} without preceding crew.ActionProposed`);
      }
      const decision = policyDecisions.get(event.data.policyDecisionId);
      if (!decision) {
        throw new Error(`${event.type} without preceding policy.Decided`);
      }
      if (proposal.data.policyDecisionId !== event.data.policyDecisionId) {
        throw new Error(`${event.type} references a different policy.Decided than its proposal`);
      }
      if (proposal.correlationId !== event.correlationId) {
        throw new Error(`${event.type} correlationId does not match its proposal`);
      }
      if (event.type === "crew.ActionApplied" && !actionApplyingPolicyEffects.has(decision.data.effect)) {
        throw new Error("crew.ActionApplied requires an allow or warn policy.Decided effect");
      }
      if (event.type === "crew.ActionDenied" && !actionDenyingPolicyEffects.has(decision.data.effect)) {
        throw new Error("crew.ActionDenied requires a deny or require-approval policy.Decided effect");
      }
      if (closedProposals.has(event.data.proposalId)) {
        throw new Error(`${event.data.proposalId} already resolved`);
      }

      closedProposals.add(event.data.proposalId);
      const summary = {
        operator: proposal.principal.name,
        action: proposal.data.action.kind,
        target: proposal.data.action.target,
        policyDecisionId: event.data.policyDecisionId,
        status: event.type === "crew.ActionApplied" ? "applied" : "denied",
      };
      if (event.type === "crew.ActionApplied") {
        summary.appliedAt = event.ts;
      }
      actions.push(deepFreeze(summary));
      continue;
    }

    if (event.type === "crew.HandoffRequested") {
      const prior = handoffsByCorrelation.get(event.correlationId);
      if (prior && event.causationId !== prior.id) {
        throw new Error(`handoff race for correlationId ${event.correlationId}`);
      }

      handoffsByCorrelation.set(event.correlationId, event);
      handoffs.push(event);
      continue;
    }
  }

  return deepFreeze({
    actions,
    handoffs,
  });
}

function crewEnvelope(type, input, data) {
  return deepFreeze({
    id: requiredString(input?.id, "id"),
    type,
    v: 1,
    streamId: requiredString(input?.streamId, "streamId"),
    seq: validateSeq(input?.seq),
    ts: validateIso(input?.ts, "ts"),
    principal: createOperatorPrincipal(input?.principal),
    correlationId: requiredString(input?.correlationId, "correlationId"),
    ...(input?.causationId ? { causationId: requiredString(input.causationId, "causationId") } : undefined),
    data,
  });
}

function field(input, name) {
  return input?.[name] ?? input?.data?.[name];
}

function validateAction(value) {
  if (!value || !isJsonObject(value)) {
    throw new Error("action is required");
  }

  return deepFreeze({
    kind: requiredString(value.kind, "action.kind"),
    ...(value.target !== undefined ? { target: requiredString(value.target, "action.target") } : undefined),
  });
}

function validateBlastRadius(value) {
  if (!value || !isJsonObject(value)) {
    throw new Error("blastRadius is required");
  }

  return deepFreeze({
    environment: requiredString(value.environment, "blastRadius.environment"),
    maxResources: validatePositiveInteger(value.maxResources, "blastRadius.maxResources"),
    reversible: value.reversible === true,
  });
}

function validateTarget(value) {
  if (!value || !isJsonObject(value)) {
    throw new Error("target is required");
  }

  return deepFreeze({
    kind: validateMember(value.kind, targetKinds, "target.kind"),
    name: requiredString(value.name, "target.name"),
  });
}

function validateRef(value, fieldName) {
  if (!value || !isJsonObject(value)) {
    throw new Error(`${fieldName} is required`);
  }

  return deepFreeze({
    type: requiredString(value.type, `${fieldName}.type`),
    id: requiredString(value.id, `${fieldName}.id`),
  });
}

function validateSvid(value) {
  const svid = requiredString(value, "svid");
  if (!svid.startsWith("spiffe://")) {
    throw new Error("svid must be a SPIFFE URI");
  }

  return svid;
}

function validateStringList(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  return Object.freeze([...new Set(value.map((entry) => requiredString(entry, fieldName)))]);
}

function validateNonNegativeNumber(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be non-negative`);
  }

  return value;
}

function validatePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }

  return value;
}

function validateSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("seq must be a non-negative safe integer");
  }

  return value;
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }

  return text;
}

function validateMember(value, allowed, fieldName) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${fieldName}: ${value}`);
  }

  return value;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
