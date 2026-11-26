import { handleResourceDrift } from "../../../../technical-proofs/autonomous-drift-remediation-contract/src/autonomous-drift-remediation.js";
import {
  createOperatorPrincipal,
  handoffRequested,
} from "../../../../technical-proofs/crew-event-contract/src/crew-event-contract.js";
import { classifyFailureSignal } from "../../../../technical-proofs/failure-taxonomy-safe-fix-classifier/src/failure-taxonomy-classifier.js";
import { applyGatedRemediation } from "../../../../technical-proofs/gated-autonomous-remediation-contract/src/gated-autonomous-remediation.js";
import { runHoboUp, sampleSnapshopProject } from "../../../../technical-proofs/hobo-up-convergence-contract/src/up-convergence.js";
import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../../../technical-proofs/incident-aggregate-contract/src/incident-aggregate.js";
import { evaluateRemediationSafety } from "../../../../technical-proofs/remediation-safety-gate-contract/src/remediation-safety-gate.js";
import {
  createProjectionReadStore,
  diagnoseIncident,
} from "../../../../technical-proofs/sre-diagnose-projection-contract/src/sre-diagnose-projection.js";
import { isJsonString, isJsonObject } from "./json.js";


export const SRE_DRIFT_REMEDIATION_JOURNEY_VERSION =
  "hobo.sre-drift-remediation-journey/v1";

export async function runSreDriftRemediationJourney(input = {}) {
  const drift = normalizeDrift(input.drift);
  const operator = normalizeOperator(input.operator);
  const sourceEvent = driftDetectedEvent(drift);
  const incidentEvents = createIncidentEvents(drift);
  const diagnosis = diagnoseIncident({
    incidentEvents,
    projections: createDriftProjectionStore(drift),
    runbook: input.runbook ?? defaultRunbook(drift.resourceId),
    diagnosedAt: input.diagnosedAt ?? "2026-06-28T09:01:00.000Z",
    operator: { principal: operator },
  });
  const rootCausedIncidentEvents = [...incidentEvents, diagnosis.rootCauseEvent].filter(Boolean);
  const baseStream = flattenEvents(sourceEvent, rootCausedIncidentEvents);

  if (input.desiredStateDisposition === "adopt-observed") {
    const adopted = desiredStateAdoptedEvent(drift);
    const eventStream = flattenEvents(baseStream, adopted);

    return freeze({
      status: "desired-state-accepted",
      drift,
      diagnosis,
      waiting: null,
      approved: null,
      reconcile: null,
      cli: buildCli({ drift, diagnosis, eventStream, driftStatus: "accepted-as-new-desired-state" }),
      eventStream,
    });
  }

  const waiting = await handleResourceDrift({
    drift,
    policies: input.policies ?? defaultPolicies(drift),
    incidentEvents: rootCausedIncidentEvents,
    decidedAt: input.decidedAt ?? "2026-06-28T09:02:00.000Z",
    operator,
    gateway: input.gateway ?? recordingGateway(drift.resourceId),
    gateSignal: input.gateSignal ?? (() => ({ decision: "pass", reason: "healthy" })),
    healthGate: input.healthGate,
    canaryPercentages: input.canaryPercentages,
  });
  let eventStream = flattenEvents(baseStream, waiting.events);

  if (waiting.status === "waiting-for-approval" && input.approval) {
    if (isSelfApproval(input.approval, operator)) {
      const rejected = approvalRejectedEvent({ drift, approval: input.approval, operator });
      eventStream = flattenEvents(eventStream, rejected);

      return freeze({
        status: "approval-denied",
        drift,
        diagnosis,
        waiting,
        approved: null,
        reconcile: null,
        cli: buildCli({ drift, diagnosis, eventStream }),
        eventStream,
      });
    }

    const approved = await applyGatedRemediation({
      priorEvents: waiting.events,
      incidentEvents: rootCausedIncidentEvents,
      action: waiting.action,
      approval: input.approval,
      decidedAt: input.approvedDecisionAt ?? "2026-06-28T09:11:00.000Z",
      operator,
      gateway: input.gateway ?? recordingGateway(drift.resourceId),
      gateSignal: input.gateSignal ?? (() => ({ decision: "pass", reason: "healthy" })),
      healthGate: input.healthGate,
      canaryPercentages: input.canaryPercentages,
    });
    const reconcile = await reconcileDesiredState({
      drift,
      gate: input.reconcileGate,
      startedAt: input.reconcileStartedAt ?? "2026-06-28T09:12:00.000Z",
    });

    eventStream = flattenEvents(eventStream, approved.events, reconcile.first.events, reconcile.second?.events ?? []);

    return freeze({
      status: reconcile.first.status === "blocked" ? "reconcile-blocked" : "reconciled",
      drift,
      diagnosis,
      waiting,
      approved,
      reconcile,
      cli: buildCli({ drift, diagnosis, eventStream }),
      eventStream,
    });
  }

  if (waiting.status === "applied") {
    const reconcile = await reconcileDesiredState({
      drift,
      gate: input.reconcileGate,
      startedAt: input.reconcileStartedAt ?? "2026-06-28T09:12:00.000Z",
    });
    eventStream = flattenEvents(eventStream, reconcile.first.events, reconcile.second?.events ?? []);

    return freeze({
      status: reconcile.first.status === "blocked" ? "reconcile-blocked" : "reconciled",
      drift,
      diagnosis,
      waiting,
      approved: waiting,
      reconcile,
      cli: buildCli({ drift, diagnosis, eventStream }),
      eventStream,
    });
  }

  return freeze({
    status: waiting.status,
    drift,
    diagnosis,
    waiting,
    approved: null,
    reconcile: null,
    cli: buildCli({ drift, diagnosis, eventStream }),
    eventStream,
  });
}

