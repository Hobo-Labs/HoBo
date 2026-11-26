import {
  RUNBOOK_EVENT_TYPES,
  foldRunbookEvents,
  makeRunbookEvent,
  selectFixForClass,
  validateRunbook,
} from "../../runbook-contract/src/runbook-contract.js";
import { classifyFailureSignal } from "../../failure-taxonomy-safe-fix-classifier/src/failure-taxonomy-classifier.js";
import {
  applyGatedRemediation,
  replayGatedRemediation,
} from "../../gated-autonomous-remediation-contract/src/gated-autonomous-remediation.js";
import { diagnoseIncident } from "../../sre-diagnose-projection-contract/src/sre-diagnose-projection.js";

export const RUNBOOK_EXECUTION_ENGINE_PORT = "hobo:runbook-engine/pipelines@0.1.0";

const impactRank = Object.freeze({ low: 1, medium: 2, high: 3 });
const blastRadiusResources = Object.freeze({ resource: 1, region: 5, camp: 10 });
const taxonomyAliases = Object.freeze({
  "provider-degraded-region": ["provider-degraded"],
  "split-brain-state-divergence": ["split-brain"],
  "requires-human": ["unknown"],
  unclassifiable: ["unknown"],
});

export async function executeRunbook(input = {}) {
  const runbook = validateRunbook(input.runbook);
  const incidentEvents = requiredArray(input.incidentEvents, "incidentEvents");
  const executedAt = validateIso(input.executedAt ?? new Date(0).toISOString(), "executedAt");
  const diagnosedAt = validateIso(input.diagnosedAt ?? executedAt, "diagnosedAt");
  const decidedAt = validateIso(input.decidedAt ?? executedAt, "decidedAt");
  const runbookId = input.runbookId ?? `runbook-${slug(runbook.name)}`;

  const diagnosis = diagnoseIncident({
    incidentEvents,
    projections: input.projections,
    runbook,
    engine: input.engine,
    diagnosedAt,
    operator: input.operator,
  });
  const incident = diagnosis.incident;
  const runbookEvents = createRunbookExecutionStream({
    runbook,
    runbookId,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    executedAt,
  });

  appendDiagnosisSteps({ runbookEvents, runbook, diagnosis, runbookId, incident, executedAt });

  if (!diagnosis.rootCauseEvent) {
    appendRunbookEvent(runbookEvents, RUNBOOK_EVENT_TYPES.failed, {
      runbookId,
      correlationId: incident.correlationId,
      payload: {
        incidentId: incident.id,
        reason: diagnosis.diagnosis.status ?? "diagnosis-failed",
        handoffEvents: diagnosis.handoffEvents.map((event) => event.id),
      },
    });

    return freezeExecutionResult({
      status: "failed",
      runbook,
      diagnosis,
      selectedFix: null,
      classification: null,
      remediation: null,
      events: {
        runbook: runbookEvents,
        incident: incidentEvents,
        crew: diagnosis.handoffEvents,
        policy: [],
        rollout: [],
      },
    });
  }

  const classification = classifyFailureSignal(input.signal);
  const selectedFix = selectRunbookFixForClassification(runbook, classification);
  appendRunbookEvent(runbookEvents, RUNBOOK_EVENT_TYPES.stepCompleted, {
    runbookId,
    correlationId: incident.correlationId,
    payload: {
      incidentId: incident.id,
      kind: "classify",
      failureClass: classification.failureClass,
      matchedClasses: classification.matchedClasses,
      selectedFix: selectedFix.when,
    },
  });

  const budgetDecision = evaluateBlastRadiusBudget(selectedFix.action, input.blastRadiusBudget);
  if (!budgetDecision.allowed) {
    appendRunbookEvent(runbookEvents, RUNBOOK_EVENT_TYPES.failed, {
      runbookId,
      correlationId: incident.correlationId,
      payload: {
        incidentId: incident.id,
        reason: "blast-radius-budget-exceeded",
        budgetDecision,
        selectedFix: selectedFix.when,
      },
    });

    return freezeExecutionResult({
      status: "aborted",
      runbook,
      diagnosis,
      selectedFix,
      classification,
      remediation: null,
      events: {
        runbook: runbookEvents,
        incident: [...incidentEvents, diagnosis.rootCauseEvent],
        crew: [],
        policy: [],
        rollout: [],
      },
    });
  }

  const remediation = await applyGatedRemediation({
    incidentEvents: [...incidentEvents, diagnosis.rootCauseEvent],
    action: selectedFix.action,
    decidedAt,
    gateway: input.gateway,
    gateSignal: input.gateSignal,
    priorEvents: input.priorEvents,
    rolloutTarget: input.rolloutTarget,
    canaryPercentages: input.canaryPercentages,
    healthGate: input.healthGate,
    autoRollbackSignals: input.autoRollbackSignals,
    tenant: input.tenant,
    operator: input.operator?.principal ?? input.operator,
    approval: input.approval,
  });

  appendRunbookEvent(runbookEvents, RUNBOOK_EVENT_TYPES.stepCompleted, {
    runbookId,
    correlationId: incident.correlationId,
    payload: {
      incidentId: incident.id,
      kind: "dispatch",
      selectedFix: selectedFix.when,
      actionKind: selectedFix.action.kind,
      remediationStatus: remediation.status,
    },
  });
  appendRunbookEvent(runbookEvents, RUNBOOK_EVENT_TYPES.completed, {
    runbookId,
    correlationId: incident.correlationId,
    payload: {
      incidentId: incident.id,
      selectedFix: selectedFix.when,
      failureClass: classification.failureClass,
      remediationStatus: remediation.status,
    },
  });

  return freezeExecutionResult({
    status: selectedFix.action.kind === "escalate" ? "escalated" : "completed",
    runbook,
    diagnosis,
    selectedFix,
    classification,
    remediation,
    events: {
      runbook: runbookEvents,
      incident: remediation.events.incident,
      crew: remediation.events.crew,
      policy: remediation.events.policy,
      rollout: remediation.events.rollout,
    },
  });
}

