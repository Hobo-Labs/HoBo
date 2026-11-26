import { createHash } from "node:crypto";

export const RESOURCE_ACTOR_STATES = Object.freeze([
  "Pending",
  "Planning",
  "Provisioning",
  "Provisioned",
  "Failed",
  "Compensating",
  "Destroying",
  "Destroyed"
]);

const TRANSITIONS = Object.freeze({
  Pending: Object.freeze({ depsSatisfied: { next: "Planning", eventType: null } }),
  Planning: Object.freeze({ dispatch: { next: "Provisioning", eventType: "resource.Provisioning" } }),
  Provisioning: Object.freeze({
    applyOk: { next: "Provisioned", eventType: "resource.Provisioned" },
    applyFailed: { next: "Failed", eventType: "resource.Failed" }
  }),
  Provisioned: Object.freeze({ rollbackRequested: { next: "Compensating", eventType: null } }),
  Failed: Object.freeze({ rollbackRequested: { next: "Compensating", eventType: null } }),
  Compensating: Object.freeze({
    destroyStarted: { next: "Destroying", eventType: "resource.Destroying" }
  }),
  Destroying: Object.freeze({ destroyOk: { next: "Destroyed", eventType: "resource.Destroyed" } })
});

export function createMockExecutor(options = {}) {
  const failApply = new Set(options.failApplyResourceIds ?? []);
  const failDestroy = new Map(Object.entries(options.failDestroy ?? {}));
  const auditLog = [];

  return {
    auditLog,
    async apply({ resourceId }) {
      auditLog.push({ op: "apply", resourceId });
      if (failApply.has(resourceId)) {
        return { ok: false, reason: options.applyFailureReason ?? "executor-apply-failed", crossedNoGoThreshold: true };
      }
      return { ok: true, outputs: { endpoint: `${resourceId}-endpoint` } };
    },
    async destroy({ resourceId }) {
      auditLog.push({ op: "destroy", resourceId });
      const failure = failDestroy.get(resourceId);
      if (failure) {
        return { ok: false, reason: failure.reason ?? "executor-destroy-failed" };
      }
      return { ok: true };
    }
  };
}

export function createOrchestratorReconciliation(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory();
  const actorHost = options.actorHost ?? createMinimalActorHost();
  const executor = options.executor ?? createMockExecutor();

  return {
    async run({
      plan,
      correlationId = plan?.deploymentId ?? "corr-orchestrator-reconciliation",
      tenant = plan?.resources?.[0]?.context?.tenant ?? "tenant-hobo",
      actor = { kind: "service", id: "yard/orchestrator" },
      causationId = "cmd-deploy-requested",
      eventLog = [],
      failApplyResourceIds = [],
      stallResourceIds = []
    }) {
      const contract = createRunContract({
        plan,
        correlationId,
        tenant,
        actor,
        causationId,
        eventLog,
        failApplyResourceIds,
        stallResourceIds,
        now,
        idFactory,
        actorHost,
        executor
      });

      await provisionUntilStable(contract);
      if (contract.triggeringFailure) {
        await compensate(contract);
      }

      return finalize(contract);
    }
  };
}

export function replayOrchestration({ plan, events }) {
  const resources = indexResources(plan);
  const state = createReplayState(resources);
  for (const event of events) {
    applyReplayEvent(state, event);
  }
  return summarizeReplay(resources, state);
}

function createRunContract(input) {
  const resources = indexResources(input.plan);
  const contract = {
    plan: input.plan,
    resources,
    correlationId: input.correlationId,
    tenant: input.tenant,
    actor: input.actor,
    causationId: input.causationId,
    now: input.now,
    idFactory: input.idFactory,
    actorHost: input.actorHost,
    executor: input.executor,
    failApply: new Set(input.failApplyResourceIds),
    stalled: new Set(input.stallResourceIds),
    events: [],
    actors: new Map(),
    nextSeq: 1,
    lastEventId: input.causationId,
    rollbackStarted: false,
    triggeringFailure: null,
    activationLog: [],
    wave: 0
  };

  for (const resource of resources.values()) {
    contract.actors.set(resource.id, createResourceActorState(resource, input.plan.deploymentId));
    emit(contract, "resource.Pending", { resourceId: resource.id, deps: [...resource.deps] });
  }

  for (const event of input.eventLog) {
    const copy = structuredClone(event);
    contract.events.push(copy);
    ingestEvent(contract, copy);
  }

  contract.nextSeq = maxSeq(contract.events) + 1;
  return contract;
}

