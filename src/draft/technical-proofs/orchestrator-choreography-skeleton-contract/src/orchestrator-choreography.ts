const CONTROL_PLANE_SCHEMA_VERSION = 1;

export function createOrchestrator(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory();

  return {
    runDeployment({
      plan,
      correlationId = plan?.deploymentId ?? "corr-orchestrator-contract",
      tenant = plan?.resources?.[0]?.context?.tenant ?? "tenant-hobo",
      actor = { kind: "service", id: "yard/orchestrator" },
      causationId = "cmd-deploy-requested",
      eventLog = [],
      stallResourceIds = []
    }) {
      const resources = indexResources(plan);
      const state = createReplayState(resources);
      const events = eventLog.map(clone);
      const stalled = new Set(stallResourceIds);
      const activationLog = [];
      let nextSeq = maxSeq(events) + 1;
      let wave = 0;
      let lastEventId = causationId;

      for (const event of events) {
        applyEvent(state, event);
        lastEventId = event.id;
      }

      for (const resource of resources.values()) {
        if (!state.pendingResourceIds.has(resource.id)) {
          emit("resource.Pending", {
            resourceId: resource.id,
            deps: [...resource.deps]
          });
        }
      }

      while (true) {
        const ready = [...resources.values()].filter((resource) => isReadyToActivate(state, resource));
        if (ready.length === 0) break;

        for (const resource of ready) {
          activationLog.push({
            resourceId: resource.id,
            wave,
            satisfiedDependencies: [...resource.deps],
            subscribedTo: resource.deps.map((dep) => `resource.Provisioned:${dep}`)
          });

          emit("resource.Provisioning", {
            resourceId: resource.id,
            provider: resource.provider.id,
            driver: resource.provider.driver
          });

          if (!stalled.has(resource.id)) {
            emit("resource.Provisioned", {
              resourceId: resource.id,
              outputs: outputsFor(resource)
            });
          }
        }

        wave += 1;
      }

      const resourceIds = [...resources.keys()].sort();
      if (resourceIds.every((resourceId) => state.provisionedResourceIds.has(resourceId)) && !state.deployed) {
        emit("deployment.Deployed", {
          deploymentId: plan.deploymentId,
          setId: deploymentSetId(plan),
          resourceIds
        });
      }

      return {
        events,
        activationLog,
        state: summarizeState(resources, state)
      };

      function emit(type, data) {
        const event = createControlPlaneEvent(type, data, {
          id: idFactory(type, data, nextSeq),
          seq: nextSeq,
          time: now(),
          tenant,
          actor,
          correlationId,
          causationId: lastEventId
        });
        nextSeq += 1;
        events.push(event);
        applyEvent(state, event);
        lastEventId = event.id;
        return event;
      }
    }
  };
}

export function replayDeployment({ plan, events }) {
  const resources = indexResources(plan);
  const state = createReplayState(resources);
  for (const event of events) {
    applyEvent(state, event);
  }
  return summarizeState(resources, state);
}

export function createControlPlaneEvent(type, data, overrides = {}) {
  return {
    id: overrides.id ?? `evt-${type}-${data.resourceId ?? data.deploymentId ?? "deployment"}`,
    type,
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    tenant: overrides.tenant ?? "tenant-hobo",
    seq: overrides.seq ?? 0,
    time: overrides.time ?? "2026-06-25T00:00:00.000Z",
    actor: overrides.actor ?? { kind: "service", id: "yard/orchestrator" },
    correlationId: overrides.correlationId ?? "corr-orchestrator-contract",
    causationId: overrides.causationId ?? "cmd-deploy-requested",
    data: clone(data)
  };
}

function createReplayState(resources) {
  return {
    resources,
    seenEventIds: new Set(),
    pendingResourceIds: new Set(),
    activatingResourceIds: new Set(),
    provisionedResourceIds: new Set(),
    deployed: false,
    ignoredEvents: []
  };
}

