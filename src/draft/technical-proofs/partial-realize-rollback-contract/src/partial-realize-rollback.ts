export function createPartialRealizeHarness() {
  const harness = {
    inventory: new Map(),
    records: new Map(),
    desired: new Map(),
    createAttempts: new Map(),
    events: [],
    nextSeq: 1,
    createAttemptsFor(logicalName) {
      return this.createAttempts.get(logicalName) ?? 0;
    },
  };

  return harness;
}

export function applyDeployment({ harness, plan, fault = {} }) {
  assertHarness(harness);
  assertPlan(plan);

  for (const resource of plan.resources) {
    const key = stateKey(plan, resource.id);
    harness.desired.set(key, "Present");

    const recorded = harness.records.get(key);
    if (recorded && harness.inventory.has(recorded.physicalId)) {
      continue;
    }

    const orphan = liveObjectsForResource(harness, plan, resource.id).find(
      (candidate) => !isRecorded(harness, plan, resource.id, candidate.physicalId),
    );
    if (orphan) {
      recordState(harness, plan, resource.id, orphan);
      emit(harness, "exec.AmbiguousResolved", {
        resourceId: resource.id,
        physicalId: orphan.physicalId,
        rule: "adopt-tagged-live-object-before-retry",
      });
      emit(harness, "iac.StateRecorded", stateRecordEvent(plan, resource.id, orphan));
      emit(harness, "resource.Provisioned", { resourceId: resource.id });
      continue;
    }

    const created = createProviderObject(harness, plan, resource.id);
    emit(harness, "iac.ProviderResourceCreated", providerObjectEvent(created));

    if (fault.severOutputAfterCreateFor === resource.id) {
      emit(harness, "exec.Ambiguous", {
        resourceId: resource.id,
        physicalId: created.physicalId,
        reason: "output-stream-severed-after-create",
      });
      return summarize(harness, plan, "ambiguous");
    }

    if (fault.crashBeforeStateWriteFor === resource.id) {
      emit(harness, "exec.Failed", {
        resourceId: resource.id,
        physicalId: created.physicalId,
        classification: "retryable",
        code: "state-write-interrupted",
      });
      return summarize(harness, plan, "failed");
    }

    recordState(harness, plan, resource.id, created);
    emit(harness, "iac.StateRecorded", stateRecordEvent(plan, resource.id, created));

    if (fault.stateRecordedButObjectMissingFor === resource.id) {
      harness.inventory.delete(created.physicalId);
      emit(harness, "exec.Failed", {
        resourceId: resource.id,
        physicalId: created.physicalId,
        classification: "fatal",
        code: "create-absent-after-state-write",
      });
      return summarize(harness, plan, "failed");
    }

    emit(harness, "resource.Provisioned", { resourceId: resource.id });
  }

  return summarize(harness, plan, "applied");
}

export function rollbackDeployment({
  harness,
  plan,
  destroyFaults = {},
  crashAfterEvent,
}) {
  assertHarness(harness);
  assertPlan(plan);

  if (!hasRollbackEvent(harness, plan)) {
    const rollback = emit(harness, "deployment.RolledBack", {
      deploymentId: plan.deploymentId,
      reason: "partial-realize-no-go-threshold",
    });
    markDestroyedDesired(harness, plan);
    if (crashAfterEvent === rollback.type) {
      return summarize(harness, plan, "interrupted");
    }
  } else {
    markDestroyedDesired(harness, plan);
  }

  let failed = false;

  for (const resource of reverseTopologicalOrder(plan)) {
    const target = compensationTarget(harness, plan, resource.id);
    if (!target) {
      continue;
    }

    const liveDependents = dependentsOf(plan, resource.id).filter((dependentId) =>
      hasCompensationTarget(harness, plan, dependentId),
    );
    if (liveDependents.length > 0) {
      emit(harness, "resource.CompensationBlocked", {
        resourceId: resource.id,
        reason: "waiting-for-dependent-destroyed",
        dependents: liveDependents,
      });
      continue;
    }

    if (target.source === "recorded-state-absent") {
      emit(harness, "iac.RecordedStateAbsent", {
        resourceId: resource.id,
        reason: "state-recorded-but-create-absent",
      });
      harness.records.delete(stateKey(plan, resource.id));
      emit(harness, "resource.Destroyed", {
        resourceId: resource.id,
        source: "recorded-state-absent",
      });
      continue;
    }

    if (destroyFaults[resource.id]) {
      failed = true;
      emit(harness, "resource.CompensationFailed", {
        resourceId: resource.id,
        reason: destroyFaults[resource.id],
        source: target.source,
      });
      emit(harness, "incident.EscalationRequested", {
        deploymentId: plan.deploymentId,
        reason: "compensation-failed",
        resourceId: resource.id,
      });
      continue;
    }

    emit(harness, "resource.Destroying", {
      resourceId: resource.id,
      source: target.source,
    });
    harness.inventory.delete(target.physicalId);
    harness.records.delete(stateKey(plan, resource.id));
    emit(harness, "iac.ResourceDestroyed", {
      resourceId: resource.id,
      physicalId: target.physicalId,
      source: target.source,
    });
    if (target.source === "orphan-sweep") {
      emit(harness, "drift.OrphanSwept", {
        resourceId: resource.id,
        physicalId: target.physicalId,
      });
    }
    emit(harness, "resource.Destroyed", {
      resourceId: resource.id,
      source: target.source,
    });
  }

  return summarize(harness, plan, failed ? "needs-human" : "rolled-back");
}

