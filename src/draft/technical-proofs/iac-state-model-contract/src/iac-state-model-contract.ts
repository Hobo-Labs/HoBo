import { isJsonString, isJsonObject } from "./json.js";
export const IAC_STATE_MODEL_VERSION = "hobo.iac-state-model/v1";

const DEFAULT_TENANT_ID = "tenant-acme";
const DEFAULT_DEPLOYMENT_ID = "deployment-prod";

export class IacStateModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IacStateModelError";
    this.code = code;
  }
}

export function createResourceRef({
  tenantId = DEFAULT_TENANT_ID,
  deploymentId = DEFAULT_DEPLOYMENT_ID,
  resourceId,
} = {}) {
  if (!resourceId) {
    throw new IacStateModelError("invalid-resource-ref", "resourceId is required");
  }

  return deepFreeze({ tenantId, deploymentId, resourceId });
}

export function resourceStackKey(ref) {
  const normalized = createResourceRef(ref);

  return `${safeSegment(normalized.tenantId)}/${safeSegment(normalized.deploymentId)}/${safeSegment(
    normalized.resourceId,
  )}`;
}

export function createInMemoryLeaseAuthority() {
  const leases = new Map();
  let nextEpoch = 1;

  return {
    acquire(stackKey, writerId, operation) {
      const existing = leases.get(stackKey);
      if (existing) {
        throw new IacStateModelError(
          "lease-held",
          `resource stack ${stackKey} is already leased by ${existing.writerId}`,
        );
      }

      const lease = deepFreeze({
        stackKey,
        writerId,
        operation,
        token: `${stackKey}#lease-${nextEpoch}`,
        epoch: nextEpoch,
      });
      nextEpoch += 1;
      leases.set(stackKey, lease);

      return lease;
    },
    release(lease) {
      const current = leases.get(lease.stackKey);
      if (current?.token === lease.token) {
        leases.delete(lease.stackKey);
      }
    },
    current(stackKey) {
      return leases.get(stackKey);
    },
  };
}

export function createInMemoryStateBackend() {
  const stacks = new Map();
  const lostBackendLocks = new Set();
  let nextWriteFailure;

  return {
    getStack(stackKey) {
      const stack = stacks.get(stackKey);
      return stack ? deepFreeze(structuredClone(stack)) : undefined;
    },
    persistStack(stackKey, record, lease) {
      ensureLease(lease, stackKey);
      throwNextWriteFailure();
      stacks.set(
        stackKey,
        deepFreeze({
          ...structuredClone(record),
          stackKey,
          leaseEpoch: lease.epoch,
          backendLockStatus: lostBackendLocks.has(stackKey) ? "lost" : "held",
        }),
      );
      lostBackendLocks.delete(stackKey);
    },
    deleteStack(stackKey, lease) {
      ensureLease(lease, stackKey);
      throwNextWriteFailure();
      stacks.delete(stackKey);
      lostBackendLocks.delete(stackKey);
    },
    recordOrphanedStack(stackKey, { outputs = {}, reason }) {
      stacks.set(
        stackKey,
        deepFreeze({
          stackKey,
          status: "orphaned",
          outputs: structuredClone(outputs),
          reason,
          reconcileRequired: true,
        }),
      );
    },
    simulateLostBackendLock(stackKey) {
      lostBackendLocks.add(stackKey);
    },
    failNextWrite(reason = "state backend unavailable") {
      nextWriteFailure = reason;
    },
  };

  function throwNextWriteFailure() {
    if (!nextWriteFailure) {
      return;
    }

    const message = nextWriteFailure;
    nextWriteFailure = undefined;
    throw new IacStateModelError("state-backend-unavailable", message);
  }
}