async function provisionUntilStable(contract) {
  let progressed = true;
  while (progressed) {
    progressed = false;

    for (const resource of contract.resources.values()) {
      const actor = contract.actors.get(resource.id);
      if (actor.state !== "Pending") continue;
      if (!depsProvisioned(contract, resource)) continue;

      emitActorTransition(contract, resource.id, "depsSatisfied", {});
      progressed = true;
    }

    for (const resource of contract.resources.values()) {
      const actor = contract.actors.get(resource.id);
      if (actor.state !== "Planning") continue;

      const lease = contract.actorHost.acquire(actorKey(contract, resource.id), contract.actor.id);
      emitActorTransition(contract, resource.id, "dispatch", {
        resourceId: resource.id,
        provider: resource.provider?.id,
        driver: resource.provider?.driver
      });
      lease.release();
      progressed = true;
    }

    for (const resource of contract.resources.values()) {
      const actor = contract.actors.get(resource.id);
      if (actor.state !== "Provisioning") continue;
      if (contract.stalled.has(resource.id)) continue;

      const shouldFail = contract.failApply.has(resource.id);
      const result = shouldFail
        ? { ok: false, reason: "injected-apply-failure", crossedNoGoThreshold: true }
        : await contract.executor.apply({ resourceId: resource.id, resourcePlan: resource });

      if (result.ok) {
        emitActorTransition(contract, resource.id, "applyOk", {
          resourceId: resource.id,
          outputs: result.outputs ?? {}
        });
        contract.activationLog.push({
          resourceId: resource.id,
          wave: contract.wave,
          satisfiedDependencies: [...resource.deps]
        });
        contract.wave += 1;
      } else {
        emitActorTransition(contract, resource.id, "applyFailed", {
          resourceId: resource.id,
          reason: result.reason ?? "apply-failed"
        });
        if (result.crossedNoGoThreshold) {
          contract.triggeringFailure = { resourceId: resource.id, reason: result.reason };
        }
      }
      progressed = true;
    }

    if (contract.triggeringFailure) break;

    const allProvisioned = [...contract.resources.keys()].every((id) => contract.actors.get(id).state === "Provisioned");
    if (allProvisioned && !contract.rollbackStarted) {
      emit(contract, "deployment.Deployed", {
        deploymentId: contract.plan.deploymentId,
        setId: deploymentSetId(contract.plan),
        resourceIds: [...contract.resources.keys()].sort()
      });
      break;
    }

    const waiting = [...contract.resources.keys()].some((id) => {
      const state = contract.actors.get(id).state;
      return state !== "Provisioned" && state !== "Failed" && state !== "Destroyed";
    });
    if (!waiting && !allProvisioned) break;
    if (!progressed && waiting) break;
  }
}

async function compensate(contract) {
  if (!contract.triggeringFailure) return;

  if (!contract.rollbackStarted) {
    emit(contract, "deployment.RolledBack", {
      deploymentId: contract.plan.deploymentId,
      targetSetId: contract.plan.targetSetId ?? `${contract.plan.deploymentId}-previous-set`,
      reason: `resource ${contract.triggeringFailure.resourceId} crossed no-go threshold`
    });
    contract.rollbackStarted = true;
  }

  for (const resourceId of reverseTopologicalProvisionedOrder(contract)) {
    const actor = contract.actors.get(resourceId);
    if (actor.state === "Destroyed") continue;

    const liveDependents = dependentsOf(contract, resourceId).filter((depId) => {
      const depState = contract.actors.get(depId).state;
      return depState !== "Destroyed" && isProvisionedOrCompensating(depState);
    });
    if (liveDependents.length > 0) continue;

    if (actor.state === "Provisioned" || actor.state === "Failed") {
      emitActorTransition(contract, resourceId, "rollbackRequested", { resourceId });
    }
    if (contract.actors.get(resourceId).state === "Compensating") {
      emitActorTransition(contract, resourceId, "destroyStarted", {
        resourceId,
        reason: "rollback-compensation"
      });
    }

    const destroyResult = await contract.executor.destroy({ resourceId, resourcePlan: contract.resources.get(resourceId) });
    if (!destroyResult.ok) {
      emit(contract, "resource.Failed", {
        resourceId,
        reason: `compensation-failed: ${destroyResult.reason ?? "destroy-failed"}`
      });
      break;
    }
    emitActorTransition(contract, resourceId, "destroyOk", {
      resourceId,
      finalStateHash: finalStateHash(resourceId)
    });
  }
}

function emitActorTransition(contract, resourceId, action, details) {
  const actor = contract.actors.get(resourceId);
  const transition = TRANSITIONS[actor.state]?.[action];
  if (!transition) {
    throw new Error(`illegal ResourceActor transition: ${action} from ${actor.state} for ${resourceId}`);
  }

  actor.state = transition.next;
  actor.sequence += 1;
  if (!transition.eventType) {
    return null;
  }
  return emit(contract, transition.eventType, { resourceId, ...details });
}

