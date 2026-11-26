import { createHash } from "node:crypto";

export const DELTA_SET_APPLY_RECONCILE_VERSION = "hobo.delta-set-apply-reconcile/v1";

export function createDeploymentSet(input) {
  if (!isNonEmptyString(input?.id)) {
    throw new Error("DeploymentSet id is required");
  }
  if (!isNonEmptyString(input.campId)) {
    throw new Error("DeploymentSet campId is required");
  }
  if (!isNonEmptyString(input.environmentType)) {
    throw new Error("DeploymentSet environmentType is required");
  }
  if (!isNonEmptyString(input.manifestDigest)) {
    throw new Error("DeploymentSet manifestDigest is required");
  }

  const resources = normalizeResourceMap(input.resources ?? {});
  assertDependenciesExist(resources);

  const set = {
    apiVersion: DELTA_SET_APPLY_RECONCILE_VERSION,
    id: input.id,
    campId: input.campId,
    environmentType: input.environmentType,
    manifestDigest: input.manifestDigest,
    previousSetId: optionalString(input.previousSetId),
    resources,
  };
  set.contentAddress = contentAddressSet(set);
  return canonicalize(set);
}

export function applyDeltaToSet({ baseSet, delta }) {
  const base = normalizeDeploymentSet(baseSet, "baseSet");
  if (!isNonEmptyString(delta?.id)) {
    throw new Error("Delta id is required");
  }
  const changes = normalizeChanges(delta.changes ?? []);

  if (changes.length === 0) {
    return {
      status: "noop",
      set: base,
      events: [
        event("delta.Applied", {
          deltaId: delta.id,
          resultingSetId: base.id,
          noop: true,
        }),
      ],
    };
  }

  const resources = applyChanges(base.resources, changes);
  const set = createDeploymentSet({
    id: delta.newSetId ?? `${base.id}.${delta.id}`,
    campId: base.campId,
    environmentType: base.environmentType,
    manifestDigest: delta.manifestDigest ?? `${base.manifestDigest}.${delta.id}`,
    previousSetId: base.id,
    resources,
  });

  return {
    status: "applied",
    set,
    events: [
      event("delta.Applied", {
        deltaId: delta.id,
        resultingSetId: set.id,
        noop: false,
      }),
      event("set.Created", {
        setId: set.id,
        campId: set.campId,
        contentAddress: set.contentAddress,
      }),
    ],
  };
}

export function buildReconcilePlan({ currentSet, desiredSet }) {
  const current = normalizeDeploymentSet(currentSet, "currentSet");
  const desired = normalizeDeploymentSet(desiredSet, "desiredSet");
  if (current.campId !== desired.campId) {
    throw new Error(`cannot reconcile Camp ${current.campId} to ${desired.campId}`);
  }
  const currentIds = new Set(Object.keys(current.resources));
  const desiredIds = new Set(Object.keys(desired.resources));

  const addIds = [...desiredIds].filter((id) => !currentIds.has(id));
  const updateIds = [...desiredIds]
    .filter((id) => currentIds.has(id))
    .filter((id) => canonicalJson(current.resources[id]) !== canonicalJson(desired.resources[id]));
  const removeIds = [...currentIds].filter((id) => !desiredIds.has(id));

  const actions = [
    ...sortProvisionOrder(addIds, desired.resources).map((resourceId) => ({
      action: "provision",
      resourceId,
      desired: clone(desired.resources[resourceId]),
    })),
    ...sortProvisionOrder(updateIds, desired.resources).map((resourceId) => ({
      action: "update",
      resourceId,
      current: clone(current.resources[resourceId]),
      desired: clone(desired.resources[resourceId]),
    })),
    ...sortDestroyOrder(removeIds, current.resources).map((resourceId) => ({
      action: "destroy",
      resourceId,
      current: clone(current.resources[resourceId]),
    })),
  ];

  return {
    apiVersion: DELTA_SET_APPLY_RECONCILE_VERSION,
    campId: current.campId,
    fromSetId: current.id,
    toSetId: desired.id,
    actions,
  };
}

