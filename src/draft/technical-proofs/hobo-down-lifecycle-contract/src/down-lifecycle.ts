import { randomUUID } from "node:crypto";

const LIVE_RESOURCE_STATES = new Set([
  "Pending",
  "Planning",
  "Provisioning",
  "Provisioned",
  "Updating",
  "Destroying",
  "Compensating",
]);

export class DownLifecycleError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DownLifecycleError";
    this.code = code;
    this.details = details;
  }
}

export function createDownLifecycle({
  now = () => new Date().toISOString(),
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
} = {}) {
  return {
    async run({
      topology,
      campId,
      eventLog = [],
      appendEvent,
      destroyResource = async () => ({}),
      approval = null,
      confirm = false,
    }) {
      assertRequired({ topology, campId });

      const camp = findCamp(topology, campId);
      assertDestroyApproved(camp, approval, confirm);

      const replay = replayDownEvents(eventLog, topology.deploymentId, campId);
      const targetResources = resourcesForCamp(topology, campId);
      assertNoLiveExternalDependents(topology, campId, replay.destroyedResourceIds);

      const pendingResources = reverseDependencyOrder(targetResources)
        .filter((resource) => isLiveResource(resource))
        .filter((resource) => !replay.destroyedResourceIds.has(resource.id));

      const newEvents = [];
      let lastEventId = eventLog.at(-1)?.id ?? `command:down:${topology.deploymentId}:${campId}`;
      let nextSeq = nextSequence(eventLog);
      const correlationId = `down:${topology.deploymentId}:${campId}`;

      const emit = async (type, data = {}) => {
        const event = makeDownEvent({
          id: idFactory("down-event"),
          type,
          seq: nextSeq,
          time: now(),
          tenantId: topology.tenantId,
          deploymentId: topology.deploymentId,
          campId,
          correlationId,
          causationId: lastEventId,
          data,
        });
        nextSeq += 1;

        const appendResult = appendEvent ? await appendEvent(event) : { appended: true };
        if (appendResult?.appended === false) {
          throw new DownLifecycleError(
            `Could not append ${type}: ${appendResult.reason ?? "append rejected"}`,
            "append-rejected",
            { eventType: type, reason: appendResult.reason },
          );
        }

        newEvents.push(event);
        lastEventId = event.id;
        return event;
      };

      await emit("deployment.DownStarted", {
        approval: approval ?? (confirm ? { decision: "confirmed" } : null),
        resourceCount: pendingResources.length,
      });

      if (pendingResources.length === 0) {
        await emit("deployment.DownNoop", {
          reason: targetResources.length === 0 ? "empty-camp" : "already-destroyed",
        });
        return result("noop", newEvents, [], []);
      }

      const removedResources = [];

      for (const resource of pendingResources) {
        await emit("resource.DestroyRequested", {
          resourceId: resource.id,
          dependsOn: [...(resource.deps ?? [])],
        });

        try {
          const destroyResult = await destroyResource(clone(resource), {
            topology: clone(topology),
            camp: clone(camp),
            correlationId,
          });

          await emit("resource.Destroyed", {
            resourceId: resource.id,
            providerId: destroyResult?.providerId ?? null,
            externalId: destroyResult?.externalId ?? null,
          });
          removedResources.push(resource);
        } catch (error) {
          await emit("resource.DestroyFailed", {
            resourceId: resource.id,
            message: error instanceof Error ? error.message : "unknown destroy failure",
            remainingResourceIds: pendingResources
              .slice(pendingResources.indexOf(resource))
              .map((pending) => pending.id),
          });

          return result(
            "partial",
            newEvents,
            removedResources,
            pendingResources.slice(pendingResources.indexOf(resource)),
          );
        }
      }

      await emit("deployment.DownCompleted", {
        removedResourceIds: removedResources.map((resource) => resource.id),
      });

      return result("destroyed", newEvents, removedResources, []);
    },
  };
}

export function replayDownEvents(events, deploymentId, campId) {
  const destroyedResourceIds = new Set();
  const failedResources = [];

  for (const event of events) {
    if (event.deploymentId !== deploymentId || event.campId !== campId) {
      continue;
    }

    if (event.type === "resource.Destroyed") {
      destroyedResourceIds.add(event.data.resourceId);
    }

    if (event.type === "resource.DestroyFailed") {
      failedResources.push({
        resourceId: event.data.resourceId,
        message: event.data.message,
      });
    }
  }

  return { destroyedResourceIds, failedResources };
}

