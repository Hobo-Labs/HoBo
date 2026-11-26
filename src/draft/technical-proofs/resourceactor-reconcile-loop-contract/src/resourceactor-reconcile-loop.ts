import { stableDigest } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { parsePlaceholder } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const RESOURCEACTOR_RECONCILE_LOOP_VERSION = "hobo.resourceactor-reconcile-loop/v1";

export function createFixtureResourcePlan(overrides = {}) {
  const id = overrides.id ?? "assets";
  const port = overrides.port ?? {
    interface: "wasi:blobstore/blobstore",
    type: "objectStore",
    className: "standard"
  };
  const provider = overrides.provider ?? {
    id: "aws",
    definitionId: "aws-s3-ephemeral",
    driver: "pulumi"
  };

  return {
    apiVersion: RESOURCEACTOR_RECONCILE_LOOP_VERSION,
    deploymentId: overrides.deploymentId ?? "deploy-gallery-preview",
    id,
    name: overrides.name ?? id,
    port,
    provider,
    deps: [...(overrides.deps ?? [])],
    outputs: [...(overrides.outputs ?? ["endpoint", "resourceId"])],
    desired: clone(overrides.desired ?? {}),
    context: {
      tenant: "tenant-hobo",
      app: "gallery",
      env: "preview",
      resourceType: port.type,
      resourceClass: port.className,
      resourceId: id,
      ...overrides.context
    }
  };
}

export function createFixtureObservedState(overrides = {}) {
  return {
    lastResourceEvent: overrides.lastResourceEvent,
    outputs: clone(overrides.outputs ?? {}),
    completedExecIds: [...(overrides.completedExecIds ?? [])],
    dispatchedProgramHashes: [...(overrides.dispatchedProgramHashes ?? [])],
    providerStateHash: overrides.providerStateHash,
    nextSeq: overrides.nextSeq ?? 1
  };
}

export function createStubIacProvider({ refresh, preview } = {}) {
  const auditLog = [];

  return {
    auditLog,
    async refresh(input) {
      auditLog.push({ type: "refresh", resourceId: input.resourcePlan.id });
      if (refresh) return refresh(input);
      return { outputs: {}, providerStateHash: "sha256:empty" };
    },
    async preview(input) {
      auditLog.push({ type: "preview", resourceId: input.resourcePlan.id });
      if (preview) return preview(input);
      return { empty: true, changes: [] };
    }
  };
}

