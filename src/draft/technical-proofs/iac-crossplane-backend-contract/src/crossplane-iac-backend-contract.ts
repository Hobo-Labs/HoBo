export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
export const CROSSPLANE_BACKEND_CONTRACT_VERSION = "hobo.iac-crossplane/v1";

const OUTPUT_REF = /^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;
const REQUIRED_CRDS = ["CompositeResourceClaim", "Composition"];

export class CrossplaneProgramError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CrossplaneProgramError";
    this.code = code;
  }
}

export class CrossplaneApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CrossplaneApplyError";
    this.code = code;
  }
}

export function createFixtureIacProgram(overrides = {}) {
  const base = {
    apiVersion: IAC_PROGRAM_API_VERSION,
    kind: "iac-program",
    provider: "crossplane",
    stack: "hobo-crossplane-fixture",
    resources: [
      {
        name: "database",
        type: "hobo:database/postgres",
        provider: "kubernetes",
        inputs: {
          compositionSelector: { matchLabels: { port: "database", class: "postgres" } },
          parameters: { storageGiB: 20 },
        },
        outputs: ["endpoint", "resourceId"],
      },
      {
        name: "cache",
        type: "hobo:cache/redis",
        provider: "kubernetes",
        inputs: {
          compositionSelector: { matchLabels: { port: "cache", class: "redis" } },
          parameters: { memoryMiB: 256 },
        },
        outputs: ["endpoint", "resourceId"],
      },
    ],
    stackOutputs: {
      cacheEndpoint: "${resources.cache.outputs.endpoint}",
      databaseEndpoint: "${resources.database.outputs.endpoint}",
    },
  };

  return deepFreeze({
    ...base,
    ...structuredClone(overrides),
    resources: structuredClone(overrides.resources ?? base.resources),
    stackOutputs: structuredClone(overrides.stackOutputs ?? base.stackOutputs),
  });
}

export function createCrossplaneIacAdapter(options = {}) {
  const cluster = options.cluster ?? createInMemoryCrossplaneCluster();
  const readyPollLimit = options.readyPollLimit ?? 3;

  return deepFreeze({
    id: "@hobo/iac-crossplane",
    async preview(program) {
      const normalized = validateIacProgram(program);
      return diffFor(normalized, cluster);
    },
    async apply(program) {
      const normalized = validateIacProgram(program);
      ensureRequiredCrds(cluster);

      for (const resource of normalized.resources) {
        selectComposition(cluster, resource);
      }

      const applied = {};
      for (const resource of normalized.resources) {
        const claim = claimFor(resource, selectComposition(cluster, resource));
        cluster.applyClaim(claim);
        const ready = cluster.waitForReady(resource.name, readyPollLimit);
        if (!ready) {
          throw new CrossplaneApplyError(
            "ready-timeout",
            `${resource.name} did not reach Ready after ${readyPollLimit} polls`,
          );
        }
        applied[resource.name] = outputsForClaim(cluster.getClaim(resource.name), resource);
      }

      return deepFreeze({
        kind: "outputs",
        provider: "crossplane",
        resources: applied,
        stackOutputs: resolveStackOutputs(normalized.stackOutputs ?? {}, applied),
      });
    },
    async refresh(program) {
      const normalized = validateIacProgram(program);
      const resources = [];
      const desiredNames = new Set(normalized.resources.map((resource) => resource.name));

      for (const resource of normalized.resources) {
        const claim = cluster.getClaim(resource.name);
        if (!claim) {
          resources.push({ name: resource.name, reason: "claim-missing" });
          continue;
        }
        const expected = claimFor(resource, selectComposition(cluster, resource));
        if (claim.specHash !== stableJson(expected.spec)) {
          resources.push({ name: resource.name, reason: "spec-drift" });
        }
        if (claim.status.phase !== "Ready") {
          resources.push({ name: resource.name, reason: "not-ready" });
        }

        const expectedOutputs = expectedStatusFor(resource);
        for (const outputName of resource.outputs ?? []) {
          if (claim.status.outputs?.[outputName] !== expectedOutputs.outputs[outputName]) {
            resources.push({
              name: resource.name,
              reason: "status-output-drift",
              output: outputName,
            });
          }
        }
      }

      for (const claimName of cluster.claimNames()) {
        if (!desiredNames.has(claimName)) {
          resources.push({ name: claimName, reason: "extra-claim" });
        }
      }

      return deepFreeze({
        kind: "drift-report",
        provider: "crossplane",
        drifted: resources.length > 0,
        resources,
      });
    },
    async destroy(program) {
      const normalized = validateIacProgram(program);
      const resources = {};
      for (const resource of normalized.resources) {
        const existing = cluster.getClaim(resource.name);
        resources[resource.name] = {
          id: existing?.id ?? claimId(resource.name),
          status: "destroyed",
          outputs: {},
        };
        cluster.deleteClaim(resource.name);
      }

      return deepFreeze({
        kind: "outputs",
        provider: "crossplane",
        resources,
        stackOutputs: {},
      });
    },
  });
}