export function planRollbackToSet({ currentSet, targetSet, compatGate }) {
  const current = normalizeDeploymentSet(currentSet, "currentSet");
  const target = normalizeDeploymentSet(targetSet, "targetSet");
  if (current.campId !== target.campId) {
    throw new Error(`cannot roll back Camp ${current.campId} to ${target.campId}`);
  }

  if (compatGate?.status !== "passed") {
    const reason = compatGate?.reason ?? "compat gate failed";
    return {
      status: "blocked",
      reason,
      delta: null,
      events: [
        event("compat.GateFailed", {
          gateId: compatGate?.gateId ?? "compat-gate",
          currentSetId: current.id,
          targetSetId: target.id,
          reason,
        }),
      ],
    };
  }

  const changes = diffResourceMaps(current.resources, target.resources);
  return {
    status: "planned",
    delta: {
      id: `rollback.${current.id}.to.${target.id}`,
      kind: "rollback",
      baseSetId: current.id,
      targetSetId: target.id,
      changes,
    },
    events: [
      event("compat.GatePassed", {
        gateId: compatGate.gateId,
        currentSetId: current.id,
        targetSetId: target.id,
      }),
    ],
  };
}

export function planEnvGroupPromote({ envGroupId, members }) {
  if (!isNonEmptyString(envGroupId)) {
    throw new Error("envGroupId is required");
  }
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("env-group promote requires member Camps");
  }

  const events = [event("env.PromoteRequested", { envGroupId })];
  const promotedRequired = [];
  const promotedOptional = [];
  const failedRequired = [];
  const failedOptional = [];

  for (const member of members) {
    if (!isNonEmptyString(member?.campId)) {
      throw new Error("env-group member campId is required");
    }
    events.push(event("camp.PromoteRequested", { envGroupId, campId: member.campId, optional: Boolean(member.optional) }));

    if (member.result === "promoted") {
      events.push(event("camp.Promoted", { envGroupId, campId: member.campId, optional: Boolean(member.optional) }));
      (member.optional ? promotedOptional : promotedRequired).push(member);
      continue;
    }

    events.push(event("camp.PromoteFailed", {
      envGroupId,
      campId: member.campId,
      optional: Boolean(member.optional),
      reason: member.reason ?? "member promote failed",
    }));
    (member.optional ? failedOptional : failedRequired).push(member);
  }

  if (failedRequired.length > 0) {
    for (const member of [...promotedRequired, ...promotedOptional].sort(byCampId)) {
      events.push(event("camp.RollbackRequested", { envGroupId, campId: member.campId }));
    }
    events.push(event("env.PromoteRolledBack", {
      envGroupId,
      failedCampIds: failedRequired.map((member) => member.campId).sort(),
    }));
    return { status: "rolled-back", events };
  }

  if (failedOptional.length > 0) {
    events.push(event("env.PartiallyPromoted", {
      envGroupId,
      promotedCampIds: [...promotedRequired, ...promotedOptional].map((member) => member.campId).sort(),
      failedOptionalCampIds: failedOptional.map((member) => member.campId).sort(),
    }));
    return { status: "partially-promoted", events };
  }

  events.push(event("env.Promoted", {
    envGroupId,
    promotedCampIds: [...promotedRequired, ...promotedOptional].map((member) => member.campId).sort(),
  }));
  return { status: "promoted", events };
}

function applyChanges(baseResources, changes) {
  const resources = clone(baseResources);
  for (const change of changes) {
    if (change.op === "add") {
      if (resources[change.resourceId]) {
        throw new Error(`Delta add references existing resource: ${change.resourceId}`);
      }
      resources[change.resourceId] = normalizeResource(change.resourceId, change.resource);
      continue;
    }
    if (change.op === "update") {
      if (!resources[change.resourceId]) {
        throw new Error(`Delta update references absent resource: ${change.resourceId}`);
      }
      resources[change.resourceId] = normalizeResource(change.resourceId, change.resource);
      continue;
    }
    if (change.op === "remove") {
      if (!resources[change.resourceId]) {
        throw new Error(`Delta remove references absent resource: ${change.resourceId}`);
      }
      delete resources[change.resourceId];
      continue;
    }
    throw new Error(`unsupported Delta operation: ${change.op}`);
  }
  return resources;
}

function diffResourceMaps(currentResources, targetResources) {
  const ids = [...new Set([...Object.keys(currentResources), ...Object.keys(targetResources)])].sort();
  const changes = [];
  for (const resourceId of ids) {
    const current = currentResources[resourceId];
    const target = targetResources[resourceId];
    if (!current && target) {
      changes.push({ op: "add", resourceId, resource: clone(target) });
      continue;
    }
    if (current && !target) {
      changes.push({ op: "remove", resourceId });
      continue;
    }
    if (canonicalJson(current) !== canonicalJson(target)) {
      changes.push({ op: "update", resourceId, resource: clone(target) });
    }
  }
  return changes;
}