export function replaySreDriftRemediationJourney(eventStream = []) {
  const events = normalizeEventStream(eventStream);
  const types = new Set(events.map((event) => event.type));
  const status = replayStatus(types);
  const approvalSatisfied = events.find((event) => event.type === "policy.ObligationSatisfied");

  return freeze({
    status,
    drift: {
      detected: types.has("resource.DriftDetected"),
      acceptedAsDesired: types.has("desiredState.Adopted"),
    },
    approvalGate: {
      awaited: types.has("policy.ObligationCreated"),
      rejected: types.has("policy.ApprovalRejected"),
      approvedBy: approvalSatisfied?.data?.approvedBy ?? null,
    },
    hoboUpStatuses: replayHoboUpStatuses(events),
    eventCount: events.length,
  });
}

export function triageUnclassifiableIncident(input = {}) {
  const signal = normalizeUnknownSignal(input.signal);
  const deadlineAt = validateIso(input.deadlineAt, "deadlineAt");
  const operator = normalizeOperator(input.operator);
  const classification = classifyFailureSignal(signal);
  const handoff = handoffRequested({
    id: `handoff-unclassifiable-${slug(signal.id)}`,
    streamId: "crew:sre",
    seq: 1,
    ts: signal.occurredAt,
    principal: operator,
    correlationId: signal.correlationId,
    causationId: signal.id,
    target: { kind: "human", name: "on-call" },
    reason: `unclassifiable incident; human decision required by ${deadlineAt}`,
  });
  const deadline = {
    id: `deadline-unclassifiable-${slug(signal.id)}`,
    type: "policy.ObligationCreated",
    schemaVersion: SRE_DRIFT_REMEDIATION_JOURNEY_VERSION,
    ts: signal.occurredAt,
    data: {
      kind: "incident.escalation-deadline",
      signalId: signal.id,
      deadlineAt,
      target: "on-call",
    },
  };

  return freeze({
    status: "escalated",
    classification,
    handoff,
    deadlineAt,
    events: flattenEvents(handoff, deadline),
  });
}

