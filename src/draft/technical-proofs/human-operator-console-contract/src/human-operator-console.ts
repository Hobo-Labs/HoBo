import { createHash } from "node:crypto";

import {
  actionApplied,
  actionDenied,
  actionProposed,
  createOperatorPrincipal,
  policyDecided,
} from "../../crew-event-contract/src/crew-event-contract.js";
import { foldIncidentStream } from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const HUMAN_OPERATOR_CONSOLE_SCHEMA_VERSION = "hobo.human-operator-console/v1";
export const APPROVAL_OBLIGATION_KIND = "remediation.require-approval";

export const OPERATOR_MCP_TOOLS = Object.freeze([
  Object.freeze({
    name: "operator.list_incidents",
    access: "read",
    description: "List open incident projections with MTTD, MTTR, and decision trail.",
  }),
  Object.freeze({
    name: "operator.list_pending_approvals",
    access: "read",
    description: "List pending policy gates waiting for a human operator decision.",
  }),
  Object.freeze({
    name: "operator.decide_approval",
    access: "write",
    description: "Approve, deny, or abort a gated Crew action.",
  }),
]);

const APPROVAL_DECISIONS = new Set(["allow", "deny", "abort"]);
const APPROVER_ROLES = new Set(["approver", "incident-commander", "admin"]);
const APPROVER_PERMISSIONS = new Set(["operator.approve", "crew.approve", "policy.decide"]);

export function createRequireApprovalGate(input = {}) {
  const actionId = requiredString(input.actionId, "actionId");
  const incidentId = requiredString(input.incidentId, "incidentId");
  const correlationId = requiredString(input.correlationId, "correlationId");
  const action = validateActionSnapshot(input.action);
  const blastRadiusSnapshot = validateBlastRadiusSnapshot(input.blastRadiusSnapshot);
  const snapshotHash = hashApprovalSnapshot({ action, blastRadiusSnapshot });

  return deepFreeze({
    id: requiredString(input.id, "id"),
    type: "policy.ObligationCreated",
    schemaVersion: HUMAN_OPERATOR_CONSOLE_SCHEMA_VERSION,
    streamId: `policy-obligation:${incidentId}`,
    data: {
      kind: APPROVAL_OBLIGATION_KIND,
      status: "open",
      incidentId,
      correlationId,
      actionId,
      proposalId: requiredString(input.proposalId, "proposalId"),
      policyDecisionId: requiredString(input.policyDecisionId, "policyDecisionId"),
      action,
      blastRadiusSnapshot,
      actionSnapshotHash: snapshotHash,
      requestedAt: validateIso(input.requestedAt, "requestedAt"),
      requestedBy: requiredString(input.requestedBy, "requestedBy"),
      reason: requiredString(input.reason, "reason"),
    },
  });
}

export function buildOperatorConsoleProjection(eventsInput = []) {
  const events = requiredArray(eventsInput, "events");
  const incidents = foldIncidentGroups(events);
  const incidentById = new Map(incidents.map((incident) => [incident.id, incident]));
  const decisionTrailByIncident = new Map();

  for (const event of events) {
    const incidentId = incidentIdFor(event);
    const incident = incidentId ? incidentById.get(incidentId) : null;
    const correlationId = event.correlationId ?? event.data?.correlationId;
    const matchingIncident =
      incident ?? incidents.find((candidate) => candidate.correlationId === correlationId) ?? null;

    if (!matchingIncident || !isDecisionTrailEvent(event)) {
      continue;
    }

    if (!decisionTrailByIncident.has(matchingIncident.id)) {
      decisionTrailByIncident.set(matchingIncident.id, []);
    }
    decisionTrailByIncident.get(matchingIncident.id).push(trailEntry(event));
  }

  for (const trail of decisionTrailByIncident.values()) {
    trail.sort((left, right) => left.at.localeCompare(right.at));
  }

  const incidentsWithTrail = incidents
    .filter((incident) => !["resolved", "postmortem-filed"].includes(incident.status))
    .map((incident) =>
      deepFreeze({
        ...incident,
        decisionTrail: Object.freeze(decisionTrailByIncident.get(incident.id) ?? []),
      }),
    );

  return deepFreeze({
    schemaVersion: HUMAN_OPERATOR_CONSOLE_SCHEMA_VERSION,
    incidents: Object.freeze(incidentsWithTrail),
    pendingApprovals: Object.freeze(pendingApprovals(events)),
  });
}

