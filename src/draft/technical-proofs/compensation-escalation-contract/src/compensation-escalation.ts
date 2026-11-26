export async function runCompensationEscalation({
  deploymentId,
  resources,
  provisioned,
  retryCap = 3,
  retryBudget = Number.POSITIVE_INFINITY,
  deadlineMs = Number.POSITIVE_INFINITY,
  eventLog = [],
  destroy,
  refresh = () => ({ exists: false }),
  notifyEscalation = () => ({ status: "notified" }),
}) {
  const events = eventLog.map(clone);
  const destroyed = new Set(
    events
      .filter((event) => event.type === "compensation.ResourceDestroyed")
      .map((event) => event.resourceId),
  );

  let order;
  try {
    order = reverseTopologicalProvisionedOrder(resources, provisioned);
  } catch {
    return await escalate({
      deploymentId,
      events,
      reason: "compensation-dependency-deadlock",
      orphanInventory: provisioned.map((resourceId) => ({
        resourceId,
        state: "unreclaimed",
        reason: "dependency-cycle",
      })),
      notifyEscalation,
    });
  }

  if (!events.some((event) => event.type === "compensation.Started")) {
    events.push({ type: "compensation.Started", deploymentId, resourceIds: order });
  }

  let retriesScheduled = events.filter((event) => event.type === "compensation.RetryScheduled").length;

  for (const resourceId of order) {
    if (destroyed.has(resourceId)) {
      continue;
    }

    let attempts = 0;
    while (attempts < retryCap) {
      attempts += 1;
      const result = normalizeDestroyResult(await destroy({ resourceId, attempt: attempts }));

      if (result.status === "destroyed") {
        destroyed.add(resourceId);
        events.push({
          type: "compensation.ResourceDestroyed",
          deploymentId,
          resourceId,
          attempt: attempts,
        });
        break;
      }

      const failure = await reconcileDestroyFailure({
        resourceId,
        result,
        deadlineMs,
        refresh,
      });
      if (failure.status === "destroyed") {
        destroyed.add(resourceId);
        events.push({
          type: "compensation.ResourceDestroyed",
          deploymentId,
          resourceId,
          attempt: attempts,
          reconciledBy: "refresh",
        });
        break;
      }

      events.push({
        type: "compensation.DestroyFailed",
        deploymentId,
        resourceId,
        attempt: attempts,
        reason: failure.reason,
      });

      if (attempts >= retryCap) {
        return await escalate({
          deploymentId,
          events,
          reason: "retry-cap-exhausted",
          orphanInventory: buildOrphanInventory({ order, failedResourceId: resourceId, reason: failure.reason }),
          notifyEscalation,
        });
      }

      if (retriesScheduled >= retryBudget) {
        return await escalate({
          deploymentId,
          events,
          reason: "retry-budget-exhausted",
          orphanInventory: buildOrphanInventory({ order, failedResourceId: resourceId, reason: failure.reason }),
          notifyEscalation,
        });
      }

      retriesScheduled += 1;
      events.push({
        type: "compensation.RetryScheduled",
        deploymentId,
        resourceId,
        nextAttempt: attempts + 1,
      });
    }
  }

  return {
    status: "rolled-back",
    events,
    orphanInventory: [],
  };
}

async function reconcileDestroyFailure({ resourceId, result, deadlineMs, refresh }) {
  if (result.status === "timeout" || result.elapsedMs > deadlineMs) {
    return { reason: result.reason ?? "deadline-exceeded" };
  }

  if (result.status === "ambiguous") {
    const observed = await refresh({ resourceId });
    if (observed.exists) {
      return { reason: observed.reason ?? "provider-object-still-present" };
    }
    return { status: "destroyed" };
  }

  return { reason: result.reason ?? result.status };
}

function buildOrphanInventory({ order, failedResourceId, reason }) {
  const failedIndex = order.indexOf(failedResourceId);
  return order.slice(failedIndex).map((resourceId, index, blocked) => {
    if (resourceId === failedResourceId) {
      return { resourceId, state: "unreclaimed", reason };
    }

    const previous = blocked[index - 1];
    return { resourceId, state: "blocked-by-dependent", reason: previous };
  });
}

async function escalate({ deploymentId, events, reason, orphanInventory, notifyEscalation }) {
  const escalation = { reason, orphanInventory };
  events.push({ type: "compensation.EscalationPersisted", deploymentId, escalation });

  let notified = await notifyEscalation({ deploymentId, escalation });
  if (notified?.status === "failed") {
    events.push({
      type: "compensation.EscalationNotifyFailed",
      deploymentId,
      reason: notified.reason,
    });
    notified = await notifyEscalation({ deploymentId, escalation });
  }

  events.push({
    type: "compensation.Escalated",
    deploymentId,
    notified: notified?.status === "notified",
    escalation,
  });

  return {
    status: "needs-human",
    escalation,
    events,
    orphanInventory,
  };
}

function reverseTopologicalProvisionedOrder(resources, provisioned) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const wanted = new Set(provisioned);
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();

  for (const id of provisioned) {
    visit(id);
  }

  return sorted.filter((id) => wanted.has(id)).reverse();

  function visit(id) {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`compensation dependency deadlock: ${id}`);
    }

    const resource = byId.get(id);
    if (!resource) {
      throw new Error(`unknown resource: ${id}`);
    }

    visiting.add(id);
    for (const dependency of resource.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }
}

function normalizeDestroyResult(result) {
  return result ?? { status: "destroyed" };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
