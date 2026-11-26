import {
  DRIVER_IDS,
  createDriver,
  driverContractFor,
  stableDigest
} from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import {
  createFixtureIacProgram,
  createInProcessExecutor,
  createStubTokenBroker
} from "../../executor-skeleton-contract/src/executor-skeleton.js";
import { isJsonObject } from "./json.js";


export const DRIVER_DISPATCH_ROUTING_VERSION = "hobo.driver-dispatch-routing/v1";

const DRIVER_ID_SET = new Set(DRIVER_IDS);

export class DriverDispatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DriverDispatchError";
    this.code = code;
    this.details = details;
  }
}

export function createDriverDispatchRouter({ drivers = [], executor, tokenBroker } = {}) {
  const registry = new Map();
  for (const driver of drivers) {
    const normalized = createDriver(driver);
    registry.set(normalized.id, normalized);
  }

  const broker = tokenBroker ?? createStubTokenBroker();
  const exec = executor ?? createInProcessExecutor({ tokenBroker: broker });

  return Object.freeze({
    registry,
    async provision(input) {
      const normalized = normalizeDispatchInput(input);
      const { definition, resource, context, inputs, oldState, dependents } = normalized;
      const driverId = definition.driver;

      if (driverContractFor(driverId).mutability === "read-only") {
        return provisionEcho({ definition, resource, context, inputs, dependents });
      }

      const driver = requireRegisteredDriver(registry, driverId);
      const events = [];
      emit(events, "resource.Provisioning", eventData({ definition, resource, context }));

      let driverResult;
      try {
        driverResult = await driver.provision(provisionInput({ context, inputs, oldState }));
      } catch (error) {
        return failedProvision({
          events,
          definition,
          resource,
          context,
          failure: failureFromError(error, driverId)
        });
      }

      if (!driverResult || !isPlainObject(driverResult.outputs)) {
        return failedProvision({
          events,
          definition,
          resource,
          context,
          failure: {
            code: "missing-driver-outputs",
            classification: "fatal",
            reason: `driver ${driverId} returned manifests/state without an outputs object`
          }
        });
      }

      const execResult = await exec.dispatch(
        createFixtureIacProgram({
          id: `driver-${driverId}-${resource.id}-provision`,
          provider: definition.provider,
          resourceId: resource.id,
          action: "provision",
          output: [`driver ${driverId} provision ${resource.id}`],
          outputs: driverResult.outputs
        }),
        {
          execId: `exec-${driverId}-${resource.id}`,
          resourceId: resource.id,
          action: "provision",
          credentialScope: `${definition.provider}:${driverId}:provision`,
          correlationId: context.correlationId ?? `corr-${resource.id}-driver-dispatch`
        }
      );

      events.push(...execResult.events.map(clone));
      if (execResult.status !== "succeeded") {
        return failedProvision({
          events,
          definition,
          resource,
          context,
          failure: {
            code: "executor-failed",
            classification: execResult.classification ?? "fatal",
            reason: execResult.reason
          }
        });
      }

      const resolvedDependents = resolveDependentPlaceholders({
        resourceId: resource.id,
        outputs: driverResult.outputs,
        dependents
      });
      const provisioned = emit(events, "resource.Provisioned", {
        ...eventData({ definition, resource, context }),
        outputs: clone(driverResult.outputs),
        manifests: clone(driverResult.manifests ?? []),
        state: clone(driverResult.state ?? null),
        execId: execResult.execId,
        resolvedDependents
      });

      return {
        status: "provisioned",
        readOnly: false,
        events,
        execResult,
        provisioned,
        resolvedDependents,
        state: clone(driverResult.state ?? null)
      };
    },
    async destroy(input) {
      const normalized = normalizeDispatchInput(input);
      const { definition, resource, context, state } = normalized;

      if (driverContractFor(definition.driver).mutability === "read-only") {
        const events = [];
        const destroyed = emit(events, "resource.Destroyed", eventData({ definition, resource, context }));
        return { status: "destroyed", readOnly: true, events, destroyed };
      }

      const driver = requireRegisteredDriver(registry, definition.driver);
      await driver.destroy({ context, state });
      const execResult = await exec.dispatch(
        createFixtureIacProgram({
          id: `driver-${definition.driver}-${resource.id}-destroy`,
          provider: definition.provider,
          resourceId: resource.id,
          action: "destroy",
          output: [`driver ${definition.driver} destroy ${resource.id}`],
          outputs: { destroyed: true }
        }),
        {
          execId: `exec-${definition.driver}-${resource.id}-destroy`,
          resourceId: resource.id,
          action: "destroy",
          credentialScope: `${definition.provider}:${definition.driver}:destroy`,
          correlationId: context.correlationId ?? `corr-${resource.id}-driver-destroy`
        }
      );
      const events = execResult.events.map(clone);
      if (execResult.status !== "succeeded") {
        return failedProvision({
          events,
          definition,
          resource,
          context,
          failure: {
            code: "executor-failed",
            classification: execResult.classification ?? "fatal",
            reason: execResult.reason
          }
        });
      }

      const destroyed = emit(events, "resource.Destroyed", eventData({ definition, resource, context }));
      return { status: "destroyed", readOnly: false, events, execResult, destroyed };
    },
    async refresh(input) {
      const normalized = normalizeDispatchInput(input);
      const { definition, resource, context, inputs, state } = normalized;
      if (driverContractFor(definition.driver).mutability === "read-only") {
        return refreshEcho({ definition, resource, context, inputs, state });
      }

      const driver = requireRegisteredDriver(registry, definition.driver);
      const refreshed = driver.refresh ? await driver.refresh({ context, state }) : state;
      const events = [];
      const event = emit(events, "resource.Refreshed", {
        ...eventData({ definition, resource, context }),
        state: clone(refreshed)
      });
      return { status: "refreshed", events, event, state: clone(refreshed) };
    }
  });
}

