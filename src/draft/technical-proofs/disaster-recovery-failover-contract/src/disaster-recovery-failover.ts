import {
  applyGatedRemediation,
  replayGatedRemediation,
} from "../../gated-autonomous-remediation-contract/src/gated-autonomous-remediation.js";
import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  RUNBOOK_EVENT_TYPES,
  defineRunbook,
  foldRunbookEvents,
  makeRunbookEvent,
} from "../../runbook-contract/src/runbook-contract.js";

export const DISASTER_RECOVERY_CONTRACT_VERSION = "hobo.disaster-recovery-failover/v1";
export const DISASTER_RECOVERY_RUNBOOK_NAME = "disaster-recovery-failover";

export async function orchestrateDisasterRecovery(input = {}) {
  const incidentEvents = requiredArray(input.incidentEvents, "incidentEvents");
  const incidentBeforeRootCause = foldIncidentStream(incidentEvents);
  const sourceLog = validateSourceLog(input.sourceLog);
  const lease = validateLease(input.lease);
  const targetYard = validateTargetYard(input.targetYard);
  const detectedAt = validateIso(
    input.detectedAt ?? incidentBeforeRootCause.timeline.at(-1)?.occurredAt ?? new Date(0).toISOString(),
    "detectedAt",
  );
  const restoredAt = validateIso(input.restoredAt ?? addMilliseconds(detectedAt, 8 * 60 * 1000), "restoredAt");
  const rpoTargetMs = nonNegativeInteger(input.rpoTargetMs ?? 0, "rpoTargetMs");
  const rtoTargetMs = nonNegativeInteger(input.rtoTargetMs ?? 15 * 60 * 1000, "rtoTargetMs");
  const runbook = buildRunbook({ targetYard, input, incidentId: incidentBeforeRootCause.id });
  const action = runbook.fix[0].action;
  const rootedIncidentEvents = appendRootCauseIfNeeded({
    incidentEvents,
    incident: incidentBeforeRootCause,
    detectedAt,
    targetYard,
  });
  const incident = foldIncidentStream(rootedIncidentEvents);
  const fencing = evaluateFence({ lease, stalePrimaryAppend: input.stalePrimaryAppend });
  const restore = calculateRestore({ sourceLog, detectedAt, restoredAt, rpoTargetMs, rtoTargetMs });
  const runbookEvents = createRunbookEvents({
    runbook,
    incident,
    detectedAt,
    targetYard,
    sourceLog,
    restore,
    fencing,
  });
  const remediation = await applyGatedRemediation({
    action,
    incidentEvents: rootedIncidentEvents,
    decidedAt: detectedAt,
    gateway: input.gateway,
    tenant: input.tenant ?? "tenant-platform",
    canaryPercentages: input.canaryPercentages ?? [100],
    healthGate: input.healthGate ?? {
      id: `${targetYard.id}-restore-health`,
      timeoutMs: 300000,
      passAfterConsecutive: 1,
      failAfterConsecutive: 1,
    },
    rolloutTarget: {
      service: input.rolloutTarget?.service ?? "yard-control-plane",
      routeId: input.rolloutTarget?.routeId ?? `${targetYard.region}-yard-control-plane`,
      fromVersion: input.rolloutTarget?.fromVersion ?? lease.previousOwnerNode,
      toVersion: input.rolloutTarget?.toVersion ?? targetYard.id,
    },
    gateSignal: input.gateSignal,
  });
  const resolvedIncidentEvents = appendResolutionEvents({
    incidentEvents: remediation.events.incident,
    incident,
    action,
    restore,
    restoredAt,
  });

  return deepFreeze({
    status: "restored",
    contractVersion: DISASTER_RECOVERY_CONTRACT_VERSION,
    runbook,
    failover: { action },
    remediation: {
      ...remediation,
      replay: replayGatedRemediation(remediation.events),
    },
    restore,
    fencing,
    events: {
      runbook: runbookEvents,
      crew: remediation.events.crew,
      incident: resolvedIncidentEvents,
      policy: remediation.events.policy,
      rollout: remediation.events.rollout,
    },
  });
}