export async function reconcileResource({
  resourcePlan,
  observedState = createFixtureObservedState(),
  iacProvider,
  executor,
  dependents = []
}) {
  assertResourcePlan(resourcePlan);
  if (!iacProvider?.refresh || !iacProvider?.preview) {
    throw new Error("iacProvider with refresh and preview is required");
  }

  const state = normalizeObservedState(observedState);
  const refreshed = await iacProvider.refresh({
    resourcePlan,
    observedState: materializeObservedState(state)
  });
  const preview = await iacProvider.preview({
    resourcePlan,
    observedState: materializeObservedState(state),
    refreshed
  });

  if (preview?.empty === true) {
    if (refreshed?.applyDirty) {
      return failResource({
        resourcePlan,
        observedState: state,
        classification: "ambiguous",
        reason: "preview clean but apply dirty; reconcile required",
        causationId: "iac-preview-clean-apply-dirty"
      });
    }

    const outputs = clone(refreshed?.outputs ?? state.outputs ?? {});
    return {
      status: "converged",
      events: [],
      dispatches: [],
      outputs,
      dependentBindings: resolveDependentBindings({
        dependents,
        producer: { resourcePlan, outputs }
      }),
      observedState: materializeObservedState({
        ...state,
        outputs,
        providerStateHash: refreshed?.providerStateHash ?? state.providerStateHash
      })
    };
  }

  if (!executor?.dispatch) {
    throw new Error("executor with dispatch is required when preview is non-empty");
  }

  const iacProgram = preview.iacProgram ?? createProgramFromPreview(resourcePlan, preview);
  const programHash = hashRef(iacProgram);
  if (state.dispatchedProgramHashes.has(programHash)) {
    return {
      status: "dispatch-already-recorded",
      events: [],
      dispatches: [],
      outputs: clone(state.outputs),
      dependentBindings: resolveDependentBindings({
        dependents,
        producer: { resourcePlan, outputs: state.outputs }
      }),
      observedState: materializeObservedState(state)
    };
  }

  const correlationId = resourceCorrelationId(resourcePlan);
  const provisioning = createResourceEvent(
    "resource.Provisioning",
    {
      resourceId: resourcePlan.id,
      provider: resourcePlan.provider.id,
      driver: resourcePlan.provider.driver
    },
    {
      resourcePlan,
      correlationId,
      causationId: "iac-preview-non-empty",
      seq: state.nextSeq
    }
  );
  const execId = preview.execId ?? `exec-${resourcePlan.id}-${stableDigest({ resourcePlan, programHash }).slice(0, 12)}`;
  const dispatch = {
    execId,
    resourceId: resourcePlan.id,
    programHash,
    action: preview.action ?? iacProgram.action ?? "apply"
  };

  const execResult = await executor.dispatch(iacProgram, {
    execId,
    resourceId: resourcePlan.id,
    action: dispatch.action,
    credentialScope:
      `tenant:${resourcePlan.context.tenant}/resource:${resourcePlan.id}` +
      `/provider:${resourcePlan.provider.id}/action:${dispatch.action}`,
    correlationId
  });

  state.dispatchedProgramHashes.add(programHash);
  state.nextSeq += 1;
  const execEvents = execResult.events ?? [];

  if (execResult.status === "succeeded") {
    const settled = recordExecSucceeded({
      resourcePlan,
      execResult,
      observedState: materializeObservedState(state),
      dependents,
      causationId: execEvents.at(-1)?.id,
      correlationId
    });

    return {
      status: settled.status,
      events: [provisioning, ...execEvents, ...settled.events],
      dispatches: [dispatch],
      outputs: settled.outputs,
      dependentBindings: settled.dependentBindings,
      observedState: settled.observedState
    };
  }

  const failed = failResource({
    resourcePlan,
    observedState: state,
    classification: execResult.classification ?? "fatal",
    reason: stripClassification(execResult.reason, execResult.classification),
    causationId: execEvents.at(-1)?.id,
    correlationId
  });

  return {
    ...failed,
    events: [provisioning, ...execEvents, ...failed.events],
    dispatches: [dispatch]
  };
}

export function recordExecSucceeded({
  resourcePlan,
  execResult,
  observedState = createFixtureObservedState(),
  dependents = [],
  causationId,
  correlationId
}) {
  assertResourcePlan(resourcePlan);
  if (!execResult?.execId) {
    throw new Error("execResult.execId is required");
  }

  const state = normalizeObservedState(observedState);
  const previousOutputs = clone(state.outputs);
  if (state.completedExecIds.has(execResult.execId)) {
    return {
      status: "duplicate-success",
      events: [],
      outputs: previousOutputs,
      dependentBindings: resolveDependentBindings({
        dependents,
        producer: { resourcePlan, outputs: previousOutputs }
      }),
      observedState: materializeObservedState(state)
    };
  }

  const outputs = clone(execResult.outputs ?? {});
  const provisioned = createResourceEvent(
    "resource.Provisioned",
    {
      resourceId: resourcePlan.id,
      outputs
    },
    {
      resourcePlan,
      correlationId: correlationId ?? resourceCorrelationId(resourcePlan),
      causationId: causationId ?? execResult.events?.at(-1)?.id ?? execResult.execId,
      seq: state.nextSeq
    }
  );

  state.completedExecIds.add(execResult.execId);
  state.lastResourceEvent = "resource.Provisioned";
  state.outputs = outputs;
  state.nextSeq += 1;

  return {
    status: "provisioned",
    events: [provisioned],
    outputs,
    dependentBindings: resolveDependentBindings({
      dependents,
      producer: { resourcePlan, outputs }
    }),
    observedState: materializeObservedState(state)
  };
}

export function resolveDependentBindings({ dependents = [], producer }) {
  if (!producer) return {};

  return Object.fromEntries(
    dependents.map((dependent) => [
      dependent.id,
      {
        inputs: resolveValue(dependent.inputs ?? {}, producer)
      }
    ])
  );
}