export function createFixtureDriver(id, options = {}) {
  const calls = {
    provision: [],
    destroy: [],
    refresh: []
  };
  const hasOutputs = Object.hasOwn(options, "outputs");

  return {
    id,
    calls,
    async provision(input) {
      calls.provision.push(clone(input));
      if (options.fail) {
        throw options.fail;
      }
      return {
        ...(hasOutputs ? { outputs: clone(options.outputs) } : undefined),
        ...(Object.hasOwn(options, "manifests") ? { manifests: clone(options.manifests) } : undefined),
        ...(Object.hasOwn(options, "state") ? { state: clone(options.state) } : undefined)
      };
    },
    async destroy(input) {
      calls.destroy.push(clone(input));
    },
    async refresh(input) {
      calls.refresh.push(clone(input));
      return clone(options.refreshState ?? input.state ?? null);
    }
  };
}

export function createFixtureResource(id, overrides = {}) {
  return {
    id,
    type: overrides.type ?? "database",
    name: overrides.name ?? id,
    deps: clone(overrides.deps ?? [])
  };
}

function normalizeDispatchInput(input) {
  if (!input?.definition) {
    throw new DriverDispatchError("missing-definition", "definition is required");
  }
  if (!input?.resource?.id) {
    throw new DriverDispatchError("missing-resource", "resource.id is required");
  }
  if (!input.definition.provider) {
    throw new DriverDispatchError("missing-provider", "definition.provider is required");
  }
  if (!DRIVER_ID_SET.has(input.definition.driver)) {
    throw new DriverDispatchError(
      "unknown-driver",
      `unknown driver id ${input.definition.driver ?? "<missing>"}`
    );
  }

  return {
    definition: clone(input.definition),
    resource: clone(input.resource),
    context: clone(input.context ?? {}),
    inputs: clone(input.inputs ?? {}),
    oldState: clone(input.oldState),
    state: clone(input.state),
    dependents: clone(input.dependents ?? [])
  };
}