export function replayDisasterRecovery(eventsInput = {}) {
  const events = normalizeEvents(eventsInput);
  const runbookReplay = foldRunbookEvents(events.runbook);
  const incident = foldIncidentStream(events.incident);
  const restore = restoreFromRunbookEvents(events.runbook);

  return deepFreeze({
    status: incident.status === "postmortem-filed" && runbookReplay.status === "completed"
      ? "restored"
      : "running",
    runbook: runbookReplay,
    incident,
    restore,
  });
}

export function buildDisasterRecoveryPostmortem(eventsInput = {}) {
  const replay = replayDisasterRecovery(eventsInput);
  const rpo = replay.restore.rpo;
  const rto = replay.restore.rto;
  const lossLine = rpo.claimsZeroDataLoss
    ? "zero data loss claimed from synchronous quorum"
    : `bounded-staleness RPO: ${rpo.ms}ms; unreplicated seq ${rpo.unreplicatedSeqRange.join("-")}`;

  return [
    `DR replay ${replay.status} for ${replay.incident.id}`,
    lossLine,
    `RTO: ${rto.ms}ms (${rto.withinTarget ? "within" : "outside"} target)`,
  ].join("; ");
}

function buildRunbook({ targetYard, input, incidentId }) {
  const action = {
    kind: "failover",
    target: { kind: "region", id: targetYard.region },
    blastRadius: {
      scope: "region",
      reversible: true,
      compensationPath: `failback:${targetYard.region}`,
      estimatedImpact: "medium",
    },
    environment: input.environment ?? "staging",
    idempotencyKey: `${incidentId}/failover/${targetYard.region}`,
    conformanceState: "green",
  };

  return defineRunbook(DISASTER_RECOVERY_RUNBOOK_NAME, {
    version: "0.1.0",
    on: { alert: "provider-region-loss" },
    diagnose: [
      "read incident impact",
      "classify provider-degraded-region",
      "verify replicated event-log restore point",
    ],
    fix: [{
      when: "provider-degraded-region",
      gate: "canary-with-auto-rollback",
      action,
      description: "Fence stale owner, fail over the Yard route, and restore projections from log.",
    }],
    signature: {
      signedBy: "yard:sre",
      digest: "sha256:4e9a883ea271c885b9c4c6a8fca834a31ef3c23a4ca59d49561a9a5b6208bc1c",
      signature: "sigstore:dr-failover-proof",
    },
  });
}

function appendRootCauseIfNeeded({ incidentEvents, incident, detectedAt, targetYard }) {
  if (incident.status !== "triaged") {
    return incidentEvents;
  }

  return [
    ...incidentEvents,
    makeIncidentEvent(INCIDENT_EVENT_TYPES.rootCauseIdentified, {
      id: `incident-root-cause-${slug(incident.id)}`,
      incidentId: incident.id,
      correlationId: incident.correlationId,
      causationId: incident.timeline.at(-1).id,
      occurredAt: detectedAt,
      payload: {
        rootCause: "provider-degraded-region",
        region: targetYard.region,
        yardId: targetYard.id,
      },
    }),
  ];
}