export function decideApproval(input = {}) {
  const events = requiredArray(input.events, "events");
  const actionId = requiredString(input.actionId, "actionId");
  const actor = validateActor(input.actor);
  const decision = validateMember(input.decision ?? "allow", APPROVAL_DECISIONS, "decision");
  const expectedActionSnapshotHash = requiredString(
    input.expectedActionSnapshotHash,
    "expectedActionSnapshotHash",
  );
  const decidedAt = validateIso(input.decidedAt ?? new Date(0).toISOString(), "decidedAt");

  assertCanApprove(actor);

  const projection = buildOperatorConsoleProjection(events);
  const pending = projection.pendingApprovals.find((approval) => approval.actionId === actionId);
  if (!pending) {
    throw codedError("OPERATOR_APPROVAL_NOT_FOUND", `No pending approval for action ${actionId}.`);
  }
  if (pending.actionSnapshotHash !== expectedActionSnapshotHash) {
    throw codedError(
      "OPERATOR_APPROVAL_STALE",
      "Approval snapshot changed; reload the action and blast radius before deciding.",
    );
  }

  const policyDecision = policyDecided({
    id: `policy-operator-${slug(actionId)}-${slug(decision)}`,
    streamId: `policy:${pending.incidentId}`,
    seq: nextPolicySeq(events),
    ts: decidedAt,
    effect: decision === "allow" ? "allow" : "deny",
  });
  const approvedProposal = actionProposed({
    id: `proposal-operator-${slug(actionId)}-${policyDecision.seq}`,
    streamId: "crew:sre",
    seq: nextCrewSeq(events),
    ts: decidedAt,
    principal: defaultOperatorPrincipal(actor),
    correlationId: pending.correlationId,
    causationId: pending.obligationId,
    action: {
      kind: pending.action.kind,
      target: pending.action.target,
    },
    blastRadius: pending.blastRadiusSnapshot,
    policyDecisionId: policyDecision.id,
  });
  const crewDecision =
    decision === "allow"
      ? actionApplied({
          id: `applied-operator-${slug(actionId)}-${policyDecision.seq}`,
          streamId: "crew:sre",
          seq: approvedProposal.seq + 1,
          ts: decidedAt,
          principal: defaultOperatorPrincipal(actor),
          correlationId: pending.correlationId,
          causationId: approvedProposal.id,
          proposalId: approvedProposal.id,
          policyDecisionId: policyDecision.id,
        })
      : actionDenied({
          id: `${decision}-operator-${slug(actionId)}-${policyDecision.seq}`,
          streamId: "crew:sre",
          seq: approvedProposal.seq + 1,
          ts: decidedAt,
          principal: defaultOperatorPrincipal(actor),
          correlationId: pending.correlationId,
          causationId: approvedProposal.id,
          proposalId: approvedProposal.id,
          policyDecisionId: policyDecision.id,
          reason: decision === "abort" ? "aborted by human operator" : "denied by human operator",
        });
  const satisfied = {
    id: `approval-${slug(actionId)}-${policyDecision.seq}`,
    type: "policy.ObligationSatisfied",
    schemaVersion: HUMAN_OPERATOR_CONSOLE_SCHEMA_VERSION,
    streamId: `policy-obligation:${pending.incidentId}`,
    data: {
      kind: APPROVAL_OBLIGATION_KIND,
      status: "satisfied",
      rootObligationId: pending.obligationId,
      incidentId: pending.incidentId,
      correlationId: pending.correlationId,
      actionId,
      actionSnapshotHash: pending.actionSnapshotHash,
      decision,
      decidedAt,
      decidedBy: actor.subject,
    },
  };

  return deepFreeze({
    status: decision === "allow" ? "applied" : decision,
    policyDecision,
    crewDecision,
    events: [policyDecision, approvedProposal, crewDecision, satisfied],
  });
}