export function reverseDependencyOrder(resources) {
  const byId = new Map(resources.map((resource, index) => [resource.id, { resource, index }]));
  const visiting = new Set();
  const visited = new Set();
  const depths = new Map();

  const depth = (resource) => {
    if (depths.has(resource.id)) {
      return depths.get(resource.id);
    }
    if (visiting.has(resource.id)) {
      throw new DownLifecycleError(
        `Cannot compute destroy order: dependency cycle includes ${resource.id}.`,
        "dependency-cycle",
        { resourceId: resource.id },
      );
    }
    visiting.add(resource.id);

    const dependencyDepths = (resource.deps ?? [])
      .filter((dependencyId) => byId.has(dependencyId))
      .map((dependencyId) => depth(byId.get(dependencyId).resource));
    const value = dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths) + 1;

    visiting.delete(resource.id);
    visited.add(resource.id);
    depths.set(resource.id, value);
    return value;
  };

  for (const resource of resources) {
    if (!visited.has(resource.id)) {
      depth(resource);
    }
  }

  return [...resources].sort((left, right) => {
    const byDepth = depths.get(right.id) - depths.get(left.id);
    if (byDepth !== 0) {
      return byDepth;
    }
    return byId.get(left.id).index - byId.get(right.id).index;
  });
}

export function makeDownEvent({
  id,
  type,
  seq,
  time,
  tenantId,
  deploymentId,
  campId,
  correlationId,
  causationId,
  data = {},
}) {
  assertRequired({
    id,
    type,
    seq,
    time,
    tenantId,
    deploymentId,
    campId,
    correlationId,
    causationId,
  });

  return {
    id,
    type,
    schemaVersion: 1,
    seq,
    time,
    tenantId,
    deploymentId,
    campId,
    correlationId,
    causationId,
    data: clone(data),
  };
}

function findCamp(topology, campId) {
  const camp = topology.camps?.find((candidate) => candidate.id === campId);
  if (!camp) {
    throw new DownLifecycleError(
      `Unknown Camp "${campId}" for deployment ${topology.deploymentId}.`,
      "unknown-camp",
      { campId },
    );
  }
  return camp;
}

function assertDestroyApproved(camp, approval, confirm) {
  const prodTyped = camp.environmentType === "production" || camp.id === "prod";
  if (!prodTyped) {
    return;
  }

  if (confirm === true || approval?.decision === "approved") {
    return;
  }

  throw new DownLifecycleError(
    `Approval required before destroying production Camp "${camp.id}".`,
    "approval-required",
    { campId: camp.id, environmentType: camp.environmentType },
  );
}

function assertNoLiveExternalDependents(topology, campId, destroyedResourceIds) {
  const targetIds = new Set(resourcesForCamp(topology, campId).map((resource) => resource.id));
  const externalLiveResources = (topology.resources ?? []).filter(
    (resource) => resource.campId !== campId && isLiveResource(resource),
  );

  for (const resource of externalLiveResources) {
    for (const dependencyId of resource.deps ?? []) {
      if (targetIds.has(dependencyId) && !destroyedResourceIds.has(resource.id)) {
        throw new DownLifecycleError(
          `Refusing hobo down --camp ${campId}: ${resource.id} in Camp ${resource.campId} still depends on ${dependencyId}.`,
          "live-external-dependent",
          {
            campId,
            resourceId: dependencyId,
            dependentResourceId: resource.id,
            dependentCampId: resource.campId,
          },
        );
      }
    }
  }
}

function resourcesForCamp(topology, campId) {
  return (topology.resources ?? []).filter((resource) => resource.campId === campId);
}

function isLiveResource(resource) {
  return LIVE_RESOURCE_STATES.has(resource.state ?? "Provisioned");
}

function nextSequence(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
}

function result(status, events, removedResources, pendingResources) {
  return {
    ok: status !== "partial",
    status,
    events,
    removedResources: removedResources.map(publicResource),
    pendingResources: pendingResources.map(publicResource),
    json: {
      status,
      removedResources: removedResources.map((resource) => resource.id),
      pendingResources: pendingResources.map((resource) => resource.id),
      events: events.map((event) => ({
        type: event.type,
        resourceId: event.data.resourceId ?? null,
      })),
    },
  };
}

function publicResource(resource) {
  return {
    id: resource.id,
    campId: resource.campId,
    deps: [...(resource.deps ?? [])],
  };
}

function assertRequired(fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      throw new DownLifecycleError(`Missing required down lifecycle field: ${field}`, "missing-field", {
        field,
      });
    }
  }
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}
