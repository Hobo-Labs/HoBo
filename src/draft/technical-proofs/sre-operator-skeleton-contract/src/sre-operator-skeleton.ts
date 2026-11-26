import {
  agentDispatched,
  createOperatorPrincipal,
  handoffRequested,
} from "../../crew-event-contract/src/crew-event-contract.js";
import {
  deriveIncidentOpenEvents,
  foldIncidentStream,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { isJsonString, isJsonObject } from "./json.js";


export const SRE_ENGINE_PORTS = Object.freeze({
  builtIn: "hobo:sre-engine/built-in@0.1.0",
  holmesGpt: "hobo:sre-engine/holmesgpt@0.1.0",
});

export const SRE_SIGNAL_SUBSCRIPTIONS = Object.freeze([
  "alert.*",
  "slo.BudgetBurned",
  "resource.DriftDetected",
  "compat.GateFailed",
]);

const INCIDENT_OPEN_SIGNAL_TYPES = new Set([
  "alert.Fired",
  "slo.BudgetBurned",
  "resource.DriftDetected",
  "compat.GateFailed",
]);

export function createSreOperator(input = {}) {
  const principal = createOperatorPrincipal({
    name: input.name ?? "SRE",
    svid: input.svid ?? "spiffe://yard/system/service/sre-operator",
    perAgentPolicy: {
      scopedCapabilities: input.scopedCapabilities ?? [
        "signal:read",
        "crew:dispatch",
        "incident:open",
        "incident:read",
      ],
      spendCapUsd: input.spendCapUsd ?? 0,
      requireApprovalGates: input.requireApprovalGates ?? ["prod", "destroy", "remediation"],
    },
    enginePort: input.enginePort ?? SRE_ENGINE_PORTS.builtIn,
    disabled: input.disabled,
  });

  return deepFreeze({
    principal,
    subscriptions: [...SRE_SIGNAL_SUBSCRIPTIONS],
    reasoningEngine: {
      port: principal.enginePort,
      adapter:
        principal.enginePort === SRE_ENGINE_PORTS.holmesGpt
          ? "holmesgpt-adapter-stub"
          : "built-in-default",
    },
  });
}

export function processSreSignals(input = {}) {
  const signals = validateSignals(input.signals);
  const operator = input.operator ?? createSreOperator();
  const dispatchAt = validateIso(
    input.dispatchAt ?? earliestOccurredAt(signals) ?? new Date(0).toISOString(),
    "dispatchAt",
  );

  const incidentSignals = [];
  const unknownSignals = [];
  const unknownSignalInputs = [];

  for (const signal of signals) {
    if (INCIDENT_OPEN_SIGNAL_TYPES.has(signal.type)) {
      incidentSignals.push(signal);
      continue;
    }

    unknownSignals.push(logUnknownSignal(signal));
    unknownSignalInputs.push(signal);
  }

  const { opened, duplicates } = deriveIncidentOpenEvents(
    incidentSignals,
    input.existingIncidents ?? [],
  );
  const signalsById = new Map(incidentSignals.map((signal) => [signal.id, signal]));
  const dispatchEvents = opened.map((event, index) => {
    const trigger = sourceSignalForIncident(event, signalsById);
    return agentDispatched({
      id: `dispatch-sre-${slug(event.payload.incidentId)}`,
      streamId: "crew:sre",
      seq: index + 1,
      ts: dispatchAt,
      principal: operator.principal,
      correlationId: event.correlationId,
      causationId: trigger.id,
      trigger: { id: trigger.id, type: trigger.type },
    });
  });
  const escalations = unknownSignalInputs.map((signal, index) =>
    handoffRequested({
      id: `handoff-unknown-${slug(signal.id)}`,
      streamId: "crew:sre",
      seq: dispatchEvents.length + index + 1,
      ts: dispatchAt,
      principal: operator.principal,
      correlationId: signal.correlationId,
      causationId: signal.id,
      target: { kind: "human", name: "on-call" },
      reason: `unknown signal type ${signal.type}`,
    }),
  );

  const incidents = opened.map((event) => foldIncidentStream([event]));
  const metrics = opened.map((event) => mttdMetric(event, dispatchAt, signalsById));

  return deepFreeze({
    operator,
    dispatchEvents,
    incidentOpenedEvents: opened,
    incidents,
    metrics,
    duplicates,
    unknownSignals,
    escalations,
  });
}

function validateSignals(signals) {
  if (!Array.isArray(signals)) {
    throw new Error("signals must be an array");
  }

  return signals.map((signal) => {
    if (!signal || !isJsonObject(signal) || Array.isArray(signal)) {
      throw new Error("signal must be an object");
    }
    requiredString(signal.id, "signal.id");
    requiredString(signal.type, "signal.type");
    requiredString(signal.correlationId, "signal.correlationId");
    if (signal.occurredAt !== undefined) validateIso(signal.occurredAt, "signal.occurredAt");
    return signal;
  });
}

function sourceSignalForIncident(event, signalsById) {
  const signals = event.payload.causedBy
    .map((cause) => signalsById.get(cause.id))
    .filter(Boolean)
    .sort((left, right) =>
      (left.occurredAt ?? event.occurredAt).localeCompare(right.occurredAt ?? event.occurredAt),
    );
  const signal = signals[0];
  if (!signal) {
    throw new Error(`incident ${event.payload.incidentId} has no source signal`);
  }
  return signal;
}

function mttdMetric(event, dispatchAt, signalsById) {
  const signal = sourceSignalForIncident(event, signalsById);

  return {
    name: "sre.mttd",
    signalId: signal.id,
    incidentId: event.payload.incidentId,
    seconds: secondsBetween(signal.occurredAt ?? event.occurredAt, dispatchAt),
  };
}

function logUnknownSignal(signal) {
  return {
    level: "warn",
    type: "sre.UnknownSignalLogged",
    signalId: signal.id,
    signalType: signal.type,
    correlationId: signal.correlationId,
  };
}

function secondsBetween(startIso, endIso) {
  const start = Date.parse(validateIso(startIso, "startIso"));
  const end = Date.parse(validateIso(endIso, "endIso"));
  return Math.max(0, Math.floor((end - start) / 1000));
}

function earliestOccurredAt(signals) {
  return signals
    .map((signal) => signal.occurredAt)
    .filter(Boolean)
    .sort()[0];
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
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
