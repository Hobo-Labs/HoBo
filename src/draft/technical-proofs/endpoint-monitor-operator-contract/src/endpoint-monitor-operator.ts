import { isJsonString, isJsonObject } from "./json.js";
import { createOperatorPrincipal } from "../../crew-event-contract/src/crew-event-contract.js";
import {
  createIdentityEvent,
  foldCredentialAudit,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  makeSloEvent,
  validateSloEvent,
} from "../../slo-as-code-contract/src/slo-contract.js";

export const ENDPOINT_MONITOR_ENGINE_PORTS = Object.freeze({
  builtIn: "hobo:endpoint-monitor-engine/built-in@0.1.0",
  syntheticProvider: "hobo:endpoint-monitor-engine/synthetic-provider@0.1.0",
});

export const ENDPOINT_MONITOR_SUBSCRIPTIONS = Object.freeze([
  "synthetic.probe",
  "slo.*",
  "resource.DriftDetected",
]);

export function createEndpointMonitorOperator(input = {}) {
  const principal = createOperatorPrincipal({
    name: input.name ?? "Endpoint Monitor",
    svid: input.svid ?? "spiffe://yard/system/service/endpoint-monitor",
    perAgentPolicy: {
      scopedCapabilities: input.scopedCapabilities ?? [
        "synthetic:probe:*",
        "slo:read:*",
        "resource:read:*",
        "crew:signal",
      ],
      spendCapUsd: input.spendCapUsd ?? 0,
      requireApprovalGates: input.requireApprovalGates ?? ["prod", "remediation"],
    },
    enginePort: input.enginePort ?? ENDPOINT_MONITOR_ENGINE_PORTS.builtIn,
    disabled: input.disabled,
  });

  return deepFreeze({
    principal,
    subscriptions: [...ENDPOINT_MONITOR_SUBSCRIPTIONS],
    probeRunner: {
      port: principal.enginePort,
      adapter:
        principal.enginePort === ENDPOINT_MONITOR_ENGINE_PORTS.syntheticProvider
          ? "external-synthetic-provider-stub"
          : "built-in-synthetic-runner",
    },
  });
}

export function runEndpointMonitorCycle(input = {}) {
  const operator = input.operator ?? createEndpointMonitorOperator();
  const observedAt = validateIso(input.observedAt ?? new Date(0).toISOString(), "observedAt");
  const burnThreshold = validateBurnThreshold(input.burnThreshold ?? {});
  const probes = validateProbes(input.probes ?? []);
  const driftSignals = validateDriftSignals(input.driftSignals ?? []);
  const identityEvents = [];
  const denialEvents = [];
  const deniedProbes = [];
  const allowedProbes = [];
  const sreSignals = [];

  for (const probe of probes) {
    const missingCapability = firstMissingProbeCapability(operator, probe);
    if (missingCapability) {
      deniedProbes.push(
        deepFreeze({
          probeId: probe.id,
          resourceId: probe.resourceId,
          reason: `missing capability ${missingCapability}`,
        }),
      );
      denialEvents.push(tokenDeniedEvent(probe, missingCapability, observedAt, denialEvents.length + 1));
      continue;
    }

    allowedProbes.push(probe);
    identityEvents.push(
      tokenGrantedEvent(probe, observedAt, identityEvents.length + 1),
      tokenUsedEvent(probe, observedAt, identityEvents.length + 2),
    );
  }

  const groups = groupByBurnKey(allowedProbes);
  const sloEvents = [];
  const alertEvents = [];

  for (const group of groups.values()) {
    const failed = group.probes.filter((probe) => !probe.success);
    if (failed.length < burnThreshold.failedProbes) {
      continue;
    }

    const first = group.probes[0];
    const good = group.probes.length - failed.length;
    const sloEvent = {
      ...makeSloEvent({
        id: `slo-burn-${slug(group.key)}`,
        type: "slo.BudgetBurned",
        sloName: first.sloName,
        seq: sloEvents.length + 1,
        time: observedAt,
        data: {
          window: burnThreshold.window,
          good,
          total: group.probes.length,
          burnRate: burnThreshold.burnRate,
          remainingBudgetRatio: remainingBudgetRatio(good, group.probes.length),
        },
      }),
      correlationId: first.correlationId,
    };
    assertValidSloEvent(sloEvent);
    sloEvents.push(deepFreeze(sloEvent));
    sreSignals.push(
      deepFreeze({
        id: sloEvent.id,
        type: sloEvent.type,
        correlationId: first.correlationId,
        occurredAt: observedAt,
        payload: {
          sloName: first.sloName,
          resourceId: first.resourceId,
          failedProbes: failed.length,
          totalProbes: group.probes.length,
        },
      }),
    );

    alertEvents.push(
      deepFreeze({
        id: `alert-fired-${slug(group.key)}`,
        type: "alert.Fired",
        source: "endpoint-monitor",
        subject: `resource/${first.resourceId}`,
        correlationId: first.correlationId,
        occurredAt: observedAt,
        data: {
          groupKey: group.key,
          groupedProbeCount: group.probes.length,
          failedProbeCount: failed.length,
          sloName: first.sloName,
          routingHint: "sre",
        },
      }),
    );
  }

  for (const signal of driftSignals) {
    const capability = `resource:read:${signal.resourceId}`;
    if (!hasCapability(operator, capability)) {
      denialEvents.push(tokenDeniedForDrift(signal, capability, observedAt, denialEvents.length + 1));
      continue;
    }

    sreSignals.push(
      deepFreeze({
        id: signal.id,
        type: "resource.DriftDetected",
        correlationId: signal.correlationId,
        occurredAt: signal.occurredAt,
        payload: signal.payload,
      }),
    );
  }

  const credentialAudit = foldCredentialAudit(identityEvents);
  for (const event of denialEvents) {
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }
  }

  return deepFreeze({
    operator,
    sloEvents,
    alertEvents,
    sreSignals,
    credentialAudit,
    deniedProbes,
    denialEvents,
  });
}

