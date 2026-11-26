import { isJsonObject } from "./json.js";
const ROLLOUT_EVENT_TYPES = new Set([
  "rollout.Started",
  "rollout.Stepped",
  "rollout.Promoted",
  "rollout.RolledBack",
  "rollout.Failed",
]);
const CDEVENT_PREDICATE_TYPES = Object.freeze({
  "rollout.Started": "started",
  "rollout.Stepped": "stepped",
  "rollout.Promoted": "promoted",
  "rollout.RolledBack": "rolled-back",
  "rollout.Failed": "failed",
});
const ROLLOUT_EVENT_REQUIRED_DATA = Object.freeze({
  "rollout.Started": ["rolloutId", "target", "policy", "warnings"],
  "rollout.Stepped": ["rolloutId", "step", "state"],
  "rollout.Promoted": ["rolloutId", "finalVersion"],
  "rollout.RolledBack": ["rolloutId", "restoredVersion", "reason"],
  "rollout.Failed": ["rolloutId", "state", "reason", "dangling"],
});

export function rolloutStarted({ rolloutId, runId, tenant, target, policy, warnings = [] }) {
  return rolloutEvent({
    type: "rollout.Started",
    rolloutId,
    runId,
    tenant,
    data: { rolloutId, target, policy, warnings },
  });
}

export function createDeliveryAdapter({ supportedCapabilities = [] } = {}) {
  const rollouts = new Map();
  const supported = new Set(supportedCapabilities);

  return {
    start(request) {
      const warnings = capabilityWarnings(request.policy.requiredCapabilities ?? [], supported);
      const rollout = {
        rolloutId: request.rolloutId,
        runId: request.runId,
        tenant: request.tenant,
        target: request.target,
        policy: request.policy,
        state: "running",
        currentStep: undefined,
        warnings,
        events: [],
      };
      const event = rolloutStarted({ ...request, warnings });
      rollout.events.push(event);
      rollouts.set(request.rolloutId, rollout);

      return resultFor(rollout, [event]);
    },

    step(command) {
      const rollout = getRollout(rollouts, command.rolloutId);
      const step = rollout.policy.steps.find((candidate) => candidate.name === command.step);

      if (!step) {
        throw new Error(`unknown rollout step: ${command.step}`);
      }

      rollout.currentStep = step.name;
      const event = rolloutEvent({
        type: "rollout.Stepped",
        rolloutId: rollout.rolloutId,
        runId: rollout.runId,
        tenant: rollout.tenant,
        eventIndex: rollout.events.length,
        data: { rolloutId: rollout.rolloutId, step, state: "running" },
      });
      rollout.events.push(event);

      return resultFor(rollout, [event]);
    },

    promote(command) {
      const rollout = getRollout(rollouts, command.rolloutId);

      if (rollout.state === "promoted") {
        return resultFor(rollout, []);
      }

      rollout.state = "promoted";
      const event = rolloutEvent({
        type: "rollout.Promoted",
        rolloutId: rollout.rolloutId,
        runId: rollout.runId,
        tenant: rollout.tenant,
        eventIndex: rollout.events.length,
        data: { rolloutId: rollout.rolloutId, finalVersion: rollout.target.toVersion },
      });
      rollout.events.push(event);

      return resultFor(rollout, [event]);
    },

    rollback(command) {
      const rollout = getRollout(rollouts, command.rolloutId);
      rollout.state = "rolled-back";
      const event = rolloutEvent({
        type: "rollout.RolledBack",
        rolloutId: rollout.rolloutId,
        runId: rollout.runId,
        tenant: rollout.tenant,
        eventIndex: rollout.events.length,
        data: {
          rolloutId: rollout.rolloutId,
          restoredVersion: rollout.target.fromVersion,
          reason: command.reason ?? "rollback requested",
        },
      });
      rollout.events.push(event);

      return resultFor(rollout, [event]);
    },

    abort(command) {
      const rollout = getRollout(rollouts, command.rolloutId);
      rollout.state = "failed";
      const event = rolloutEvent({
        type: "rollout.Failed",
        rolloutId: rollout.rolloutId,
        runId: rollout.runId,
        tenant: rollout.tenant,
        eventIndex: rollout.events.length,
        data: {
          rolloutId: rollout.rolloutId,
          state: "failed",
          reason: command.reason ?? "abort requested",
          dangling: false,
        },
      });
      rollout.events.push(event);

      return resultFor(rollout, [event]);
    },

    status(rolloutId) {
      return statusFor(getRollout(rollouts, rolloutId));
    },
  };
}