function provisionEcho({ definition, resource, context, inputs, dependents }) {
  const outputs = inputs.connection;
  const events = [];
  if (!isPlainObject(outputs)) {
    return failedProvision({
      events,
      definition,
      resource,
      context,
      failure: {
        code: "missing-echo-connection",
        classification: "fatal",
        reason: "echo driver requires inputs.connection outputs"
      }
    });
  }

  const resolvedDependents = resolveDependentPlaceholders({
    resourceId: resource.id,
    outputs,
    dependents
  });
  const provisioned = emit(events, "resource.Provisioned", {
    ...eventData({ definition, resource, context }),
    outputs: clone(outputs),
    manifests: [],
    state: null,
    readOnly: true,
    resolvedDependents
  });

  return {
    status: "provisioned",
    readOnly: true,
    events,
    provisioned,
    resolvedDependents,
    state: null
  };
}

function provisionInput({ context, inputs, oldState }) {
  return oldState === undefined ? { context, inputs } : { context, inputs, oldState };
}

function refreshEcho({ definition, resource, context, inputs, state }) {
  const previous = pickConnectionLike(state);
  const observed = isPlainObject(inputs.connection) ? inputs.connection : previous;
  const drift = {
    mode: "read-only",
    changed: stableDigest(previous) !== stableDigest(observed),
    previous: clone(previous),
    observed: clone(observed)
  };
  const events = [];
  const event = emit(events, "resource.Refreshed", {
    ...eventData({ definition, resource, context }),
    outputs: clone(observed),
    state: clone(state ?? null),
    readOnly: true,
    drift
  });

  return {
    status: "refreshed",
    readOnly: true,
    events,
    event,
    state: clone(state ?? null),
    drift
  };
}

function requireRegisteredDriver(registry, driverId) {
  const driver = registry.get(driverId);
  if (!driver) {
    throw new DriverDispatchError("driver-not-registered", `driver ${driverId} is not registered`);
  }
  return driver;
}

function resolveDependentPlaceholders({ resourceId, outputs, dependents }) {
  return dependents.map((dependent) => {
    const values = {};
    for (const [name, placeholder] of Object.entries(dependent.placeholders ?? {})) {
      if (placeholder.from !== resourceId) continue;
      if (!Object.hasOwn(outputs, placeholder.output)) {
        throw new DriverDispatchError(
          "placeholder-output-missing",
          `dependent ${dependent.resourceId} references missing ${resourceId}.${placeholder.output}`
        );
      }
      values[name] = clone(outputs[placeholder.output]);
    }
    return { resourceId: dependent.resourceId, values };
  });
}

function failedProvision({ events, definition, resource, context, failure }) {
  const normalizedFailure = {
    code: failure.code,
    classification: failure.classification,
    reason: failure.reason
  };
  emit(events, "resource.Failed", {
    ...eventData({ definition, resource, context }),
    failure: normalizedFailure
  });
  return {
    status: "failed",
    events,
    failure: normalizedFailure
  };
}

function failureFromError(error, driverId) {
  const message = error?.message ?? String(error);
  const timedOut = error?.code === "ETIMEDOUT" || /timeout|timed out/i.test(message);
  return {
    code: timedOut ? "driver-timeout" : "driver-failed",
    classification: driverId === "custom-webhook" && timedOut ? "retryable" : "fatal",
    reason: message
  };
}

function eventData({ definition, resource, context }) {
  return {
    resourceId: resource.id,
    definitionId: definition.id,
    provider: definition.provider,
    driver: definition.driver,
    context: clone(context)
  };
}

function emit(events, type, data) {
  const event = {
    id: `evt-${stableDigest({ type, data, seq: events.length + 1 }).slice(0, 12)}`,
    type,
    schema: DRIVER_DISPATCH_ROUTING_VERSION,
    seq: events.length + 1,
    time: "2026-06-26T00:00:00.000Z",
    data: clone(data)
  };
  events.push(event);
  return event;
}

function isPlainObject(value) {
  return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

function pickConnectionLike(value) {
  if (isPlainObject(value?.outputs)) return value.outputs;
  if (isPlainObject(value?.connection)) return value.connection;
  if (isPlainObject(value)) return value;
  return {};
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
