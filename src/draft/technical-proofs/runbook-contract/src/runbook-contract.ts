import {
  classifyRemediationEffect,
  validateRemediationAction,
} from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const RUNBOOK_EVENT_TYPES = Object.freeze({
  defined: "runbook.Defined",
  triggered: "runbook.Triggered",
  stepCompleted: "runbook.StepCompleted",
  completed: "runbook.Completed",
  failed: "runbook.Failed",
});

const runbookEventTypeSet = new Set(Object.values(RUNBOOK_EVENT_TYPES));

const gateLevels = Object.freeze({
  auto: 0,
  "canary-with-auto-rollback": 1,
  "require-approval": 2,
});

const gateAliases = Object.freeze({
  approval: "require-approval",
  canary: "canary-with-auto-rollback",
});

const effectToGate = Object.freeze({
  auto: "auto",
  "canary-with-auto-rollback": "canary-with-auto-rollback",
  "require-approval": "require-approval",
});

const triggerKeys = new Set(["alert", "sloBurn", "drift", "incidentSeverity", "severity"]);

export function defineRunbook(name, spec) {
  return validateRunbook({ ...spec, name });
}

export function validateRunbook(candidate) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError("runbook must be an object");
  }

  const name = requireNonEmptyString(candidate.name, "name");
  const runbook = {
    name,
    version: validateVersion(candidate.version),
    on: validateTrigger(candidate.on),
    diagnose: validateDiagnosis(candidate.diagnose),
    fix: validateFixes(candidate.fix, name),
    signature: validateSignature(candidate.signature),
  };

  return deepFreeze(runbook);
}

export function selectFixForClass(runbook, taxonomyClass) {
  const validated = validateRunbook(runbook);
  const match = validated.fix.find((fix) => fix.when === taxonomyClass);
  if (match) return match;

  const unknown = validated.fix.find((fix) => fix.when === "unknown");
  if (unknown) return unknown;

  return deepFreeze({
    when: "unknown",
    gate: "require-approval",
    action: validateRemediationAction({
      kind: "escalate",
      target: { kind: "resource", id: `runbook:${validated.name}` },
      blastRadius: {
        scope: "resource",
        reversible: false,
        estimatedImpact: "high",
      },
      environment: "prod",
      idempotencyKey: `runbook/${validated.name}/escalate`,
      conformanceState: "unknown",
    }),
  });
}

export function makeRunbookEvent(
  type,
  { id, runbook, runbookId, correlationId, causationId, payload = {} },
) {
  validateRunbookEventType(type);
  const normalizedRunbookId = requireNonEmptyString(
    runbookId ?? (runbook ? `runbook-${slug(runbook.name)}` : undefined),
    "runbookId",
  );

  const eventPayload =
    type === RUNBOOK_EVENT_TYPES.defined
      ? { ...payload, runbook: validateRunbook(runbook) }
      : { ...payload };

  return deepFreeze({
    id: requireNonEmptyString(id, "event id"),
    type,
    streamId: `runbook:${normalizedRunbookId}`,
    runbookId: normalizedRunbookId,
    correlationId: requireNonEmptyString(correlationId, "correlationId"),
    ...(causationId ? { causationId: requireNonEmptyString(causationId, "causationId") } : undefined),
    payload: eventPayload,
  });
}

export function foldRunbookEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("runbook event stream is empty");
  }

  let state = null;
  for (const event of events) {
    validateRunbookEvent(event);

    if (!state) {
      if (event.type !== RUNBOOK_EVENT_TYPES.defined) {
        throw new Error(`runbook stream must start with ${RUNBOOK_EVENT_TYPES.defined}`);
      }
      state = {
        runbookId: event.runbookId,
        streamId: event.streamId,
        correlationId: event.correlationId,
        status: "defined",
        eventTypes: [],
      };
    }

    if (event.runbookId !== state.runbookId) {
      throw new Error(`event ${event.id} belongs to ${event.runbookId}, not ${state.runbookId}`);
    }
    if (event.correlationId !== state.correlationId) {
      throw new Error(`event ${event.id} crosses correlation boundary`);
    }
    if (isTerminal(state.status)) {
      throw new Error(`terminal runbook outcome already recorded for ${state.runbookId}`);
    }

    state.eventTypes.push(event.type);
    state.status = statusForEvent(event.type);
  }

  return deepFreeze(state);
}