export function replayRollout(events) {
  let status;

  for (const event of events) {
    validateRolloutEvent(event);

    if (event.type === "rollout.Started") {
      status = {
        rolloutId: event.data.rolloutId,
        state: "running",
        currentStep: undefined,
        warnings: event.data.warnings ?? [],
      };
      continue;
    }

    if (!status) {
      throw new Error(`rollout event stream starts with ${event.type}`);
    }

    if (event.type === "rollout.Stepped") {
      status = { ...status, state: event.data.state, currentStep: event.data.step.name };
    }

    if (event.type === "rollout.Promoted") {
      status = { ...status, state: "promoted" };
    }

    if (event.type === "rollout.RolledBack") {
      status = { ...status, state: "rolled-back" };
    }

    if (event.type === "rollout.Failed") {
      status = { ...status, state: "failed" };
    }
  }

  if (!status) {
    throw new Error("rollout event stream is empty");
  }

  return Object.freeze(status);
}

export function exportToCDEvent(event) {
  validateRolloutEvent(event);

  return deepFreeze({
    context: {
      version: "0.4.1",
      id: event.id,
      source: event.source,
    },
    subject: {
      id: event.subject,
      type: "service",
      content: {
        service: event.data.target?.service,
      },
    },
    predicate: {
      type: CDEVENT_PREDICATE_TYPES[event.type],
      content: {
        hoboRolloutEvent: structuredClone(event),
      },
    },
  });
}

export function importFromCDEvent(cdEvent) {
  const event = cdEvent?.predicate?.content?.hoboRolloutEvent;

  if (!event) {
    throw new Error("CDEvent missing hoboRolloutEvent content");
  }

  return validateRolloutEvent(event);
}

export function validateRolloutEvent(event) {
  if (!event || !isJsonObject(event)) {
    throw new Error("rollout event must be an object");
  }

  if (!ROLLOUT_EVENT_TYPES.has(event.type)) {
    throw new Error(`unsupported rollout event: ${event.type}`);
  }

  for (const field of ["id", "source", "specversion", "type", "subject", "data", "runId", "tenant"]) {
    if (event[field] === undefined || event[field] === null || event[field] === "") {
      throw new Error(`rollout event missing ${field}`);
    }
  }

  if (event.specversion !== "1.0") {
    throw new Error("rollout event must use CloudEvents specversion 1.0");
  }

  if (event.source !== "hobo:delivery") {
    throw new Error("rollout event source must be hobo:delivery");
  }

  if (event.subject !== event.data.rolloutId) {
    throw new Error("rollout event subject must equal data.rolloutId");
  }

  for (const field of ROLLOUT_EVENT_REQUIRED_DATA[event.type]) {
    requirePresent(event.data, field, `${event.type} data`);
  }

  return event;
}

function rolloutEvent({ type, rolloutId, runId, tenant, data, eventIndex = 0 }) {
  return Object.freeze({
    specversion: "1.0",
    id: `${type}:${rolloutId}:${eventIndex}`,
    source: "hobo:delivery",
    type,
    subject: rolloutId,
    runId,
    tenant,
    data: deepFreeze(structuredClone(data)),
  });
}

function capabilityWarnings(requiredCapabilities, supported) {
  return requiredCapabilities
    .filter((capability) => !supported.has(capability))
    .map((capability) => ({
      code: "delivery.capability_unavailable",
      message: `adapter does not declare ${capability}; planning must choose a degraded strategy or adapter`,
      missingCapability: capability,
    }));
}

function getRollout(rollouts, rolloutId) {
  const rollout = rollouts.get(rolloutId);

  if (!rollout) {
    throw new Error(`unknown rollout: ${rolloutId}`);
  }

  return rollout;
}

function resultFor(rollout, events) {
  return Object.freeze({
    status: statusFor(rollout),
    events: Object.freeze(events),
  });
}

function statusFor(rollout) {
  return Object.freeze({
    rolloutId: rollout.rolloutId,
    state: rollout.state,
    currentStep: rollout.currentStep,
    warnings: rollout.warnings,
  });
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function requirePresent(record, field, label) {
  if (record[field] === undefined || record[field] === null || record[field] === "") {
    throw new Error(`${label} missing ${field}`);
  }
}