function emit(contract, type, data) {
  const event = {
    id: contract.idFactory(type, data, contract.nextSeq),
    type,
    schemaVersion: 1,
    tenant: contract.tenant,
    seq: contract.nextSeq,
    time: contract.now(),
    actor: contract.actor,
    correlationId: contract.correlationId,
    causationId: contract.lastEventId,
    data: clone(data)
  };
  contract.nextSeq += 1;
  contract.events.push(event);
  contract.lastEventId = event.id;
  ingestEvent(contract, event);
  return event;
}

function ingestEvent(contract, event) {
  if (event.type === "resource.Pending") {
    contract.actors.get(event.data.resourceId).state = "Pending";
    return;
  }
  if (event.type === "resource.Provisioning") {
    contract.actors.get(event.data.resourceId).state = "Provisioning";
    return;
  }
  if (event.type === "resource.Provisioned") {
    contract.actors.get(event.data.resourceId).state = "Provisioned";
    return;
  }
  if (event.type === "resource.Failed") {
    contract.actors.get(event.data.resourceId).state = "Failed";
    if (!contract.rollbackStarted && !contract.triggeringFailure) {
      contract.triggeringFailure = { resourceId: event.data.resourceId, reason: event.data.reason };
    }
    return;
  }
  if (event.type === "deployment.RolledBack") {
    contract.rollbackStarted = true;
    return;
  }
  if (event.type === "resource.Destroying") {
    contract.actors.get(event.data.resourceId).state = "Destroying";
    return;
  }
  if (event.type === "resource.Destroyed") {
    contract.actors.get(event.data.resourceId).state = "Destroyed";
  }
}

function finalize(contract) {
  const resourceIds = [...contract.resources.keys()].sort();
  const actors = resourceIds.map((resourceId) => {
    const resource = contract.resources.get(resourceId);
    const actor = contract.actors.get(resourceId);
    return {
      resourceId,
      actorKey: actorKey(contract, resourceId),
      deps: [...resource.deps],
      subscriptions: resource.deps.map((dep) => `resource.Provisioned:${dep}`),
      state: actor.state,
      sequence: actor.sequence
    };
  });

  const provisionedResourceIds = resourceIds.filter((id) => contract.actors.get(id).state === "Provisioned");
  const destroyedResourceIds = resourceIds.filter((id) => contract.actors.get(id).state === "Destroyed");

  let status = "waiting";
  if (contract.events.some((event) => event.type === "deployment.Deployed")) {
    status = "deployed";
  } else if (contract.rollbackStarted) {
    status = contract.events.some((event) =>
      event.type === "resource.Failed" && event.data.reason?.startsWith("compensation-failed")
    )
      ? "needs-human"
      : destroyedResourceIds.length > 0
        ? "rolled-back"
        : "compensating";
  } else if (provisionedResourceIds.length === resourceIds.length) {
    status = "provisioned";
  }

  return {
    status,
    events: contract.events.map(clone),
    activationLog: contract.activationLog.map(clone),
    executorAuditLog: contract.executor.auditLog.map(clone),
    state: {
      status,
      actors,
      provisionedResourceIds,
      destroyedResourceIds,
      rollbackStarted: contract.rollbackStarted
    }
  };
}

function createResourceActorState(resource, deploymentId) {
  return {
    deploymentId,
    resourceId: resource.id,
    state: "Pending",
    sequence: 0
  };
}

function createMinimalActorHost() {
  const leases = new Map();
  return {
    acquire(actorKey, ownerId) {
      const heldBy = leases.get(actorKey);
      if (heldBy && heldBy !== ownerId) {
        throw new Error(`resource actor lease held by ${heldBy} for ${actorKey}`);
      }
      leases.set(actorKey, ownerId);
      return {
        release() {
          if (leases.get(actorKey) === ownerId) leases.delete(actorKey);
        }
      };
    }
  };
}

function actorKey(contract, resourceId) {
  return `resource:${contract.plan.deploymentId}:${resourceId}`;
}

function depsProvisioned(contract, resource) {
  return resource.deps.every((dep) => contract.actors.get(dep).state === "Provisioned");
}

function reverseTopologicalProvisionedOrder(contract) {
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();

  for (const resourceId of contract.resources.keys()) {
    if (isProvisionedOrCompensating(contract.actors.get(resourceId).state)) visit(resourceId);
  }

  return sorted.reverse();

  function visit(resourceId) {
    if (visited.has(resourceId)) return;
    if (visiting.has(resourceId)) throw new Error(`dependency cycle at ${resourceId}`);
    visiting.add(resourceId);
    for (const dep of contract.resources.get(resourceId).deps) {
      if (isProvisionedOrCompensating(contract.actors.get(dep).state)) visit(dep);
    }
    visiting.delete(resourceId);
    visited.add(resourceId);
    sorted.push(resourceId);
  }
}

