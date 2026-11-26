import { isJsonString } from "./json.js";
const supportedBackends = new Set(["iac-pulumi", "iac-opentofu"]);

export function createIacBackendHarness({ backendName, providerCreateSemantics = "idempotent" } = {}) {
  if (!supportedBackends.has(backendName)) {
    throw new Error(`unsupported backendName ${backendName}`);
  }

  const harness = {
    backendName,
    providerCreateSemantics,
    inventory: new Map(),
    stacks: new Map(),
    createAttempts: new Map(),
    nextSeq: 1,
    createAttemptsFor(stackKey, logicalName) {
      return this.createAttempts.get(resourceKey(stackKey, logicalName)) ?? 0;
    }
  };

  return harness;
}

export function applyResourceSlice({ backend, stackKey, program, fault = {} }) {
  assertBackend(backend);
  assertStackKey(stackKey);
  assertProgram(program);

  const events = [];
  const stack = ensureStack(backend, stackKey);

  for (const requested of program) {
    const logicalName = requested.logicalName;

    if (fault.rejectProviderConfigFor === logicalName) {
      return failedApply({
        backend,
        stackKey,
        logicalName,
        classification: "fatal",
        code: fault.code ?? "provider-config-rejected",
        events
      });
    }

    const recorded = stack.records.get(logicalName);
    if (recorded && backend.inventory.has(recorded.physicalId)) {
      events.push(event("iac.RecordedResourceReused", { stackKey, logicalName, physicalId: recorded.physicalId }));
      continue;
    }

    const orphan = findLiveByLogicalName(backend, stackKey, logicalName).find(
      (candidate) => !isRecorded(stack, candidate.physicalId)
    );
    if (orphan) {
      recordState(stack, orphan);
      events.push(event("iac.OrphanAdopted", { stackKey, logicalName, physicalId: orphan.physicalId }));
      continue;
    }

    const created = createProviderResource(backend, stackKey, requested);
    events.push(event("iac.ProviderResourceCreated", { stackKey, logicalName, physicalId: created.physicalId }));

    if (fault.crashBeforeStateWriteFor === logicalName) {
      return failedApply({
        backend,
        stackKey,
        logicalName,
        classification: "retryable",
        code: "state-write-interrupted",
        events
      });
    }

    if (fault.reportSuccessButRealityMissingFor === logicalName) {
      backend.inventory.delete(created.physicalId);
      return failedApply({
        backend,
        stackKey,
        logicalName,
        classification: "fatal",
        code: "success-report-mismatch-reality",
        events
      });
    }

    recordState(stack, created);
    events.push(event("iac.StateRecorded", { stackKey, logicalName, physicalId: created.physicalId }));

    if (fault.failAfterStateWriteFor === logicalName) {
      return failedApply({
        backend,
        stackKey,
        logicalName,
        classification: "retryable",
        code: fault.code ?? "provider-apply-interrupted",
        events
      });
    }
  }

  events.push(event("resource.Provisioned", { stackKey, backendName: backend.backendName }));
  return {
    status: "applied",
    backendName: backend.backendName,
    stackKey,
    events
  };
}

export function destroyPartialSlice({ backend, stackKey, fault = {} }) {
  assertBackend(backend);
  assertStackKey(stackKey);

  const stack = ensureStack(backend, stackKey);
  const targets = compensationTargets(backend, stackKey);
  const destroyed = [];
  const events = [];

  for (const target of targets) {
    if (fault.failDestroyFor === target.logicalName) {
      const error = classifiedError({
        backend,
        stackKey,
        logicalName: target.logicalName,
        classification: "fatal",
        code: fault.code ?? "destroy-failed"
      });
      events.push(event("resource.CompensationFailed", error));
      return {
        status: "compensation-failed",
        backendName: backend.backendName,
        stackKey,
        destroyed,
        remaining: inspectStack(backend, stackKey).residue,
        error,
        events
      };
    }

    backend.inventory.delete(target.physicalId);
    const recorded = stack.records.get(target.logicalName);
    if (recorded?.physicalId === target.physicalId) {
      stack.records.delete(target.logicalName);
    }
    destroyed.push({
      logicalName: target.logicalName,
      physicalId: target.physicalId,
      source: target.source
    });
    events.push(event("iac.ResourceDestroyed", { stackKey, logicalName: target.logicalName, source: target.source }));
  }

  if (stack.records.size === 0) {
    backend.stacks.delete(stackKey);
  }

  return {
    status: "destroyed",
    backendName: backend.backendName,
    stackKey,
    destroyed,
    remaining: [],
    events
  };
}

export function compensateNoGoDeployment({ backend, stackKeys }) {
  assertBackend(backend);
  if (!Array.isArray(stackKeys) || stackKeys.length === 0) {
    throw new Error("stackKeys must be a non-empty array");
  }

  const destroyed = [];
  const events = [];
  for (const stackKey of stackKeys) {
    const result = destroyPartialSlice({ backend, stackKey });
    destroyed.push(...result.destroyed.map((item) => ({ ...item, stackKey })));
    events.push(...result.events);
    if (result.status !== "destroyed") {
      return {
        status: "compensation-failed",
        destroyed,
        residue: residueForStackKeys(backend, stackKeys),
        events
      };
    }
  }

  return {
    status: "compensated",
    destroyed,
    residue: residueForStackKeys(backend, stackKeys),
    events
  };
}