function createRunbookEvents({
  runbook,
  incident,
  detectedAt,
  targetYard,
  sourceLog,
  restore,
  fencing,
}) {
  const runbookId = `runbook-${slug(runbook.name)}-${slug(incident.id)}`;
  const common = { runbookId, correlationId: incident.correlationId };
  const defined = makeRunbookEvent(RUNBOOK_EVENT_TYPES.defined, {
    ...common,
    id: `${runbookId}-defined`,
    runbook,
  });
  const triggered = makeRunbookEvent(RUNBOOK_EVENT_TYPES.triggered, {
    ...common,
    id: `${runbookId}-triggered`,
    causationId: incident.timeline.at(-1).id,
    payload: { incidentId: incident.id, detectedAt },
  });
  const diagnose = stepEvent({
    common,
    runbookId,
    index: 1,
    causationId: triggered.id,
    kind: "diagnose-region-loss",
    payload: {
      incidentId: incident.id,
      classification: "provider-degraded-region",
      targetYard,
    },
  });
  const classify = stepEvent({
    common,
    runbookId,
    index: 2,
    causationId: diagnose.id,
    kind: "select-gated-failover",
    payload: {
      actionKind: "failover",
      gate: "canary-with-auto-rollback",
    },
  });
  const fence = stepEvent({
    common,
    runbookId,
    index: 3,
    causationId: classify.id,
    kind: "fence-original-owner",
    payload: {
      actorKey: fencing.actorKey,
      previousFenceToken: fencing.previousFenceToken,
      newFenceToken: fencing.newFenceToken,
      stalePrimaryAppend: fencing.stalePrimaryAppend,
      reason: fencing.stalePrimaryAppend.reason === "no-contending-append"
        ? "no contending append observed"
        : fencing.stalePrimaryAppend.accepted
        ? "append carried current fenceToken"
        : "lower fenceToken rejected before failover restore",
    },
  });
  const restoreStep = stepEvent({
    common,
    runbookId,
    index: 4,
    causationId: fence.id,
    kind: "restore-from-log",
    payload: {
      topology: sourceLog.topology,
      snapshotSeq: sourceLog.snapshotSeq,
      lastCommittedSeq: sourceLog.lastCommittedSeq,
      replicatedSeq: sourceLog.replicatedSeq,
      restore,
    },
  });
  const verify = stepEvent({
    common,
    runbookId,
    index: 5,
    causationId: restoreStep.id,
    kind: "verify-rpo-rto",
    payload: {
      rpo: restore.rpo,
      rto: restore.rto,
      withinTarget: restore.rpo.withinTarget && restore.rto.withinTarget,
    },
  });
  const completed = makeRunbookEvent(RUNBOOK_EVENT_TYPES.completed, {
    ...common,
    id: `${runbookId}-completed`,
    causationId: verify.id,
    payload: {
      status: "restored",
      rpo: restore.rpo,
      rto: restore.rto,
    },
  });

  return [defined, triggered, diagnose, classify, fence, restoreStep, verify, completed];
}

function stepEvent({ common, runbookId, index, causationId, kind, payload }) {
  return makeRunbookEvent(RUNBOOK_EVENT_TYPES.stepCompleted, {
    ...common,
    id: `${runbookId}-step-${index}-${kind}`,
    causationId,
    payload: { kind, ...payload },
  });
}