export function evaluateCrewWritePolicy(input = {}) {
  return evaluateRemediationSafety({
    signal: input.signal ?? safetySignal(),
    corroboratingSignals: input.corroboratingSignals ?? [safetySignal({ id: "drift-api-metrics", source: "drift-view" })],
    action: input.action ?? safetyResyncAction(),
    operator: input.operator ?? srePrincipal(),
    rbac: input.rbac ?? {
      subjectId: "spiffe://yard/acme/agent/sre",
      roles: ["sre-operator"],
      roleGrants: { "sre-operator": ["remediation:apply"] },
    },
    attemptedAllow: input.attemptedAllow,
    costEstimateUsd: input.costEstimateUsd ?? 1,
    spendLedger: input.spendLedger ?? {
      currentUsd: 0,
      capUsd: 50,
      scopeKey: "camp:prod",
      windowId: "2026-06",
    },
    priorEvents: input.priorEvents,
    decidedAt: input.decidedAt ?? "2026-06-28T09:30:00.000Z",
  });
}

async function reconcileDesiredState({ drift, gate, startedAt }) {
  const clock = sequentialClock(startedAt);
  const idFactory = deterministicIdFactory();
  const options = {
    now: clock,
    idFactory,
    collectResources: () => ({
      schema: "hobo.manifest/v1",
      revision: drift.desiredSetRef,
      resources: [{ id: drift.resourceId, type: "service", deps: [] }],
    }),
    evaluateGate: () => gate ?? { status: "passed", gateId: `gate-${slug(drift.resourceId)}` },
  };
  const project = sampleSnapshopProject({
    name: "snapshop",
    deploymentId: `deployment:${drift.resourceId}`,
    defaultCampId: drift.environment,
    currentRevision: drift.desiredSetRef,
    resources: [{ id: drift.resourceId, type: "service", deps: [] }],
  });
  const flags = { camp: drift.environment, strategy: "recreate" };
  const first = await runHoboUp({ project, flags }, options);
  const second =
    first.status === "deployed"
      ? await runHoboUp({ project, flags, eventLog: first.events }, options)
      : null;

  return freeze({ first, second });
}

function createIncidentEvents(drift) {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: `incident-open-${slug(drift.id)}`,
    incidentId: drift.incidentId,
    correlationId: drift.correlationId,
    causationId: drift.id,
    occurredAt: drift.occurredAt,
    payload: {
      severity: drift.severity,
      impact: `drift detected on ${drift.resourceId}`,
      causedBy: [{ id: drift.id, type: drift.type, correlationId: drift.correlationId }],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: `incident-triaged-${slug(drift.id)}`,
    incidentId: drift.incidentId,
    correlationId: drift.correlationId,
    causationId: opened.id,
    occurredAt: "2026-06-28T09:00:30.000Z",
    payload: { owner: "operator:sre" },
  });

  return [opened, triaged];
}

function createDriftProjectionStore(drift) {
  return createProjectionReadStore({
    [`tail_logs ${drift.resourceId}`]: {
      atSeq: 3,
      value: {
        topError: `resource.DriftDetected ${drift.resourceId} observed ${drift.observedRef}`,
      },
    },
    [`get_drift ${drift.resourceId}`]: {
      atSeq: 4,
      value: {
        desiredSetRef: drift.desiredSetRef,
        observedRef: drift.observedRef,
      },
    },
    [`slo_status ${drift.resourceId}`]: {
      atSeq: 5,
      value: {
        rootCauseHint: `desired state drift for ${drift.resourceId}`,
      },
    },
  });
}

function defaultRunbook(resourceId) {
  return {
    diagnose: [`tail_logs ${resourceId}`, `get_drift ${resourceId}`, `slo_status ${resourceId}`],
  };
}

function defaultPolicies(drift) {
  return {
    [drift.resourceId]: {
      mode: "heal",
      environment: drift.environment,
      estimatedImpact: drift.environment === "prod" ? "medium" : "low",
    },
  };
}

function buildCli({ drift, diagnosis, eventStream, driftStatus = "detected" }) {
  return freeze({
    inspect: {
      command: `hobo inspect incident ${drift.incidentId}`,
      incidentId: drift.incidentId,
      status: diagnosis.rootCauseEvent ? "root-cause-identified" : "opened",
      causedBy: [{ id: drift.id, type: drift.type, correlationId: drift.correlationId }],
      diagnosis: diagnosis.diagnosis,
      readOnlyQueries: diagnosis.diagnosis.evidence?.map((entry) => entry.query) ?? [],
    },
    drift: {
      command: `hobo drift ${drift.resourceId}`,
      status: driftStatus,
      resourceId: drift.resourceId,
      desiredSetRef: drift.desiredSetRef,
      observedRef: drift.observedRef,
    },
    logs: {
      command: `hobo logs --tail incident ${drift.incidentId}`,
      items: normalizeEventStream(eventStream).map((event) => ({
        type: event.type,
        id: event.id,
        ts: event.ts,
      })),
    },
  });
}