function applyEvent(state, event) {
  if (state.seenEventIds.has(event.id)) {
    state.ignoredEvents.push({ eventId: event.id, reason: "duplicate-event-id" });
    return false;
  }
  state.seenEventIds.add(event.id);

  if (event.type === "resource.Pending") {
    state.pendingResourceIds.add(event.data.resourceId);
    return true;
  }

  if (event.type === "resource.Provisioning") {
    const resourceId = event.data.resourceId;
    if (state.provisionedResourceIds.has(resourceId)) {
      state.ignoredEvents.push({ eventId: event.id, reason: "already-provisioned" });
      return false;
    }
    state.activatingResourceIds.add(resourceId);
    return true;
  }

  if (event.type === "resource.Provisioned") {
    const resourceId = event.data.resourceId;
    if (state.provisionedResourceIds.has(resourceId)) {
      state.ignoredEvents.push({ eventId: event.id, reason: "duplicate-provisioned" });
      return false;
    }
    state.provisionedResourceIds.add(resourceId);
    return true;
  }

  if (event.type === "deployment.Deployed") {
    state.deployed = true;
    return true;
  }

  return false;
}

function isReadyToActivate(state, resource) {
  if (state.provisionedResourceIds.has(resource.id)) return false;
  if (state.activatingResourceIds.has(resource.id)) return false;
  if (resource.deps.some((dep) => !state.provisionedResourceIds.has(dep))) return false;
  return state.pendingResourceIds.has(resource.id);
}

function summarizeState(resources, state) {
  const resourceIds = [...resources.keys()].sort();
  const waitingResourceIds = resourceIds.filter((resourceId) => !state.provisionedResourceIds.has(resourceId));
  const actors = resourceIds.map((resourceId) => {
    const resource = resources.get(resourceId);
    return {
      resourceId,
      deps: [...resource.deps],
      subscriptions: resource.deps.map((dep) => `resource.Provisioned:${dep}`),
      status: state.provisionedResourceIds.has(resourceId)
        ? "provisioned"
        : state.activatingResourceIds.has(resourceId)
          ? "provisioning"
          : "waiting"
    };
  });

  return {
    status: state.deployed ? "deployed" : waitingResourceIds.length === 0 ? "provisioned" : "waiting",
    provisionedResourceIds: resourceIds.filter((resourceId) => state.provisionedResourceIds.has(resourceId)),
    waitingResourceIds,
    actors,
    ignoredEvents: [...state.ignoredEvents]
  };
}

function indexResources(plan) {
  if (!plan || !Array.isArray(plan.resources) || plan.resources.length === 0) {
    throw new Error("DeploymentPlan resources must be a non-empty array");
  }

  const resources = new Map();
  for (const resource of plan.resources) {
    if (!resource?.id) {
      throw new Error("DeploymentPlan resource id is required");
    }
    if (resources.has(resource.id)) {
      throw new Error(`duplicate resource id ${resource.id}`);
    }
    resources.set(resource.id, {
      ...clone(resource),
      deps: [...(resource.deps ?? [])]
    });
  }

  for (const resource of resources.values()) {
    for (const dep of resource.deps) {
      if (!resources.has(dep)) {
        throw new Error(`resource ${resource.id} depends on missing resource ${dep}`);
      }
    }
  }

  return resources;
}

function outputsFor(resource) {
  return Object.fromEntries((resource.outputs ?? []).map((output) => [output, `${resource.id}-output-${output}`]));
}

function deploymentSetId(plan) {
  return plan.setId ?? plan.meta?.setId ?? `${plan.deploymentId}-set`;
}

function maxSeq(events) {
  return events.reduce((max, event) => Math.max(max, Number.isInteger(event.seq) ? event.seq : 0), 0);
}

function defaultIdFactory() {
  let next = 1;
  return () => `evt-${String(next++).padStart(6, "0")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