function appendResolutionEvents({ incidentEvents, incident, action, restore, restoredAt }) {
  const latest = incidentEvents.at(-1);
  const resolved = makeIncidentEvent(INCIDENT_EVENT_TYPES.resolved, {
    id: `incident-resolved-${slug(incident.id)}`,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    causationId: latest?.id,
    occurredAt: restoredAt,
    payload: {
      actionId: `proposal-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
      resolution: "restored-from-replicated-log",
      restore,
    },
  });
  const postmortem = makeIncidentEvent(INCIDENT_EVENT_TYPES.postmortemFiled, {
    id: `incident-postmortem-${slug(incident.id)}`,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    causationId: resolved.id,
    occurredAt: restoredAt,
    payload: {
      postmortemRef: `postmortem:${incident.id}`,
      rpo: restore.rpo,
      rto: restore.rto,
    },
  });

  return [...incidentEvents, resolved, postmortem];
}

function evaluateFence({ lease, stalePrimaryAppend }) {
  const newFenceToken = lease.previousFenceToken + 1;
  if (!stalePrimaryAppend) {
    return deepFreeze({
      actorKey: lease.actorKey,
      previousOwnerNode: lease.previousOwnerNode,
      newOwnerNode: lease.newOwnerNode,
      previousFenceToken: lease.previousFenceToken,
      newFenceToken,
      stalePrimaryAppend: {
        accepted: null,
        reason: "no-contending-append",
      },
    });
  }

  const append = stalePrimaryAppend;
  const accepted = append.fenceToken >= newFenceToken;

  return deepFreeze({
    actorKey: lease.actorKey,
    previousOwnerNode: lease.previousOwnerNode,
    newOwnerNode: lease.newOwnerNode,
    previousFenceToken: lease.previousFenceToken,
    newFenceToken,
    stalePrimaryAppend: {
      ...append,
      accepted,
      reason: accepted ? "current-fence-accepted" : "stale-fence-rejected",
    },
  });
}

function calculateRestore({ sourceLog, detectedAt, restoredAt, rpoTargetMs, rtoTargetMs }) {
  const lagged = sourceLog.replicatedSeq < sourceLog.lastCommittedSeq || sourceLog.replicationLagMs > 0;
  const rpoMs = lagged ? sourceLog.replicationLagMs : 0;
  const rtoMs = Date.parse(restoredAt) - Date.parse(detectedAt);

  if (rtoMs < 0) {
    throw new Error("restoredAt must not be before detectedAt");
  }

  return deepFreeze({
    source: {
      topology: sourceLog.topology,
      snapshotSeq: sourceLog.snapshotSeq,
      lastCommittedSeq: sourceLog.lastCommittedSeq,
      replicatedSeq: sourceLog.replicatedSeq,
    },
    projectionsRehydrated: countStreams(sourceLog, "projection:"),
    actorsRehydrated: countStreams(sourceLog, "actor:"),
    rpo: {
      label: lagged ? "bounded-staleness" : "synchronous-quorum",
      ms: rpoMs,
      targetMs: rpoTargetMs,
      withinTarget: rpoMs <= rpoTargetMs,
      claimsZeroDataLoss: !lagged,
      unreplicatedSeqRange: lagged
        ? [sourceLog.replicatedSeq + 1, sourceLog.lastCommittedSeq]
        : [],
    },
    rto: {
      ms: rtoMs,
      targetMs: rtoTargetMs,
      withinTarget: rtoMs <= rtoTargetMs,
    },
  });
}

function restoreFromRunbookEvents(events) {
  const restoreStep = events.find(
    (event) => event.type === RUNBOOK_EVENT_TYPES.stepCompleted && event.payload.kind === "restore-from-log",
  );
  const verifyStep = events.find(
    (event) => event.type === RUNBOOK_EVENT_TYPES.stepCompleted && event.payload.kind === "verify-rpo-rto",
  );

  if (!restoreStep || !verifyStep) {
    throw new Error("DR replay requires restore-from-log and verify-rpo-rto runbook steps");
  }

  return deepFreeze({
    ...restoreStep.payload.restore,
    rpo: verifyStep.payload.rpo,
    rto: verifyStep.payload.rto,
  });
}

function normalizeEvents(input = {}) {
  return {
    runbook: requiredArray(input.runbook, "events.runbook"),
    incident: requiredArray(input.incident, "events.incident"),
  };
}

function validateSourceLog(sourceLog) {
  if (!isPlainObject(sourceLog)) {
    throw new Error("sourceLog is required");
  }

  return {
    topology: requiredString(sourceLog.topology, "sourceLog.topology"),
    lastCommittedSeq: nonNegativeInteger(sourceLog.lastCommittedSeq, "sourceLog.lastCommittedSeq"),
    replicatedSeq: nonNegativeInteger(sourceLog.replicatedSeq, "sourceLog.replicatedSeq"),
    replicationLagMs: nonNegativeInteger(sourceLog.replicationLagMs, "sourceLog.replicationLagMs"),
    snapshotSeq: nonNegativeInteger(sourceLog.snapshotSeq, "sourceLog.snapshotSeq"),
    streams: validateStreams(sourceLog.streams),
  };
}

function validateStreams(streams) {
  if (!isPlainObject(streams)) {
    throw new Error("sourceLog.streams is required");
  }

  return streams;
}

function validateLease(lease) {
  if (!isPlainObject(lease)) {
    throw new Error("lease is required");
  }

  return {
    actorKey: requiredString(lease.actorKey, "lease.actorKey"),
    previousOwnerNode: requiredString(lease.previousOwnerNode, "lease.previousOwnerNode"),
    previousFenceToken: nonNegativeInteger(lease.previousFenceToken, "lease.previousFenceToken"),
    newOwnerNode: requiredString(lease.newOwnerNode, "lease.newOwnerNode"),
    expiredAt: validateIso(lease.expiredAt, "lease.expiredAt"),
  };
}

function validateTargetYard(targetYard) {
  if (!isPlainObject(targetYard)) {
    throw new Error("targetYard is required");
  }

  return {
    id: requiredString(targetYard.id, "targetYard.id"),
    region: requiredString(targetYard.region, "targetYard.region"),
    camp: requiredString(targetYard.camp, "targetYard.camp"),
  };
}

function countStreams(sourceLog, prefix) {
  return Object.keys(sourceLog.streams).filter((streamId) => streamId.startsWith(prefix)).length;
}

function addMilliseconds(iso, milliseconds) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function requiredArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

function requiredString(value, fieldName) {
  if (Object.prototype.toString.call(value) !== "[object String]" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function nonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
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

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!isObjectLike(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isObjectLike(value) {
  return value !== null && (Array.isArray(value) || isPlainObject(value));
}