function validateFixes(fixes, runbookName) {
  if (!Array.isArray(fixes)) {
    throw new TypeError("fix must be an array");
  }

  return fixes.map((fix, index) => validateFix(fix, index, runbookName));
}

function validateFix(fix, index, runbookName) {
  if (!fix || !isJsonObject(fix) || Array.isArray(fix)) {
    throw new TypeError(`fix[${index}] must be an object`);
  }

  const when = requireNonEmptyString(fix.when, `fix[${index}].when`);
  const gate = normalizeGate(fix.gate, `fix[${index}].gate`);
  const action = validateRemediationAction(fix.action);
  const effect = effectToGate[classifyRemediationEffect(action).effectClass];

  if (gateLevels[gate] < gateLevels[effect]) {
    throw new TypeError(`gate ${gate} is less restrictive than action effect ${effect}`);
  }

  return deepFreeze({
    when,
    gate,
    action,
    ...(fix.description ? { description: requireNonEmptyString(fix.description, "description") } : undefined),
    ...(runbookName ? { runbook: runbookName } : undefined),
  });
}

function validateTrigger(trigger) {
  if (!trigger || !isJsonObject(trigger) || Array.isArray(trigger)) {
    throw new TypeError("on is required");
  }

  const entries = Object.entries(trigger).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    throw new TypeError("on must declare at least one trigger");
  }
  for (const [key, value] of entries) {
    if (!triggerKeys.has(key)) {
      throw new TypeError(`unsupported trigger key: ${key}`);
    }
    requireNonEmptyString(value, `on.${key}`);
  }

  return deepFreeze(Object.fromEntries(entries));
}

function validateDiagnosis(steps) {
  if (!Array.isArray(steps)) {
    throw new TypeError("diagnose must be an array");
  }
  if (steps.length === 0) {
    throw new TypeError("diagnose must contain at least one read step");
  }

  return Object.freeze(steps.map((step, index) => requireNonEmptyString(step, `diagnose[${index}]`)));
}

function validateSignature(signature) {
  if (!signature || !isJsonObject(signature) || Array.isArray(signature)) {
    throw new TypeError("signature is required");
  }

  const normalized = {
    signedBy: requireNonEmptyString(signature.signedBy, "signature.signedBy"),
    digest: requireNonEmptyString(signature.digest, "signature.digest"),
    signature: requireNonEmptyString(signature.signature, "signature.signature"),
  };

  if (!normalized.digest.startsWith("sha256:")) {
    throw new TypeError("signature.digest must be sha256-prefixed");
  }

  return deepFreeze(normalized);
}

function validateVersion(version) {
  const normalized = requireNonEmptyString(version, "version");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new TypeError("version must be semver");
  }
  return normalized;
}

function normalizeGate(gate, name) {
  const value = requireNonEmptyString(gate, name);
  const normalized = gateAliases[value] ?? value;
  if (!(normalized in gateLevels)) {
    throw new TypeError(`${name} must be one of: ${Object.keys(gateLevels).join(", ")}`);
  }
  return normalized;
}

function validateRunbookEvent(event) {
  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    throw new Error("runbook event must be an object");
  }
  validateRunbookEventType(event.type);
  requireNonEmptyString(event.id, "event id");
  requireNonEmptyString(event.runbookId, "runbookId");
  requireNonEmptyString(event.streamId, "streamId");
  requireNonEmptyString(event.correlationId, "correlationId");
}

function validateRunbookEventType(type) {
  if (!runbookEventTypeSet.has(type)) {
    throw new Error(`unknown runbook event type: ${String(type)}`);
  }
}

function statusForEvent(type) {
  switch (type) {
    case RUNBOOK_EVENT_TYPES.defined:
      return "defined";
    case RUNBOOK_EVENT_TYPES.triggered:
      return "triggered";
    case RUNBOOK_EVENT_TYPES.stepCompleted:
      return "running";
    case RUNBOOK_EVENT_TYPES.completed:
      return "completed";
    case RUNBOOK_EVENT_TYPES.failed:
      return "failed";
    default:
      throw new Error(`unknown runbook event type: ${String(type)}`);
  }
}

function isTerminal(status) {
  return status === "completed" || status === "failed";
}

function requireNonEmptyString(value, name) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
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
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