export async function runHoboRunbookExec(input = {}) {
  const incidentId = requiredString(input.incidentId, "incidentId");
  const runbook = selectRunbookForExec(input.runbooks, input.runbookName);
  const incidentEvents = await loadIncidentEvents(input.eventStore, incidentId);
  const result = await executeRunbook({
    ...input,
    runbook,
    incidentEvents,
  });

  return deepFreeze({
    command: `hobo runbook exec --incident ${incidentId}`,
    incidentId,
    runbookName: runbook.name,
    result,
    replay: replayRunbookExecution(result.events.runbook),
  });
}

export function replayRunbookExecution(events) {
  return deepFreeze({
    runbook: foldRunbookEvents(events),
    selectedFix: lastPayload(events, RUNBOOK_EVENT_TYPES.completed)?.selectedFix ?? null,
    failureReason: lastPayload(events, RUNBOOK_EVENT_TYPES.failed)?.reason ?? null,
  });
}

export function replayRunbookRemediation(events) {
  return replayGatedRemediation(events);
}

export function selectRunbookFixForClassification(runbook, classification) {
  const validated = validateRunbook(runbook);
  const groups = prioritizedClassGroups(classification);

  for (const group of groups) {
    const match = validated.fix.find((fix) => fix.when !== "unknown" && group.has(fix.when));
    if (match) return match;
  }

  return selectFixForClass(validated, "unknown");
}

export function createStackStormEnginePortStub() {
  return deepFreeze({
    kind: "runbook-engine-port",
    provider: "stackstorm",
    mode: "stub",
    nativeEngine: RUNBOOK_EXECUTION_ENGINE_PORT,
    mapping: {
      trigger: "StackStorm sensor/rule -> runbook.on",
      diagnose: "Orquesta read-only task -> runbook.diagnose projection read",
      fix: "StackStorm action/workflow -> RemediationAction through the HoBo gate",
      approval: "StackStorm inquiry -> policy obligation",
    },
    execute() {
      throw new Error("StackStorm engine port stub is mapping-only in this contract");
    },
  });
}

function createRunbookExecutionStream({ runbook, runbookId, incidentId, correlationId, executedAt }) {
  return [
    makeRunbookEvent(RUNBOOK_EVENT_TYPES.defined, {
      id: `runbook-defined-${slug(runbookId)}`,
      runbook,
      runbookId,
      correlationId,
      payload: { engine: RUNBOOK_EXECUTION_ENGINE_PORT },
    }),
    makeRunbookEvent(RUNBOOK_EVENT_TYPES.triggered, {
      id: `runbook-triggered-${slug(runbookId)}-${slug(incidentId)}`,
      runbookId,
      correlationId,
      causationId: `runbook-defined-${slug(runbookId)}`,
      payload: { incidentId, triggeredAt: executedAt, engine: RUNBOOK_EXECUTION_ENGINE_PORT },
    }),
  ];
}