export function inspectStack(backend, stackKey) {
  assertBackend(backend);
  assertStackKey(stackKey);

  const stack = backend.stacks.get(stackKey);
  const stateRecords = [...(stack?.records.values() ?? [])];
  const live = [...backend.inventory.values()]
    .filter((item) => item.stackKey === stackKey)
    .sort(byCreation)
    .map(publicResource);
  const recorded = stateRecords
    .filter((record) => backend.inventory.has(record.physicalId))
    .sort(byCreation)
    .map(publicResource);
  const recordedPhysicalIds = new Set(stateRecords.map((record) => record.physicalId));
  const orphans = live.filter((item) => !recordedPhysicalIds.has(item.physicalId));

  return {
    stackKey,
    backendName: backend.backendName,
    recorded,
    live,
    orphans,
    residue: live
  };
}

function failedApply({ backend, stackKey, logicalName, classification, code, events }) {
  const error = classifiedError({ backend, stackKey, logicalName, classification, code });
  events.push(event("exec.Failed", error));
  return {
    status: "failed",
    backendName: backend.backendName,
    stackKey,
    error,
    events
  };
}

function classifiedError({ backend, stackKey, logicalName, classification, code }) {
  return {
    backendName: backend.backendName,
    classification,
    code,
    logicalName,
    stackKey
  };
}

function createProviderResource(backend, stackKey, requested) {
  const logicalName = requested.logicalName;
  const key = resourceKey(stackKey, logicalName);
  backend.createAttempts.set(key, (backend.createAttempts.get(key) ?? 0) + 1);

  const physicalId = `${backend.backendName}-${slug(logicalName)}-${String(backend.nextSeq).padStart(4, "0")}`;
  const resource = {
    backendName: backend.backendName,
    physicalId,
    logicalName,
    kind: requested.kind ?? "resource",
    stackKey,
    tags: stackTags(stackKey, logicalName),
    createdSeq: backend.nextSeq
  };
  backend.nextSeq += 1;
  backend.inventory.set(physicalId, resource);
  return resource;
}

function compensationTargets(backend, stackKey) {
  const stack = ensureStack(backend, stackKey);
  const targets = [];
  const seenPhysicalIds = new Set();

  for (const record of stack.records.values()) {
    const live = backend.inventory.get(record.physicalId);
    if (live) {
      targets.push({ ...live, source: "recorded-state" });
      seenPhysicalIds.add(live.physicalId);
    }
  }

  for (const live of [...backend.inventory.values()].filter((item) => item.stackKey === stackKey).sort(byCreation)) {
    if (!seenPhysicalIds.has(live.physicalId)) {
      targets.push({ ...live, source: "orphan-sweep" });
      seenPhysicalIds.add(live.physicalId);
    }
  }

  return targets.sort(byCreation);
}

function residueForStackKeys(backend, stackKeys) {
  const allowed = new Set(stackKeys);
  return [...backend.inventory.values()]
    .filter((resource) => allowed.has(resource.stackKey))
    .sort(byCreation)
    .map(publicResource);
}

function findLiveByLogicalName(backend, stackKey, logicalName) {
  return [...backend.inventory.values()]
    .filter((item) => item.stackKey === stackKey && item.logicalName === logicalName)
    .sort(byCreation);
}

function recordState(stack, resource) {
  stack.records.set(resource.logicalName, {
    backendName: resource.backendName,
    physicalId: resource.physicalId,
    logicalName: resource.logicalName,
    kind: resource.kind,
    stackKey: resource.stackKey,
    tags: { ...resource.tags },
    createdSeq: resource.createdSeq
  });
}

function isRecorded(stack, physicalId) {
  return [...stack.records.values()].some((record) => record.physicalId === physicalId);
}

function ensureStack(backend, stackKey) {
  if (!backend.stacks.has(stackKey)) {
    backend.stacks.set(stackKey, {
      stackKey,
      records: new Map()
    });
  }
  return backend.stacks.get(stackKey);
}

function stackTags(stackKey, logicalName) {
  const [tenant, deployment, resource] = stackKey.split("/");
  return {
    "hobo.tenant": tenant,
    "hobo.deployment": deployment,
    "hobo.resource": resource,
    "hobo.stackKey": stackKey,
    "hobo.logicalName": logicalName
  };
}

function publicResource(resource) {
  return {
    backendName: resource.backendName,
    physicalId: resource.physicalId,
    logicalName: resource.logicalName,
    kind: resource.kind,
    stackKey: resource.stackKey,
    tags: { ...resource.tags },
    createdSeq: resource.createdSeq
  };
}

function event(type, data) {
  return {
    type,
    data: structuredClone(data)
  };
}

function assertBackend(backend) {
  if (!backend || !supportedBackends.has(backend.backendName) || !(backend.inventory instanceof Map)) {
    throw new Error("backend must be created by createIacBackendHarness");
  }
}

function assertStackKey(stackKey) {
  if (!isJsonString(stackKey) || stackKey.split("/").length !== 3) {
    throw new Error("stackKey must be tenant/deployment/resource");
  }
}

function assertProgram(program) {
  if (!Array.isArray(program) || program.length === 0) {
    throw new Error("program must be a non-empty array");
  }
  const names = new Set();
  for (const resource of program) {
    if (!resource?.logicalName) {
      throw new Error("program resource.logicalName is required");
    }
    if (names.has(resource.logicalName)) {
      throw new Error(`duplicate logicalName ${resource.logicalName}`);
    }
    names.add(resource.logicalName);
  }
}

function byCreation(left, right) {
  return left.createdSeq - right.createdSeq;
}

function resourceKey(stackKey, logicalName) {
  return `${stackKey}::${logicalName}`;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