function driftDetectedEvent(drift) {
  return {
    id: drift.id,
    type: "resource.DriftDetected",
    schemaVersion: SRE_DRIFT_REMEDIATION_JOURNEY_VERSION,
    ts: drift.occurredAt,
    correlationId: drift.correlationId,
    data: {
      resourceId: drift.resourceId,
      environment: drift.environment,
      desiredSetRef: drift.desiredSetRef,
      observedRef: drift.observedRef,
    },
  };
}

function desiredStateAdoptedEvent(drift) {
  return {
    id: `desired-state-adopted-${slug(drift.id)}`,
    type: "desiredState.Adopted",
    schemaVersion: SRE_DRIFT_REMEDIATION_JOURNEY_VERSION,
    ts: "2026-06-28T09:02:00.000Z",
    correlationId: drift.correlationId,
    causationId: drift.id,
    data: {
      resourceId: drift.resourceId,
      observedRef: drift.observedRef,
      reason: "operator marked provider state as the new desired state",
    },
  };
}

function approvalRejectedEvent({ drift, approval, operator }) {
  return {
    id: `approval-rejected-${slug(drift.id)}`,
    type: "policy.ApprovalRejected",
    schemaVersion: SRE_DRIFT_REMEDIATION_JOURNEY_VERSION,
    ts: approval.approvedAt,
    correlationId: drift.correlationId,
    data: {
      reason: "separation-of-duties-self-approval",
      approvedBy: approval.approvedBy,
      proposingAgent: operator.svid,
    },
  };
}

function normalizeDrift(candidate = {}) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError("drift must be an object");
  }
  if (candidate.type !== "resource.DriftDetected") {
    throw new TypeError("drift.type must be resource.DriftDetected");
  }
  const resourceId = requiredString(candidate.resourceId, "drift.resourceId");
  const environment = candidate.environment ?? "prod";

  return freeze({
    id: requiredString(candidate.id, "drift.id"),
    type: candidate.type,
    resourceId,
    environment,
    occurredAt: validateIso(candidate.occurredAt ?? "2026-06-28T09:00:00.000Z", "drift.occurredAt"),
    correlationId: candidate.correlationId ?? `corr-${resourceId}`,
    incidentId: candidate.incidentId ?? `incident-${resourceId}`,
    severity: candidate.severity ?? "SEV2",
    tenant: candidate.tenant ?? "tenant-a",
    desiredSetRef: requiredString(candidate.desiredSetRef, "drift.desiredSetRef"),
    observedRef: requiredString(candidate.observedRef, "drift.observedRef"),
  });
}

function normalizeUnknownSignal(candidate = {}) {
  return freeze({
    ...candidate,
    id: requiredString(candidate.id, "signal.id"),
    type: requiredString(candidate.type, "signal.type"),
    correlationId: requiredString(candidate.correlationId, "signal.correlationId"),
    occurredAt: validateIso(candidate.occurredAt ?? "2026-06-28T09:20:00.000Z", "signal.occurredAt"),
  });
}

function normalizeOperator(input) {
  return createOperatorPrincipal(input?.principal ?? input ?? srePrincipal());
}

function srePrincipal(overrides = {}) {
  return {
    name: overrides.name ?? "SRE",
    svid: overrides.svid ?? "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: overrides.scopedCapabilities ?? [
        "incident:read",
        "remediation:propose",
        "remediation:apply",
      ],
      spendCapUsd: overrides.spendCapUsd ?? 50,
      requireApprovalGates: overrides.requireApprovalGates ?? ["prod", "destroy", "over-budget"],
    },
    enginePort: overrides.enginePort ?? "hobo:sre-engine/built-in@0.1.0",
  };
}