export function createInMemoryCrossplaneCluster(options = {}) {
  const installedCrds = new Set(options.installedCrds ?? REQUIRED_CRDS);
  const compositions = structuredClone(
    options.compositions ?? [
      { name: "postgres", labels: { port: "database", class: "postgres" } },
      { name: "redis", labels: { port: "cache", class: "redis" } },
    ],
  );
  const stuckClaims = new Set(options.stuckClaims ?? []);
  const claims = new Map();

  return {
    hasCrd(name) {
      return installedCrds.has(name);
    },
    compositions() {
      return structuredClone(compositions);
    },
    applyClaim(claim) {
      const stored = structuredClone(claim);
      if (stuckClaims.has(claim.name)) {
        stored.status.phase = "Pending";
        stored.status.outputs = {};
      }
      claims.set(claim.name, stored);
      return getClaim(claim.name);
    },
    waitForReady(name, pollLimit) {
      const claim = claims.get(name);
      for (let attempt = 0; attempt < pollLimit; attempt += 1) {
        if (claim?.status.phase === "Ready") return true;
      }
      return false;
    },
    getClaim,
    claimNames() {
      return [...claims.keys()].sort();
    },
    deleteClaim(name) {
      claims.delete(name);
    },
    mutateClaim(name, mutation = {}) {
      const claim = claims.get(name);
      if (!claim) {
        throw new CrossplaneProgramError("claim-not-found", `claim ${name} does not exist`);
      }

      if (mutation.specPatch) {
        claim.spec = deepMerge(claim.spec, mutation.specPatch);
        claim.specHash = stableJson(claim.spec);
      }
      if (mutation.statusPatch) {
        claim.status.outputs = {
          ...claim.status.outputs,
          ...structuredClone(mutation.statusPatch),
        };
      }
      return getClaim(name);
    },
  };

  function getClaim(name) {
    const claim = claims.get(name);
    return claim ? deepFreeze(structuredClone(claim)) : undefined;
  }
}

export async function runIacBackendConformanceSuite({ adapter, program }) {
  const preview = await adapter.preview(program);
  const outputs = await adapter.apply(program);
  const refresh = await adapter.refresh(program);
  const destroy = await adapter.destroy(program);

  return {
    provider: preview.provider,
    previewDirtyBeforeApply: preview.dirty === true,
    applyReady: Object.values(outputs.resources).every((resource) => resource.status === "ready"),
    refreshCleanAfterApply: refresh.drifted === false,
    destroyRemovedClaims: Object.values(destroy.resources).every(
      (resource) => resource.status === "destroyed",
    ),
  };
}

export function validateIacProgram(program) {
  if (!isRecord(program)) {
    throw new CrossplaneProgramError("invalid-program", "IacProgram must be an object");
  }
  if (program.apiVersion !== IAC_PROGRAM_API_VERSION) {
    throw new CrossplaneProgramError(
      "invalid-api-version",
      `IacProgram apiVersion must be ${IAC_PROGRAM_API_VERSION}`,
    );
  }
  if (program.kind !== "iac-program") {
    throw new CrossplaneProgramError("invalid-kind", "IacProgram kind must be iac-program");
  }
  if (program.provider !== "crossplane") {
    throw new CrossplaneProgramError("invalid-provider", "IacProgram provider must be crossplane");
  }
  if (!Array.isArray(program.resources) || program.resources.length === 0) {
    throw new CrossplaneProgramError("empty-program", "IacProgram must include resources");
  }

  const resources = new Map();
  for (const resource of program.resources) {
    if (!resource?.name) {
      throw new CrossplaneProgramError("invalid-resource", "resource name is required");
    }
    if (resources.has(resource.name)) {
      throw new CrossplaneProgramError(
        "duplicate-resource",
        `IacProgram includes duplicate resource ${resource.name}`,
      );
    }
    resources.set(resource.name, resource);
    if (!resource.inputs?.compositionSelector?.matchLabels) {
      throw new CrossplaneProgramError(
        "missing-composition-selector",
        `${resource.name} must include inputs.compositionSelector.matchLabels`,
      );
    }
  }

  for (const value of Object.values(program.stackOutputs ?? {})) {
    validateOutputReference(value, resources);
  }

  return deepFreeze(structuredClone(program));
}

