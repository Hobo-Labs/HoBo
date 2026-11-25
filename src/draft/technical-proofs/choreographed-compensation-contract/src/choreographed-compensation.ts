export function runChoreographedCompensation({
  plan,
  eventLog = [],
  failure,
  stuckResources = [],
  destroyResults = {},
  crashAfterEvents = []
}) {
  const contract = createContract(plan, eventLog);
  const stuck = new Set(stuckResources);
  const crashAfter = new Set(crashAfterEvents);

  if (failure) {
    applyAndRecord(contract, structuredClone(failure));
  }

  const triggeringFailure = firstNoGoFailure(contract.events);
  if (!contract.rollbackStarted && triggeringFailure) {
    const rollback = emit(contract, "deployment.RolledBack", {
      deploymentId: contract.plan.deploymentId,
      targetSetId: contract.plan.targetSetId,
      reason: `resource ${triggeringFailure.data.resourceId} crossed no-go threshold`
    });
    markRollbackDesiredDestroyed(contract);
    if (crashAfter.has(rollback.type)) {
      return summarize(contract, "interrupted");
    }
  }

  if (!contract.rollbackStarted) {
    return summarize(contract, "no-rollback");
  }

  markRollbackDesiredDestroyed(contract);
  const blocked = [];
  for (const resourceId of reverseTopologicalProvisionedOrder(contract)) {
    if (contract.resources[resourceId].status === "Destroyed") {
      continue;
    }

    const liveDependents = dependentsOf(contract, resourceId)
      .filter((dependentId) => isProvisionedForRollback(contract, dependentId))
      .filter((dependentId) => contract.resources[dependentId].status !== "Destroyed");
    if (liveDependents.length > 0) {
      blocked.push({
        resourceId,
        reason: "waiting-for-dependent-destroyed",
        dependents: liveDependents
      });
      continue;
    }

    emit(contract, "resource.Destroying", { resourceId });
    if (stuck.has(resourceId)) {
      continue;
    }

    const result = destroyResults[resourceId] ?? { status: "destroyed" };
    if (result.status === "failed") {
      emit(contract, "resource.CompensationFailed", {
        resourceId,
        reason: result.reason ?? "destroy-failed"
      });
      emit(contract, "incident.EscalationRequested", {
        deploymentId: contract.plan.deploymentId,
        reason: "compensation-failed",
        resourceId
      });
      return summarize(contract, "needs-human");
    }
    emit(contract, "resource.Destroyed", { resourceId });
  }

  if (blocked.length > 0) {
    return {
      ...summarize(contract, "blocked"),
      blocked
    };
  }

  return summarize(contract, "rolled-back");
}

export function resumeChoreographedCompensation({ plan, eventLog = [] }) {
  return runChoreographedCompensation({ plan, eventLog });
}

function createContract(plan, eventLog) {
  assertPlan(plan);
  const resources = Object.fromEntries(
    plan.resources.map((resource) => [
      resource.id,
      {
        deps: [...(resource.deps ?? [])],
        desired: "Present",
        status: "Pending"
      }
    ])
  );
  const contract = {
    plan: {
      deploymentId: plan.deploymentId,
      targetSetId: plan.targetSetId ?? `${plan.deploymentId}-previous-set`
    },
    resourceOrder: plan.resources.map((resource) => resource.id),
    resources,
    events: [],
    rollbackStarted: false,
    nextSeq: 1
  };

  for (const event of eventLog) {
    applyAndRecord(contract, structuredClone(event));
  }

  return contract;
}

function applyAndRecord(contract, event) {
  contract.events.push(event);
  contract.nextSeq = Math.max(contract.nextSeq, (event.seq ?? 0) + 1);
  applyEvent(contract, event);
}

function applyEvent(contract, event) {
  if (event.type === "resource.Provisioned") {
    contract.resources[event.data.resourceId].status = "Provisioned";
    return;
  }
  if (event.type === "resource.Failed") {
    const resource = contract.resources[event.data.resourceId];
    resource.status = resource.status === "Provisioned" ? "Failed" : "FailedBeforeProvisioned";
    return;
  }
  if (event.type === "deployment.RolledBack") {
    contract.rollbackStarted = true;
    markRollbackDesiredDestroyed(contract);
    return;
  }
  if (event.type === "resource.Destroying") {
    contract.resources[event.data.resourceId].status = "Destroying";
    return;
  }
  if (event.type === "resource.Destroyed") {
    contract.resources[event.data.resourceId].status = "Destroyed";
    return;
  }
  if (event.type === "resource.CompensationFailed") {
    contract.resources[event.data.resourceId].status = "CompensationFailed";
  }
}

function emit(contract, type, data) {
  const event = {
    id: `evt-${String(contract.nextSeq).padStart(4, "0")}`,
    type,
    seq: contract.nextSeq,
    data: structuredClone(data)
  };
  contract.nextSeq += 1;
  applyAndRecord(contract, event);
  return event;
}

function markRollbackDesiredDestroyed(contract) {
  for (const resourceId of Object.keys(contract.resources)) {
    if (isProvisionedForRollback(contract, resourceId)) {
      contract.resources[resourceId].desired = "Destroyed";
    }
  }
}

function firstNoGoFailure(events) {
  return events.find((event) => event.type === "resource.Failed" && event.data?.crossedNoGoThreshold);
}

function reverseTopologicalProvisionedOrder(contract) {
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();

  for (const resourceId of contract.resourceOrder) {
    if (isProvisionedForRollback(contract, resourceId)) {
      visit(resourceId);
    }
  }

  return sorted.reverse();

  function visit(resourceId) {
    if (visited.has(resourceId)) return;
    if (visiting.has(resourceId)) {
      throw new Error(`dependency cycle at ${resourceId}`);
    }
    visiting.add(resourceId);
    for (const dep of contract.resources[resourceId].deps) {
      if (isProvisionedForRollback(contract, dep)) {
        visit(dep);
      }
    }
    visiting.delete(resourceId);
    visited.add(resourceId);
    sorted.push(resourceId);
  }
}

function dependentsOf(contract, resourceId) {
  return contract.resourceOrder.filter((candidateId) => contract.resources[candidateId].deps.includes(resourceId));
}

function isProvisionedForRollback(contract, resourceId) {
  return ["Provisioned", "Failed", "Destroying", "CompensationFailed", "Destroyed"].includes(
    contract.resources[resourceId]?.status
  );
}

function summarize(contract, status) {
  return {
    status,
    events: contract.events.map((event) => structuredClone(event)),
    state: {
      resources: structuredClone(contract.resources)
    }
  };
}

function assertPlan(plan) {
  if (!plan?.deploymentId) {
    throw new Error("plan.deploymentId is required");
  }
  if (!Array.isArray(plan.resources) || plan.resources.length === 0) {
    throw new Error("plan.resources must be a non-empty array");
  }
  const ids = new Set();
  for (const resource of plan.resources) {
    if (!resource?.id) {
      throw new Error("resource.id is required");
    }
    if (ids.has(resource.id)) {
      throw new Error(`duplicate resource id ${resource.id}`);
    }
    ids.add(resource.id);
  }
  for (const resource of plan.resources) {
    for (const dep of resource.deps ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`resource ${resource.id} depends on missing resource ${dep}`);
      }
    }
  }
}