function safetySignal({ id = "drift-api-signal", source = "sre-drift-view" } = {}) {
  return {
    id,
    type: "resource.DriftDetected",
    correlationId: "corr-api-prod",
    targetId: "api",
    source,
    occurredAt: "2026-06-28T09:30:00.000Z",
    severity: "SEV2",
    provenance: {
      issuer: "spiffe://yard/acme/probe/drift",
      signature: "valid",
    },
  };
}

function safetyResyncAction() {
  return {
    kind: "resync",
    target: { kind: "resource", id: "api" },
    environment: "prod",
    idempotencyKey: "drift:api:set-good:observed-drifted",
    conformanceState: "green",
    blastRadius: {
      scope: "resource",
      reversible: true,
      compensationPath: "resync:restore-last-known-good",
      estimatedImpact: "medium",
    },
  };
}

function isSelfApproval(approval, operator) {
  return approval.approvedBy === operator.svid || approval.approvedBy === operator.name;
}

function recordingGateway(routeId) {
  return {
    state: {
      routeId,
      activeVersion: "desired-set@previous",
      split: {
        "desired-set@previous": 100,
        "desired-set@resync": 0,
      },
    },
    async apply(command) {
      if (command.kind === "gateway.shiftTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.toWeight === 100 ? command.toVersion : command.fromVersion,
          split: {
            [command.fromVersion]: 100 - command.toWeight,
            [command.toVersion]: command.toWeight,
          },
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "gateway.rollbackTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.restoredVersion,
          split: {
            [command.restoredVersion]: 100,
            [command.revertedVersion]: 0,
          },
        };
        return { status: "applied", state: this.state };
      }

      throw new Error(`unexpected gateway command ${command.kind}`);
    },
  };
}

function replayStatus(types) {
  if (types.has("desiredState.Adopted")) return "desired-state-accepted";
  if (types.has("policy.ApprovalRejected")) return "approval-denied";
  if (types.has("deployment.PlanRejected")) return "reconcile-blocked";
  if (types.has("deployment.UpNoop")) return "reconciled";
  if (types.has("policy.ObligationCreated") && !types.has("crew.ActionApplied")) return "waiting-for-approval";
  return "unknown";
}

function replayHoboUpStatuses(events) {
  return events.flatMap((event) => {
    if (event.type === "deployment.UpCompleted") return ["deployed"];
    if (event.type === "deployment.UpNoop") return ["noop"];
    if (event.type === "deployment.PlanRejected") return ["blocked"];
    return [];
  });
}

function normalizeEventStream(eventStream) {
  if (!Array.isArray(eventStream)) {
    throw new TypeError("eventStream must be an array");
  }
  return eventStream.map((event, index) => normalizeStreamEvent(event, index));
}

function flattenEvents(...sources) {
  const flattened = [];
  for (const source of sources) {
    appendFlattened(flattened, source);
  }

  const seen = new Set();
  return freeze(
    flattened
      .map((event, index) => normalizeStreamEvent(event, index))
      .filter((event) => {
        const key = event.id ? `${event.type}:${event.id}` : `${event.type}:${event.replaySeq}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
  );
}

function appendFlattened(target, source) {
  if (!source) return;
  if (Array.isArray(source)) {
    for (const entry of source) appendFlattened(target, entry);
    return;
  }
  if (source.crew || source.incident || source.policy || source.rollout || source.drift) {
    appendFlattened(target, source.incident);
    appendFlattened(target, source.crew);
    appendFlattened(target, source.policy);
    appendFlattened(target, source.rollout);
    appendFlattened(target, source.drift);
    return;
  }
  target.push(source);
}

function normalizeStreamEvent(event, index) {
  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    throw new TypeError("stream event must be an object");
  }
  return {
    ...event,
    replaySeq: index + 1,
    ts: event.ts ?? event.occurredAt ?? event.time ?? "1970-01-01T00:00:00.000Z",
  };
}

function deterministicIdFactory() {
  let next = 0;
  return (prefix) => `${prefix}-${++next}`;
}

function sequentialClock(startIso) {
  const start = Date.parse(validateIso(startIso, "startIso"));
  let tick = 0;
  return () => new Date(start + tick++ * 60_000).toISOString();
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${fieldName} is required`);
  }
  return value.trim();
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function freeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  if (value instanceof Map || value instanceof Set) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}
