import { randomUUID } from "node:crypto";

const TERMINAL_STATUSES = new Set(["rolled-back", "continued-after-optional-failure"]);
const DEFAULT_NO_GO_THRESHOLD = Object.freeze({ kind: "any-fatal" });

export function createCompensationEngine({
  now = () => new Date().toISOString(),
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
} = {}) {
  return {
    async compensate({
      deploymentId,
      tenantId,
      correlationId,
      resources = [],
      eventLog = [],
      failedResourceId,
      failure,
      noGoThreshold = DEFAULT_NO_GO_THRESHOLD,
      refresh = async () => ({ exists: true }),
      destroy = async () => ({ destroyed: true }),
    }) {
      assertRequired({ deploymentId, tenantId, correlationId, failedResourceId });
      const graph = buildResourceGraph(resources);
      const failedResource = graph.resourceMap.get(failedResourceId);
      if (!failedResource) {
        throw new Error(`Unknown failed resource: ${failedResourceId}`);
      }

      const workingLog = eventLog.map(clone);
      let state = replayCompensationEvents(workingLog, resources).state;
      let lastAcceptedEventId = workingLog.at(-1)?.id ?? `command:${deploymentId}`;
      let nextSequence = nextEventSequence(workingLog);

      const append = (type, data = {}, resourceId) => {
        const event = {
          id: idFactory(type),
          type,
          schemaVersion: 1,
          seq: nextSequence,
          time: now(),
          deploymentId,
          tenantId,
          correlationId,
          causationId: lastAcceptedEventId,
          resourceId,
          data: clone(data),
        };
        nextSequence += 1;
        workingLog.push(event);
        lastAcceptedEventId = event.id;
        state = replayCompensationEvents(workingLog, resources).state;
        return event;
      };

      if (failedResource.optional) {
        if (state.status !== "continued-after-optional-failure") {
          append("deployment.OptionalResourceFailed", {
            failedResourceId,
            failureClass: failure?.class ?? state.failure?.failureClass ?? "unknown",
            reason: failure?.reason ?? state.failure?.reason ?? "optional-resource-failed",
          });
        }
        return finish(workingLog, resources);
      }

      if (TERMINAL_STATUSES.has(state.status)) {
        return finish(workingLog, resources);
      }

      if (!state.rollback) {
        append("deployment.RolledBack", {
          reason: {
            failedResourceId,
            failureClass: failure?.class ?? state.failure?.failureClass ?? "unknown",
            reason: failure?.reason ?? state.failure?.reason ?? "no-go-threshold-crossed",
            noGoThreshold,
          },
          provisionedSet: state.provisionedResourceIds,
        });
      }

      const compensationOrder = graph.topologicalOrder
        .filter((resourceId) => state.provisionedResourceIds.includes(resourceId))
        .reverse();

      for (const resourceId of compensationOrder) {
        state = replayCompensationEvents(workingLog, resources).state;
        if (!state.provisionedResourceIds.includes(resourceId)) {
          continue;
        }

        const resource = graph.resourceMap.get(resourceId);
        const idempotencyKey = `${deploymentId}:compensate:${resourceId}`;

        append("resource.Compensating", { idempotencyKey }, resourceId);

        if (resource.ambiguousCommit) {
          const refreshResult = await refresh({ deploymentId, tenantId, resourceId, idempotencyKey });
          append("resource.RefreshedBeforeCompensation", { idempotencyKey, result: refreshResult }, resourceId);
          if (refreshResult?.exists === false) {
            append(
              "resource.Compensated",
              {
                idempotencyKey,
                skippedProviderDestroy: true,
                reason: "refresh-reported-absent",
              },
              resourceId,
            );
            continue;
          }
        }

        const destroyResult = await destroy({ deploymentId, tenantId, resourceId, idempotencyKey });
        append("resource.Compensated", { idempotencyKey, result: destroyResult }, resourceId);
      }

      return finish(workingLog, resources);
    },
  };
}