export function resumePartialRollback({ plan, eventLog = [] }) {
  assertPlan(plan);
  const harness = createPartialRealizeHarness();
  for (const event of eventLog) {
    replayEvent(harness, plan, structuredClone(event));
  }
  const result = rollbackDeployment({ harness, plan });
  return { ...result, harness };
}

export function inspectDeployment(harness, plan) {
  assertHarness(harness);
  assertPlan(plan);

  const scope = scopeKey(plan);
  const live = [...harness.inventory.values()]
    .filter((item) => item.scope === scope)
    .sort(byPlanOrder(plan));
  const records = plan.resources
    .map((resource) => harness.records.get(stateKey(plan, resource.id)))
    .filter(Boolean);
  const recordedPhysicalIds = new Set(records.map((record) => record.physicalId));
  const recorded = records
    .map((record) => harness.inventory.get(record.physicalId))
    .filter(Boolean)
    .sort(byPlanOrder(plan));
  const orphans = live
    .filter((item) => !recordedPhysicalIds.has(item.physicalId))
    .sort(byPlanOrder(plan));

  return {
    live: live.map(publicObject),
    recorded: recorded.map(publicObject),
    orphans: orphans.map(publicObject),
    residue: live.map(publicObject),
  };
}

function createProviderObject(harness, plan, logicalName) {
  harness.createAttempts.set(
    logicalName,
    (harness.createAttempts.get(logicalName) ?? 0) + 1,
  );
  const physicalId = `phys-${slug(logicalName)}-${String(harness.nextSeq).padStart(4, "0")}`;
  const object = {
    scope: scopeKey(plan),
    tenantId: plan.tenantId,
    deploymentId: plan.deploymentId,
    logicalName,
    physicalId,
    tags: providerTags(plan, logicalName),
  };
  harness.inventory.set(physicalId, object);
  return object;
}

function recordState(harness, plan, logicalName, object) {
  harness.records.set(stateKey(plan, logicalName), {
    tenantId: plan.tenantId,
    deploymentId: plan.deploymentId,
    logicalName,
    physicalId: object.physicalId,
    tags: { ...object.tags },
  });
}

function compensationTarget(harness, plan, logicalName) {
  const key = stateKey(plan, logicalName);
  const record = harness.records.get(key);
  if (record) {
    if (harness.inventory.has(record.physicalId)) {
      return {
        source: "recorded-state",
        physicalId: record.physicalId,
      };
    }
    return { source: "recorded-state-absent" };
  }

  const orphan = liveObjectsForResource(harness, plan, logicalName).find(
    (candidate) => !isAlreadyDestroyed(harness, candidate.physicalId),
  );
  if (!orphan) {
    return null;
  }
  return {
    source: "orphan-sweep",
    physicalId: orphan.physicalId,
  };
}

function hasCompensationTarget(harness, plan, logicalName) {
  return compensationTarget(harness, plan, logicalName) !== null;
}

function dependentsOf(plan, logicalName) {
  return plan.resources
    .filter((resource) => (resource.deps ?? []).includes(logicalName))
    .map((resource) => resource.id);
}

function liveObjectsForResource(harness, plan, logicalName) {
  const scope = scopeKey(plan);
  return [...harness.inventory.values()].filter(
    (item) => item.scope === scope && item.logicalName === logicalName,
  );
}

function isRecorded(harness, plan, logicalName, physicalId) {
  return harness.records.get(stateKey(plan, logicalName))?.physicalId === physicalId;
}

function hasRollbackEvent(harness, plan) {
  return harness.events.some(
    (event) =>
      event.type === "deployment.RolledBack" &&
      event.data?.deploymentId === plan.deploymentId,
  );
}

function markDestroyedDesired(harness, plan) {
  for (const resource of plan.resources) {
    harness.desired.set(stateKey(plan, resource.id), "Destroyed");
  }
}