function normalizeDeploymentSet(set, label) {
  if (!isObjectLike(set)) {
    throw new Error(`${label} is required`);
  }
  return createDeploymentSet(set);
}

function normalizeResourceMap(resources) {
  if (!isPlainObject(resources)) {
    throw new Error("DeploymentSet resources must be an object map");
  }
  const normalized = {};
  for (const resourceId of Object.keys(resources).sort()) {
    normalized[resourceId] = normalizeResource(resourceId, resources[resourceId]);
  }
  return normalized;
}

function normalizeResource(resourceId, resource) {
  if (!isObjectLike(resource)) {
    throw new Error(`resource ${resourceId} must be an object`);
  }
  if (resource.id !== resourceId) {
    throw new Error(`resource id mismatch for ${resourceId}`);
  }
  if (!isNonEmptyString(resource.type)) {
    throw new Error(`resource ${resourceId} type is required`);
  }
  if (!isNonEmptyString(resource.port)) {
    throw new Error(`resource ${resourceId} port is required`);
  }
  if (!Array.isArray(resource.deps)) {
    throw new Error(`resource ${resourceId} deps must be an array`);
  }
  for (const dep of resource.deps) {
    if (!isNonEmptyString(dep)) {
      throw new Error(`resource ${resourceId} has invalid dependency`);
    }
  }
  if (!resource.match?.decisionId || !resource.match?.definitionId || !resource.match?.catalogHash) {
    throw new Error(`resource ${resourceId} requires match decision metadata`);
  }
  if (!resource.replication?.topology) {
    throw new Error(`resource ${resourceId} requires replication topology`);
  }
  return clone(resource);
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes)) {
    throw new Error("Delta changes must be an array");
  }
  return changes.map((change) => {
    if (!isObjectLike(change)) {
      throw new Error("Delta change must be an object");
    }
    if (!["add", "update", "remove"].includes(change.op)) {
      throw new Error(`unsupported Delta operation: ${change.op}`);
    }
    if (!isNonEmptyString(change.resourceId)) {
      throw new Error("Delta change resourceId is required");
    }
    if (change.op === "remove") {
      return { op: change.op, resourceId: change.resourceId };
    }
    return {
      op: change.op,
      resourceId: change.resourceId,
      resource: normalizeResource(change.resourceId, change.resource),
    };
  });
}

function assertDependenciesExist(resources) {
  for (const [resourceId, resource] of Object.entries(resources)) {
    for (const dep of resource.deps) {
      if (!resources[dep]) {
        throw new Error(`resource ${resourceId} has missing dependency ${dep}`);
      }
    }
  }
}

function sortProvisionOrder(resourceIds, resources) {
  const selected = new Set(resourceIds);
  return [...resourceIds].sort((left, right) => dependencyDepth(left, resources, selected) - dependencyDepth(right, resources, selected) || left.localeCompare(right));
}

function sortDestroyOrder(resourceIds, resources) {
  const selected = new Set(resourceIds);
  return [...resourceIds].sort((left, right) => dependencyDepth(right, resources, selected) - dependencyDepth(left, resources, selected) || left.localeCompare(right));
}

function dependencyDepth(resourceId, resources, selected, seen = new Set()) {
  if (seen.has(resourceId)) {
    throw new Error(`cyclic dependency at ${resourceId}`);
  }
  seen.add(resourceId);
  const deps = resources[resourceId]?.deps ?? [];
  const selectedDeps = deps.filter((dep) => selected.has(dep));
  if (selectedDeps.length === 0) {
    return 0;
  }
  return 1 + Math.max(...selectedDeps.map((dep) => dependencyDepth(dep, resources, selected, new Set(seen))));
}

function contentAddressSet(set) {
  return `sha256:${createHash("sha256").update(canonicalJson({
    campId: set.campId,
    environmentType: set.environmentType,
    manifestDigest: set.manifestDigest,
    resources: set.resources,
  })).digest("hex")}`;
}

function event(type, data) {
  return {
    apiVersion: DELTA_SET_APPLY_RECONCILE_VERSION,
    type,
    data: clone(data),
  };
}

function byCampId(left, right) {
  return left.campId.localeCompare(right.campId);
}

function optionalString(value) {
  return isNonEmptyString(value) ? value : undefined;
}

function isNonEmptyString(value) {
  return Object.prototype.toString.call(value) === "[object String]" && value.trim().length > 0;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isObjectLike(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isObjectLike(value) {
  return value !== null && (Array.isArray(value) || isPlainObject(value));
}