export function createHumanOperatorMcpSurface(options = {}) {
  const readEvents = options.readEvents ?? (() => options.events ?? []);
  const appendEvents = options.appendEvents ?? (() => {});

  return deepFreeze({
    listTools() {
      return OPERATOR_MCP_TOOLS;
    },

    async callTool(name, input = {}, callOptions = {}) {
      try {
        const projection = buildOperatorConsoleProjection(readEvents());
        if (name === "operator.list_incidents") {
          return success(name, { incidents: projection.incidents });
        }
        if (name === "operator.list_pending_approvals") {
          return success(name, { pendingApprovals: projection.pendingApprovals });
        }
        if (name === "operator.decide_approval") {
          const result = decideApproval({
            events: readEvents(),
            actionId: input.actionId,
            decision: input.decision,
            actor: input.actor ?? callOptions.actor,
            expectedActionSnapshotHash: input.expectedActionSnapshotHash,
            decidedAt: input.decidedAt,
          });
          appendEvents(result.events);
          return success(name, result);
        }

        return failure(name, "OPERATOR_TOOL_UNKNOWN", `Unknown operator tool ${name}.`);
      } catch (error) {
        return failure(name, error.code ?? "OPERATOR_TOOL_FAILED", error.message ?? "tool failed");
      }
    },
  });
}

export function hashApprovalSnapshot(input = {}) {
  const action = validateActionSnapshot(input.action);
  const blastRadiusSnapshot = validateBlastRadiusSnapshot(input.blastRadiusSnapshot);
  const hash = createHash("sha256")
    .update(stableStringify({ action, blastRadiusSnapshot }))
    .digest("hex");

  return `sha256:${hash}`;
}

function foldIncidentGroups(events) {
  const groups = new Map();
  for (const event of events) {
    const incidentId = event.payload?.incidentId;
    if (!incidentId || !event.type?.startsWith("incident.")) {
      continue;
    }
    if (!groups.has(incidentId)) {
      groups.set(incidentId, []);
    }
    groups.get(incidentId).push(event);
  }

  return [...groups.values()].map((group) => {
    const incident = foldIncidentStream(group);
    const openedAt = group.find((event) => event.type === "incident.Opened")?.occurredAt;
    const triagedAt = group.find((event) => event.type === "incident.Triaged")?.occurredAt;
    const remediatedAt = group.find((event) =>
      ["incident.RemediationApplied", "incident.Resolved"].includes(event.type),
    )?.occurredAt;

    return deepFreeze({
      id: incident.id,
      status: incident.status,
      severity: incident.severity,
      impact: incident.impact,
      correlationId: incident.correlationId,
      owner: incident.owner,
      mttdMs: openedAt && triagedAt ? Date.parse(triagedAt) - Date.parse(openedAt) : null,
      mttrMs: openedAt && remediatedAt ? Date.parse(remediatedAt) - Date.parse(openedAt) : null,
    });
  });
}

function pendingApprovals(events) {
  const latestByActionId = new Map();

  for (const event of events) {
    if (event.type === "policy.ObligationSatisfied" && event.data?.kind === APPROVAL_OBLIGATION_KIND) {
      latestByActionId.delete(event.data.actionId);
      continue;
    }

    if (event.type !== "policy.ObligationCreated" || event.data?.kind !== APPROVAL_OBLIGATION_KIND) {
      continue;
    }

    latestByActionId.set(event.data.actionId, {
      obligationId: event.id,
      incidentId: event.data.incidentId,
      correlationId: event.data.correlationId,
      actionId: event.data.actionId,
      proposalId: event.data.proposalId,
      policyDecisionId: event.data.policyDecisionId,
      action: event.data.action,
      blastRadiusSnapshot: event.data.blastRadiusSnapshot,
      actionSnapshotHash: event.data.actionSnapshotHash,
      requestedAt: event.data.requestedAt,
      requestedBy: event.data.requestedBy,
      reason: event.data.reason,
    });
  }

  return [...latestByActionId.values()].sort((left, right) =>
    left.requestedAt.localeCompare(right.requestedAt) || left.actionId.localeCompare(right.actionId),
  );
}

function isDecisionTrailEvent(event) {
  return (
    event.type === "policy.Decided" ||
    event.type === "policy.ObligationCreated" ||
    event.type === "policy.ObligationSatisfied" ||
    event.type === "crew.ActionProposed" ||
    event.type === "crew.ActionApplied" ||
    event.type === "crew.ActionDenied" ||
    event.type === "crew.HandoffRequested"
  );
}