function reverseTopologicalOrder(plan) {
  const byId = new Map(plan.resources.map((resource) => [resource.id, resource]));
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();

  for (const resource of plan.resources) {
    visit(resource.id);
  }

  return sorted.reverse();

  function visit(resourceId) {
    if (visited.has(resourceId)) {
      return;
    }
    if (visiting.has(resourceId)) {
      throw new Error(`dependency cycle at ${resourceId}`);
    }
    const resource = byId.get(resourceId);
    if (!resource) {
      throw new Error(`unknown resource ${resourceId}`);
    }
    visiting.add(resourceId);
    for (const dep of resource.deps ?? []) {
      visit(dep);
    }
    visiting.delete(resourceId);
    visited.add(resourceId);
    sorted.push(resource);
  }
}

function replayEvent(harness, plan, event) {
  harness.events.push(event);
  harness.nextSeq = Math.max(harness.nextSeq, (event.seq ?? 0) + 1);

  if (event.type === "iac.ProviderResourceCreated") {
    const object = {
      scope: `${event.data.tenantId}/${event.data.deploymentId}`,
      tenantId: event.data.tenantId,
      deploymentId: event.data.deploymentId,
      logicalName: event.data.resourceId,
      physicalId: event.data.physicalId,
      tags: { ...event.data.tags },
    };
    harness.inventory.set(object.physicalId, object);
    return;
  }

  if (event.type === "iac.StateRecorded") {
    const object = {
      physicalId: event.data.physicalId,
      tags: { ...event.data.tags },
    };
    recordState(
      harness,
      {
        tenantId: event.data.tenantId,
        deploymentId: event.data.deploymentId,
      },
      event.data.resourceId,
      object,
    );
    return;
  }

  if (event.type === "deployment.RolledBack") {
    markDestroyedDesired(harness, plan);
    return;
  }

  if (
    event.type === "iac.ResourceDestroyed" ||
    event.type === "drift.OrphanSwept"
  ) {
    harness.inventory.delete(event.data.physicalId);
    harness.records.delete(stateKey(plan, event.data.resourceId));
    return;
  }

  if (event.type === "iac.RecordedStateAbsent") {
    harness.records.delete(stateKey(plan, event.data.resourceId));
  }
}

function emit(harness, type, data) {
  const event = {
    id: `evt-${String(harness.nextSeq).padStart(4, "0")}`,
    type,
    seq: harness.nextSeq,
    data: structuredClone(data),
  };
  harness.nextSeq += 1;
  harness.events.push(event);
  return event;
}

function summarize(harness, plan, status) {
  return {
    status,
    events: harness.events.map((event) => structuredClone(event)),
    state: {
      resources: Object.fromEntries(
        plan.resources.map((resource) => [
          resource.id,
          {
            desired: harness.desired.get(stateKey(plan, resource.id)) ?? "Present",
          },
        ]),
      ),
    },
  };
}

function providerObjectEvent(object) {
  return {
    tenantId: object.tenantId,
    deploymentId: object.deploymentId,
    resourceId: object.logicalName,
    physicalId: object.physicalId,
    tags: { ...object.tags },
  };
}

function stateRecordEvent(plan, logicalName, object) {
  return {
    tenantId: plan.tenantId,
    deploymentId: plan.deploymentId,
    resourceId: logicalName,
    physicalId: object.physicalId,
    tags: { ...object.tags },
  };
}

function providerTags(plan, logicalName) {
  return {
    "hobo.tenant": plan.tenantId,
    "hobo.deployment": plan.deploymentId,
    "hobo.resource": logicalName,
  };
}

function publicObject(object) {
  return {
    tenantId: object.tenantId,
    deploymentId: object.deploymentId,
    logicalName: object.logicalName,
    physicalId: object.physicalId,
    tags: { ...object.tags },
  };
}

function byPlanOrder(plan) {
  const order = new Map(plan.resources.map((resource, index) => [resource.id, index]));
  return (left, right) =>
    (order.get(left.logicalName) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.logicalName) ?? Number.MAX_SAFE_INTEGER);
}

function isAlreadyDestroyed(harness, physicalId) {
  return harness.events.some(
    (event) =>
      (event.type === "iac.ResourceDestroyed" || event.type === "drift.OrphanSwept") &&
      event.data?.physicalId === physicalId,
  );
}

function scopeKey(plan) {
  return `${plan.tenantId}/${plan.deploymentId}`;
}

function stateKey(plan, logicalName) {
  return `${scopeKey(plan)}/${logicalName}`;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function assertHarness(harness) {
  if (
    !harness ||
    !(harness.inventory instanceof Map) ||
    !(harness.records instanceof Map) ||
    !Array.isArray(harness.events)
  ) {
    throw new Error("harness must be created by createPartialRealizeHarness");
  }
}

function assertPlan(plan) {
  if (!plan?.tenantId) {
    throw new Error("plan.tenantId is required");
  }
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