function appendDiagnosisSteps({ runbookEvents, runbook, diagnosis, runbookId, incident, executedAt }) {
  const reads = diagnosis.diagnosis.evidence ?? diagnosis.diagnosis.missingOrStale ?? [];
  for (const [index, step] of runbook.diagnose.entries()) {
    const read = reads.find((candidate) => candidate.query === step) ?? { query: step };
    appendRunbookEvent(runbookEvents, RUNBOOK_EVENT_TYPES.stepCompleted, {
      runbookId,
      correlationId: incident.correlationId,
      payload: {
        incidentId: incident.id,
        kind: "diagnose",
        step,
        atSeq: read.atSeq,
        completedAt: executedAt,
        order: index,
      },
    });
  }
}

function appendRunbookEvent(events, type, { runbookId, correlationId, payload }) {
  const previous = events.at(-1);
  events.push(
    makeRunbookEvent(type, {
      id: `${slug(type)}-${slug(runbookId)}-${events.length}`,
      runbookId,
      correlationId,
      causationId: previous?.id,
      payload,
    }),
  );
}

function prioritizedClassGroups(classification) {
  if (!isObjectRecord(classification)) {
    throw new TypeError("classification must be an object");
  }
  const groups = [];
  const used = new Set();
  for (const failureClass of [
    requiredString(classification.failureClass, "classification.failureClass"),
    ...requiredArray(classification.matchedClasses, "classification.matchedClasses"),
  ]) {
    const group = expandedClassSet(failureClass);
    const key = [...group].sort().join("|");
    if (!used.has(key)) {
      used.add(key);
      groups.push(group);
    }
  }
  return groups;
}

function expandedClassSet(failureClass) {
  const value = requiredString(failureClass, "failureClass");
  return new Set([value, ...(taxonomyAliases[value] ?? [])]);
}

function evaluateBlastRadiusBudget(action, budget) {
  if (!budget) {
    return deepFreeze({ allowed: true, reasons: [] });
  }
  if (!isObjectRecord(budget)) {
    throw new TypeError("blastRadiusBudget must be an object");
  }
  const reasons = [];
  const blastRadius = action.blastRadius;

  if (budget.maxImpact) {
    const maxImpact = requireKnown(budget.maxImpact, "blastRadiusBudget.maxImpact", impactRank);
    if (impactRank[blastRadius.estimatedImpact] > impactRank[maxImpact]) {
      reasons.push(`impact ${blastRadius.estimatedImpact} exceeds ${maxImpact}`);
    }
  }

  if (Number.isInteger(budget.maxResources)) {
    const requiredResources = blastRadiusResources[blastRadius.scope] ?? Number.POSITIVE_INFINITY;
    if (requiredResources > budget.maxResources) {
      reasons.push(`scope ${blastRadius.scope} requires ${requiredResources} resources`);
    }
  }

  if (Array.isArray(budget.allowedScopes) && !budget.allowedScopes.includes(blastRadius.scope)) {
    reasons.push(`scope ${blastRadius.scope} is not allowed`);
  }

  return deepFreeze({ allowed: reasons.length === 0, reasons });
}

function freezeExecutionResult(result) {
  return deepFreeze({
    ...result,
    replay: replayRunbookExecution(result.events.runbook),
  });
}

async function loadIncidentEvents(eventStore, incidentId) {
  if (!eventStore) {
    throw new Error("eventStore is required");
  }
  if (isCallable(eventStore.loadIncident)) {
    return requiredArray(await eventStore.loadIncident(incidentId), "eventStore.loadIncident result");
  }
  if (isCallable(eventStore.get)) {
    return requiredArray(eventStore.get(incidentId), "eventStore.get result");
  }
  if (eventStore[incidentId]) {
    return requiredArray(eventStore[incidentId], `eventStore.${incidentId}`);
  }
  throw new Error(`incident ${incidentId} not found`);
}

function selectRunbookForExec(runbooks, runbookName) {
  const candidates = requiredArray(runbooks, "runbooks").map((runbook) => validateRunbook(runbook));
  if (runbookName) {
    const match = candidates.find((runbook) => runbook.name === runbookName);
    if (!match) throw new Error(`runbook ${runbookName} not found`);
    return match;
  }
  if (candidates.length !== 1) {
    throw new Error("runbookName is required when multiple runbooks are available");
  }
  return candidates[0];
}

function lastPayload(events, type) {
  return [...requiredArray(events, "events")].reverse().find((event) => event.type === type)?.payload;
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function requireKnown(value, fieldName, table) {
  const text = requiredString(value, fieldName);
  if (!(text in table)) {
    throw new Error(`${fieldName} must be one of: ${Object.keys(table).join(", ")}`);
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
  if (!isString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isCallable(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