function failResource({
  resourcePlan,
  observedState,
  classification,
  reason,
  causationId,
  correlationId = resourceCorrelationId(resourcePlan)
}) {
  const state = normalizeObservedState(observedState);
  const classifiedReason = `${classification}: ${reason}`;
  const failed = createResourceEvent(
    "resource.Failed",
    {
      resourceId: resourcePlan.id,
      reason: classifiedReason
    },
    {
      resourcePlan,
      correlationId,
      causationId: causationId ?? "iac-apply-failed",
      seq: state.nextSeq
    }
  );

  state.lastResourceEvent = "resource.Failed";
  state.nextSeq += 1;

  return {
    status: "failed",
    events: [failed],
    dispatches: [],
    outputs: clone(state.outputs),
    dependentBindings: {},
    failure: {
      classification,
      reason: classifiedReason
    },
    observedState: materializeObservedState(state)
  };
}

function createProgramFromPreview(resourcePlan, preview) {
  return {
    kind: "iac-program",
    id: `${resourcePlan.id}-${preview.action ?? "apply"}`,
    provider: resourcePlan.provider.id,
    resourceId: resourcePlan.id,
    action: preview.action ?? "apply",
    output: [],
    outputs: {}
  };
}

function createResourceEvent(type, data, { resourcePlan, correlationId, causationId, seq }) {
  const event = {
    type,
    schemaVersion: 1,
    tenant: resourcePlan.context.tenant,
    seq,
    time: "2026-06-25T00:00:00.000Z",
    actor: { kind: "service", id: `yard/resource-actor/${resourcePlan.id}` },
    correlationId,
    causationId,
    data: clone(data)
  };
  return {
    id: `evt-${stableDigest(event).slice(0, 12)}`,
    ...event
  };
}

function resolveValue(value, producer) {
  if (isJsonString(value)) {
    if (!value.startsWith("${resources.")) {
      return value;
    }

    const placeholder = parsePlaceholder(value);
    if (placeholder.kind !== "resource-output") {
      return value;
    }
    if (placeholder.id !== producer.resourcePlan.id) {
      return value;
    }
    if (
      placeholder.type !== producer.resourcePlan.port.type ||
      placeholder.className !== producer.resourcePlan.port.className
    ) {
      throw new Error(`placeholder ${value} does not match producer ${producer.resourcePlan.id} type/class`);
    }
    if (!Object.hasOwn(producer.outputs, placeholder.output)) {
      throw new Error(`placeholder ${value} references missing output ${placeholder.output}`);
    }
    return producer.outputs[placeholder.output];
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, producer));
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveValue(child, producer)]));
  }
  return value;
}

function assertResourcePlan(resourcePlan) {
  for (const field of ["id", "deploymentId"]) {
    if (!isJsonString(resourcePlan?.[field]) || resourcePlan[field].length === 0) {
      throw new Error(`resourcePlan.${field} is required`);
    }
  }
  for (const field of ["id", "driver"]) {
    if (!isJsonString(resourcePlan?.provider?.[field]) || resourcePlan.provider[field].length === 0) {
      throw new Error(`resourcePlan.provider.${field} is required`);
    }
  }
  for (const field of ["type", "className"]) {
    if (!isJsonString(resourcePlan?.port?.[field]) || resourcePlan.port[field].length === 0) {
      throw new Error(`resourcePlan.port.${field} is required`);
    }
  }
}

function normalizeObservedState(observedState) {
  return {
    lastResourceEvent: observedState?.lastResourceEvent,
    outputs: clone(observedState?.outputs ?? {}),
    completedExecIds: normalizeSet(observedState?.completedExecIds),
    dispatchedProgramHashes: normalizeSet(observedState?.dispatchedProgramHashes),
    providerStateHash: observedState?.providerStateHash,
    nextSeq: observedState?.nextSeq ?? 1
  };
}

function materializeObservedState(state) {
  return {
    lastResourceEvent: state.lastResourceEvent,
    outputs: clone(state.outputs),
    completedExecIds: [...state.completedExecIds].sort(),
    dispatchedProgramHashes: [...state.dispatchedProgramHashes].sort(),
    providerStateHash: state.providerStateHash,
    nextSeq: state.nextSeq
  };
}

function normalizeSet(value) {
  if (value instanceof Set) return new Set(value);
  return new Set(value ?? []);
}

function stripClassification(reason, classification) {
  if (!classification || !isJsonString(reason)) return reason ?? "execution failed";
  const prefix = `${classification}: `;
  return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

function resourceCorrelationId(resourcePlan) {
  return `corr-${resourcePlan.deploymentId}-${resourcePlan.id}`;
}

function hashRef(value) {
  return `sha256:${stableDigest(value)}`;
}

function clone(value) {
  return structuredClone(value);
}