function trailEntry(event) {
  return deepFreeze({
    id: event.id,
    type: event.type,
    at: eventTime(event),
    summary: trailSummary(event),
  });
}

function trailSummary(event) {
  if (event.type === "policy.Decided") {
    return `policy ${event.data.effect}`;
  }
  if (event.type === "policy.ObligationCreated") {
    return `${event.data.kind} opened`;
  }
  if (event.type === "policy.ObligationSatisfied") {
    return `${event.data.kind} ${event.data.decision}`;
  }
  if (event.type === "crew.ActionApplied") {
    return "crew action applied";
  }
  if (event.type === "crew.ActionDenied") {
    return event.data.reason;
  }
  if (event.type === "crew.HandoffRequested") {
    return event.data.reason;
  }
  return event.data?.action?.kind ?? event.type;
}

function incidentIdFor(event) {
  if (event.payload?.incidentId || event.data?.incidentId) {
    return event.payload?.incidentId ?? event.data?.incidentId;
  }
  if (event.type === "policy.Decided" && event.streamId?.startsWith("policy:")) {
    return event.streamId.slice("policy:".length);
  }
  return null;
}

function eventTime(event) {
  return event.occurredAt ?? event.ts ?? event.data?.decidedAt ?? event.data?.requestedAt ?? new Date(0).toISOString();
}

function assertCanApprove(actor) {
  if (
    actor.roles.some((role) => APPROVER_ROLES.has(role)) ||
    actor.permissions.some((permission) => APPROVER_PERMISSIONS.has(permission))
  ) {
    return;
  }

  throw codedError("OPERATOR_APPROVAL_FORBIDDEN", `${actor.subject} cannot approve gated actions.`);
}

function validateActor(actor) {
  if (!actor || !isJsonObject(actor) || Array.isArray(actor)) {
    throw codedError("OPERATOR_ACTOR_REQUIRED", "actor is required");
  }

  return deepFreeze({
    subject: requiredString(actor.subject, "actor.subject"),
    roles: validateStringList(actor.roles ?? [], "actor.roles"),
    permissions: validateStringList(actor.permissions ?? [], "actor.permissions"),
  });
}

function defaultOperatorPrincipal(actor) {
  return createOperatorPrincipal({
    name: actor.subject,
    svid: `spiffe://yard/acme/human/${slug(actor.subject)}`,
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "crew:approve"],
      spendCapUsd: 0,
      requireApprovalGates: [],
    },
    enginePort: "hobo:human-operator-console@0.1.0",
  });
}

function validateActionSnapshot(action) {
  if (!action || !isJsonObject(action) || Array.isArray(action)) {
    throw new Error("action is required");
  }

  return deepFreeze({
    ...action,
    kind: requiredString(action.kind, "action.kind"),
    target: requiredString(action.target, "action.target"),
  });
}

function validateBlastRadiusSnapshot(blastRadiusSnapshot) {
  if (!blastRadiusSnapshot || !isJsonObject(blastRadiusSnapshot) || Array.isArray(blastRadiusSnapshot)) {
    throw new Error("blastRadiusSnapshot is required");
  }

  return deepFreeze({
    ...blastRadiusSnapshot,
    environment: requiredString(blastRadiusSnapshot.environment, "blastRadiusSnapshot.environment"),
    maxResources: validatePositiveInteger(blastRadiusSnapshot.maxResources, "blastRadiusSnapshot.maxResources"),
    reversible: blastRadiusSnapshot.reversible === true,
  });
}

function nextCrewSeq(events) {
  return events
    .filter((event) => isJsonNumber(event.seq) && event.type?.startsWith("crew."))
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function nextPolicySeq(events) {
  return events
    .filter((event) => isJsonNumber(event.seq) && event.type === "policy.Decided")
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function success(toolName, data) {
  return { ok: true, tool: toolName, data };
}

function failure(toolName, code, message) {
  return {
    ok: false,
    tool: toolName,
    error: { code, message },
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateMember(value, allowed, fieldName) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${fieldName}: ${String(value)}`);
  }
  return value;
}

function validateStringList(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return Object.freeze([...new Set(value.map((entry) => requiredString(entry, fieldName)))]);
}

function validatePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
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

function requiredArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