function firstMissingProbeCapability(operator, probe) {
  for (const capability of [`synthetic:probe:${probe.resourceId}`, `slo:read:${probe.sloName}`]) {
    if (!hasCapability(operator, capability)) {
      return capability;
    }
  }
  return null;
}

function hasCapability(operator, capability) {
  const scopes = operator.principal.perAgentPolicy.scopedCapabilities;
  return scopes.includes(capability) || scopes.includes(`${capability.split(":").slice(0, -1).join(":")}:*`);
}

function tokenGrantedEvent(probe, observedAt, seq) {
  return createIdentityEvent(
    "token.Granted",
    {
      grantId: `grant-${probe.id}`,
      subject: endpointMonitorActor(),
      target: { kind: "resource", id: probe.resourceId },
      audience: "urn:hobo:synthetic-probes",
      scopes: [`synthetic:probe:${probe.resourceId}`],
      tokenRef: `vault://tokens/grant-${probe.id}`,
      expiresAt: observedAt,
    },
    {
      id: `token-granted-${probe.id}`,
      actor: endpointMonitorActor(),
      seq,
      time: observedAt,
      correlationId: probe.correlationId,
      causationId: probe.id,
    },
  );
}

function tokenUsedEvent(probe, observedAt, seq) {
  return createIdentityEvent(
    "token.Used",
    {
      grantId: `grant-${probe.id}`,
      usageId: `use-${probe.id}`,
      operation: "synthetic.probe",
      resource: probe.resourceId,
    },
    {
      id: `token-used-${probe.id}`,
      actor: endpointMonitorActor(),
      seq,
      time: observedAt,
      correlationId: probe.correlationId,
      causationId: `token-granted-${probe.id}`,
    },
  );
}

function tokenDeniedEvent(probe, capability, observedAt, seq) {
  return createIdentityEvent(
    "token.Denied",
    {
      requestId: `deny-${probe.id}`,
      subject: endpointMonitorActor(),
      target: { kind: "resource", id: probe.resourceId },
      reason: `missing capability ${capability}`,
    },
    {
      id: `token-denied-${probe.id}`,
      actor: endpointMonitorActor(),
      seq,
      time: observedAt,
      correlationId: probe.correlationId,
      causationId: probe.id,
    },
  );
}

function tokenDeniedForDrift(signal, capability, observedAt, seq) {
  return createIdentityEvent(
    "token.Denied",
    {
      requestId: `deny-${signal.id}`,
      subject: endpointMonitorActor(),
      target: { kind: "resource", id: signal.resourceId },
      reason: `missing capability ${capability}`,
    },
    {
      id: `token-denied-${signal.id}`,
      actor: endpointMonitorActor(),
      seq,
      time: observedAt,
      correlationId: signal.correlationId,
      causationId: signal.id,
    },
  );
}

function endpointMonitorActor() {
  return { kind: "agent", id: "endpoint-monitor" };
}

function groupByBurnKey(probes) {
  const groups = new Map();
  for (const probe of probes) {
    const key = `endpoint-monitor|${probe.resourceId}|${probe.sloName}`;
    const group = groups.get(key) ?? { key, probes: [] };
    group.probes.push(probe);
    groups.set(key, group);
  }
  return groups;
}

function remainingBudgetRatio(good, total) {
  return Number((good / total).toFixed(12));
}

function assertValidSloEvent(event) {
  const validation = validateSloEvent(event);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
}

function validateBurnThreshold(value) {
  return deepFreeze({
    failedProbes: validatePositiveInteger(value.failedProbes ?? 1, "burnThreshold.failedProbes"),
    window: requiredString(value.window ?? "5m", "burnThreshold.window"),
    burnRate: validateNonNegativeNumber(value.burnRate ?? 1, "burnThreshold.burnRate"),
  });
}

function validateProbes(probes) {
  if (!Array.isArray(probes)) {
    throw new Error("probes must be an array");
  }
  return probes.map((probe) =>
    deepFreeze({
      id: requiredString(probe?.id, "probe.id"),
      resourceId: requiredString(probe?.resourceId, "probe.resourceId"),
      target: requiredString(probe?.target, "probe.target"),
      sloName: requiredString(probe?.sloName, "probe.sloName"),
      correlationId: requiredString(probe?.correlationId, "probe.correlationId"),
      occurredAt: validateIso(probe?.occurredAt, "probe.occurredAt"),
      success: probe?.success === true,
      latencyMs: validateNonNegativeNumber(probe?.latencyMs, "probe.latencyMs"),
    }),
  );
}

function validateDriftSignals(signals) {
  if (!Array.isArray(signals)) {
    throw new Error("driftSignals must be an array");
  }
  return signals.map((signal) =>
    deepFreeze({
      id: requiredString(signal?.id, "driftSignal.id"),
      type: signal?.type === "resource.DriftDetected"
        ? signal.type
        : fail(`driftSignal.type must be resource.DriftDetected`),
      resourceId: requiredString(signal?.resourceId, "driftSignal.resourceId"),
      correlationId: requiredString(signal?.correlationId, "driftSignal.correlationId"),
      occurredAt: validateIso(signal?.occurredAt, "driftSignal.occurredAt"),
      payload: clone(signal?.payload ?? {}),
    }),
  );
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function validatePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function validateNonNegativeNumber(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be non-negative`);
  }
  return value;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error(message);
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