export function createIacStateModel({ stateBackend, leaseAuthority } = {}) {
  if (!stateBackend) {
    throw new IacStateModelError("missing-state-backend", "stateBackend is required");
  }
  if (!leaseAuthority) {
    throw new IacStateModelError("missing-lease-authority", "leaseAuthority is required");
  }

  return {
    beginResourceOperation(ref, { operation, writerId }) {
      const normalized = createResourceRef(ref);
      const stackKey = resourceStackKey(normalized);
      const lease = leaseAuthority.acquire(stackKey, writerId, operation);
      let released = false;

      return {
        stackKey,
        lease,
        apply: ({ outputs = {}, spec = {} } = {}) => {
          assertNotReleased();
          const stackRecord = {
            schema: IAC_STATE_MODEL_VERSION,
            status: "provisioned",
            ref: normalized,
            specHash: stableJson(spec),
            outputs: structuredClone(outputs),
          };
          stateBackend.persistStack(stackKey, stackRecord, lease);

          return {
            stackKey,
            events: [
              resourceProvisionedEvent(normalized, {
                stackKey,
                outputs,
                lease,
              }),
            ],
          };
        },
        destroy: () => {
          assertNotReleased();
          stateBackend.deleteStack(stackKey, lease);
          return {
            stackKey,
            events: [
              resourceDestroyedEvent(normalized, {
                stackKey,
                lease,
              }),
            ],
          };
        },
        release: () => {
          if (!released) {
            leaseAuthority.release(lease);
            released = true;
          }
        },
      };

      function assertNotReleased() {
        if (released) {
          throw new IacStateModelError("lease-released", `resource stack ${stackKey} lease is released`);
        }
      }
    },
    async applyResource(ref, options = {}) {
      const op = this.beginResourceOperation(ref, {
        operation: "apply",
        writerId: options.writerId,
      });

      try {
        return op.apply({ outputs: options.outputs, spec: options.spec });
      } finally {
        op.release();
      }
    },
    async destroyResource(ref, options = {}) {
      const op = this.beginResourceOperation(ref, {
        operation: "destroy",
        writerId: options.writerId,
      });

      try {
        return op.destroy();
      } finally {
        op.release();
      }
    },
    resolveBindings(_consumerRef, bindings) {
      const resolved = {};

      for (const binding of bindings) {
        if (Object.hasOwn(resolved, binding.as)) {
          throw new IacStateModelError(
            "binding-output-collision",
            `binding output ${binding.as} is produced by more than one resource`,
          );
        }

        const stack = stateBackend.getStack(resourceStackKey(binding.from));
        if (!stack || stack.status !== "provisioned") {
          throw new IacStateModelError(
            "binding-source-unavailable",
            `binding source ${resourceStackKey(binding.from)} is not provisioned`,
          );
        }
        if (!Object.hasOwn(stack.outputs, binding.output)) {
          throw new IacStateModelError(
            "binding-output-missing",
            `binding source ${resourceStackKey(binding.from)} has no output ${binding.output}`,
          );
        }

        resolved[binding.as] = structuredClone(stack.outputs[binding.output]);
      }

      return deepFreeze(resolved);
    },
    inspectResourceState(ref) {
      const stackKey = resourceStackKey(ref);
      const stack = stateBackend.getStack(stackKey);

      if (!stack) {
        return deepFreeze({ stackKey, status: "absent", reconcileRequired: false });
      }
      if (stack.status === "orphaned") {
        return deepFreeze({
          stackKey,
          status: "orphaned",
          reconcileRequired: true,
          reason: stack.reason,
          outputs: structuredClone(stack.outputs ?? {}),
        });
      }

      return deepFreeze({
        stackKey,
        status: stack.status,
        reconcileRequired: false,
        outputs: structuredClone(stack.outputs ?? {}),
      });
    },
    currentLease(stackKey) {
      return leaseAuthority.current(stackKey);
    },
  };
}

function resourceProvisionedEvent(ref, { stackKey, outputs, lease }) {
  return deepFreeze({
    type: "resource.Provisioned",
    schema: IAC_STATE_MODEL_VERSION,
    data: {
      tenantId: ref.tenantId,
      deploymentId: ref.deploymentId,
      resourceId: ref.resourceId,
      stackKey,
      leaseEpoch: lease.epoch,
      outputs: structuredClone(outputs),
    },
  });
}

function resourceDestroyedEvent(ref, { stackKey, lease }) {
  return deepFreeze({
    type: "resource.Destroyed",
    schema: IAC_STATE_MODEL_VERSION,
    data: {
      tenantId: ref.tenantId,
      deploymentId: ref.deploymentId,
      resourceId: ref.resourceId,
      stackKey,
      leaseEpoch: lease.epoch,
    },
  });
}

function ensureLease(lease, stackKey) {
  if (!lease || lease.stackKey !== stackKey) {
    throw new IacStateModelError("missing-lease", `state write for ${stackKey} requires ActorHost lease`);
  }
}

function safeSegment(value) {
  if (!isJsonString(value) || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new IacStateModelError("invalid-stack-key-segment", `invalid stack key segment ${value}`);
  }

  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}