export function replayCompensationEvents(events, resources = []) {
  const graph = resources.length > 0 ? buildResourceGraph(resources) : undefined;
  const provisioned = new Set();
  const compensated = new Set();
  const compensationOrder = [];
  const ignoredEvents = [];
  let rollback;
  let optionalFailure;
  let failure;

  for (const event of events) {
    switch (event.type) {
      case "resource.Provisioned": {
        const resourceId = event.resourceId ?? event.data?.resourceId;
        provisioned.add(resourceId);
        compensated.delete(resourceId);
        break;
      }
      case "resource.Failed": {
        failure = {
          resourceId: event.resourceId ?? event.data?.resourceId,
          failureClass: event.data?.failureClass,
          reason: event.data?.reason,
        };
        break;
      }
      case "deployment.RolledBack": {
        rollback = clone(event.data);
        break;
      }
      case "deployment.OptionalResourceFailed": {
        optionalFailure = clone(event.data);
        break;
      }
      case "resource.Compensated": {
        const resourceId = event.resourceId ?? event.data?.resourceId;
        provisioned.delete(resourceId);
        compensated.add(resourceId);
        compensationOrder.push(resourceId);
        break;
      }
      case "resource.Compensating":
      case "resource.RefreshedBeforeCompensation": {
        break;
      }
      default: {
        ignoredEvents.push({ event: clone(event), reason: "unknown-compensation-event" });
      }
    }
  }

  const orderedProvisioned = graph
    ? graph.topologicalOrder.filter((resourceId) => provisioned.has(resourceId))
    : [...provisioned];

  let status = "new";
  if (optionalFailure) {
    status = "continued-after-optional-failure";
  } else if (rollback && orderedProvisioned.length === 0) {
    status = "rolled-back";
  } else if (rollback) {
    status = "rolling-back";
  } else if (failure) {
    status = "failed";
  } else if (orderedProvisioned.length > 0) {
    status = "provisioning";
  }

  return {
    state: {
      status,
      provisionedResourceIds: orderedProvisioned,
      compensatedResourceIds: [...compensated],
      compensationOrder,
      rollback,
      optionalFailure,
      failure,
    },
    ignoredEvents,
  };
}

function finish(events, resources) {
  const replay = replayCompensationEvents(events, resources);
  return {
    state: replay.state,
    events: events.map(clone),
    ignoredEvents: replay.ignoredEvents,
  };
}

function buildResourceGraph(resources) {
  const resourceMap = new Map();
  for (const resource of resources) {
    if (!resource?.id) {
      throw new Error("Resource graph entry requires id");
    }
    if (resourceMap.has(resource.id)) {
      throw new Error(`Duplicate resource id: ${resource.id}`);
    }
    resourceMap.set(resource.id, {
      ...resource,
      dependsOn: [...(resource.dependsOn ?? [])],
    });
  }

  for (const resource of resourceMap.values()) {
    for (const dependency of resource.dependsOn) {
      if (!resourceMap.has(dependency)) {
        throw new Error(`Unknown dependency ${dependency} for ${resource.id}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const topologicalOrder = [];

  const visit = (resourceId, path = []) => {
    if (visiting.has(resourceId)) {
      throw new Error(`Cyclic resource graph: ${[...path, resourceId].join(" -> ")}`);
    }
    if (visited.has(resourceId)) {
      return;
    }

    visiting.add(resourceId);
    const resource = resourceMap.get(resourceId);
    for (const dependency of resource.dependsOn) {
      visit(dependency, [...path, resourceId]);
    }
    visiting.delete(resourceId);
    visited.add(resourceId);
    topologicalOrder.push(resourceId);
  };

  for (const resourceId of resourceMap.keys()) {
    visit(resourceId);
  }

  return {
    resourceMap,
    topologicalOrder,
  };
}

function assertRequired(fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required compensation field: ${field}`);
    }
  }
}

function nextEventSequence(events) {
  const maxSequence = events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
  return maxSequence + 1;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }

  return structuredClone(value);
}