function dependentsOf(contract, resourceId) {
  return [...contract.resources.keys()].filter((id) => contract.resources.get(id).deps.includes(resourceId));
}

function isProvisionedOrCompensating(state) {
  return ["Provisioned", "Failed", "Compensating", "Destroying", "Destroyed"].includes(state);
}

function createReplayState(resources) {
  return {
    actors: new Map([...resources.keys()].map((id) => [id, { state: "Pending", sequence: 0 }])),
    deployed: false,
    rollbackStarted: false,
    seenEventIds: new Set(),
    ignoredEvents: []
  };
}

function applyReplayEvent(state, event) {
  if (state.seenEventIds.has(event.id)) {
    state.ignoredEvents.push({ eventId: event.id, reason: "duplicate-event-id" });
    return;
  }
  state.seenEventIds.add(event.id);

  const resourceId = event.data?.resourceId;
  if (resourceId && state.actors.has(resourceId)) {
    if (event.type === "resource.Pending") state.actors.get(resourceId).state = "Pending";
    if (event.type === "resource.Provisioning") state.actors.get(resourceId).state = "Provisioning";
    if (event.type === "resource.Provisioned") state.actors.get(resourceId).state = "Provisioned";
    if (event.type === "resource.Failed") state.actors.get(resourceId).state = "Failed";
    if (event.type === "resource.Destroying") state.actors.get(resourceId).state = "Destroying";
    if (event.type === "resource.Destroyed") state.actors.get(resourceId).state = "Destroyed";
  }
  if (event.type === "deployment.Deployed") state.deployed = true;
  if (event.type === "deployment.RolledBack") state.rollbackStarted = true;
}

function summarizeReplay(resources, state) {
  const resourceIds = [...resources.keys()].sort();
  return {
    status: state.deployed ? "deployed" : state.rollbackStarted ? "rolled-back" : "waiting",
    actors: resourceIds.map((resourceId) => ({
      resourceId,
      state: state.actors.get(resourceId).state
    })),
    ignoredEvents: [...state.ignoredEvents]
  };
}

function indexResources(plan) {
  if (!plan?.resources?.length) throw new Error("DeploymentPlan resources must be a non-empty array");
  const resources = new Map();
  for (const resource of plan.resources) {
    if (!resource?.id) throw new Error("DeploymentPlan resource id is required");
    if (resources.has(resource.id)) throw new Error(`duplicate resource id ${resource.id}`);
    resources.set(resource.id, { ...clone(resource), deps: [...(resource.deps ?? [])] });
  }
  for (const resource of resources.values()) {
    for (const dep of resource.deps) {
      if (!resources.has(dep)) throw new Error(`resource ${resource.id} depends on missing resource ${dep}`);
    }
  }
  return resources;
}

function deploymentSetId(plan) {
  return plan.setId ?? plan.meta?.setId ?? `${plan.deploymentId}-set`;
}

function maxSeq(events) {
  return events.reduce((max, event) => Math.max(max, Number.isInteger(event.seq) ? event.seq : 0), 0);
}

function defaultIdFactory() {
  let next = 1;
  return (_type, _data, seq) => `evt-${String(seq ?? next++).padStart(4, "0")}`;
}

function clone(value) {
  return structuredClone(value);
}

function finalStateHash(resourceId) {
  return `sha256:${createHash("sha256").update(resourceId).digest("hex")}`;
}

export function fixtureDeploymentPlan(overrides = {}) {
  return {
    apiVersion: "hobo.deployment-plan/v1",
    deploymentId: overrides.deploymentId ?? "deploy-fixture-hobo-620",
    targetSetId: overrides.targetSetId ?? "set-stable-001",
    resources: overrides.resources ?? [
      fixtureResource("network", []),
      fixtureResource("database", ["network"]),
      fixtureResource("api", ["database"])
    ],
    edges: overrides.edges ?? [
      { from: "network", to: "database", reason: "binding-output" },
      { from: "database", to: "api", reason: "binding-output" }
    ],
    meta: { objective: "cost", ...overrides.meta }
  };
}

export function fixtureResource(id, deps = []) {
  return {
    id,
    name: id,
    port: { interface: "hobo:test/resource", type: "service", className: "standard" },
    provider: { id: "test-provider", definitionId: `test-${id}`, driver: "pulumi-mock" },
    context: {
      envType: "ephemeral",
      app: "checkout",
      env: "preview",
      tenant: "tenant-hobo",
      resourceType: "service",
      resourceClass: "standard",
      resourceId: id
    },
    options: {},
    deps,
    strategy: "reconcile",
    replication: "single-region",
    workloadProfile: "managed-resource",
    outputs: ["endpoint"]
  };
}