function ensureRequiredCrds(cluster) {
  for (const crd of REQUIRED_CRDS) {
    if (!cluster.hasCrd(crd)) {
      throw new CrossplaneProgramError("crd-missing", `missing required Crossplane CRD ${crd}`);
    }
  }
}

function selectComposition(cluster, resource) {
  const selector = resource.inputs.compositionSelector.matchLabels;
  const matches = cluster
    .compositions()
    .filter((composition) =>
      Object.entries(selector).every(([key, value]) => composition.labels?.[key] === value),
    );

  if (matches.length === 0) {
    throw new CrossplaneProgramError(
      "composition-not-found",
      `${resource.name} selector matched no Crossplane Composition`,
    );
  }
  if (matches.length > 1) {
    throw new CrossplaneProgramError(
      "composition-ambiguous",
      `${resource.name} selector matched multiple Crossplane Compositions: ${matches
        .map((match) => match.name)
        .sort()
        .join(", ")}`,
    );
  }

  return matches[0];
}

function diffFor(program, cluster) {
  const desired = new Set(program.resources.map((resource) => resource.name));
  const changes = [];

  for (const resource of program.resources) {
    const expected = claimFor(resource, selectComposition(cluster, resource));
    const claim = cluster.getClaim(resource.name);
    if (!claim) {
      changes.push({ op: "create", resource: resource.name, reason: "claim-missing" });
      continue;
    }

    if (claim.specHash !== stableJson(expected.spec)) {
      changes.push({ op: "update", resource: resource.name, reason: "spec-drift" });
    }
  }

  for (const claimName of cluster.claimNames()) {
    if (!desired.has(claimName)) {
      changes.push({ op: "delete", resource: claimName, reason: "extra-claim" });
    }
  }

  return deepFreeze({
    kind: "diff",
    provider: "crossplane",
    dirty: changes.length > 0,
    changes,
  });
}

function claimFor(resource, composition) {
  const status = expectedStatusFor(resource);
  const spec = {
    apiVersion: CROSSPLANE_BACKEND_CONTRACT_VERSION,
    kind: "CompositeResourceClaim",
    compositionRef: composition.name,
    parameters: structuredClone(resource.inputs.parameters ?? {}),
    resourceType: resource.type,
  };

  return {
    id: claimId(resource.name),
    name: resource.name,
    spec,
    specHash: stableJson(spec),
    status,
  };
}

function expectedStatusFor(resource) {
  const serviceName = resource.name === "database" ? "postgres" : resource.name === "cache" ? "redis" : resource.name;
  return {
    phase: "Ready",
    outputs: {
      endpoint: `${serviceName}.${resource.name}.svc.cluster.local`,
      resourceId: `managed/${resource.name}`,
    },
  };
}

function outputsForClaim(claim, resource) {
  const outputs = {};
  for (const output of resource.outputs ?? []) {
    outputs[output] = claim.status.outputs[output];
  }

  return {
    id: claim.id,
    status: claim.status.phase.toLowerCase(),
    outputs,
  };
}

function resolveStackOutputs(stackOutputs, resources) {
  return Object.fromEntries(
    Object.entries(stackOutputs).map(([key, value]) => [key, resolveValue(value, resources)]),
  );
}

function resolveValue(value, resources) {
  const match = isString(value) ? OUTPUT_REF.exec(value) : undefined;
  if (!match) return structuredClone(value);

  const [, resourceName, outputName] = match;
  return resources[resourceName].outputs[outputName];
}

function validateOutputReference(value, resources) {
  if (!isString(value) || !value.startsWith("${resources.")) {
    return;
  }

  const match = OUTPUT_REF.exec(value);
  if (!match) {
    throw new CrossplaneProgramError("invalid-output-reference", `invalid output reference ${value}`);
  }

  const [, resourceName, outputName] = match;
  const resource = resources.get(resourceName);
  if (!resource || !(resource.outputs ?? []).includes(outputName)) {
    throw new CrossplaneProgramError(
      "unresolved-output-reference",
      `unresolved output reference resources.${resourceName}.outputs.${outputName}`,
    );
  }
}

function claimId(name) {
  return `crossplane:claim:${name}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function deepMerge(left, right) {
  const merged = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function isPlainObject(value) {
  return isRecord(value);
}

function deepFreeze(value) {
  if (!isRecord(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function isRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
