import { isJsonString, isJsonObject } from "./json.js";
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
export const PINNED_OPENTOFU_VERSION = "1.8.3";

const OUTPUT_REF = /^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;
const RESOURCE_TYPE_TO_HCL = new Map([
  ["wasi:keyvalue/store", "terraform_data.hobo_keyvalue_store"],
  ["wasi:blobstore/container", "terraform_data.hobo_blob_container"],
]);

export class OpenTofuProgramError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenTofuProgramError";
    this.code = code;
  }
}

export class OpenTofuApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenTofuApplyError";
    this.code = code;
  }
}

export class OpenTofuPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenTofuPlanError";
    this.code = code;
  }
}

export function createOpenTofuFixtureIacProgram(overrides = {}) {
  const base = {
    apiVersion: IAC_PROGRAM_API_VERSION,
    kind: "iac-program",
    provider: "opentofu",
    stack: "hobo-opentofu-fixture",
    resources: [
      {
        name: "cache",
        type: "wasi:keyvalue/store",
        provider: "local",
        inputs: { durability: "ephemeral" },
        outputs: ["endpoint", "resourceId"],
      },
      {
        name: "assets",
        type: "wasi:blobstore/container",
        provider: "local",
        inputs: {
          cacheEndpoint: "${resources.cache.outputs.endpoint}",
        },
        outputs: ["endpoint", "resourceId"],
      },
    ],
    stackOutputs: {
      assetEndpoint: "${resources.assets.outputs.endpoint}",
      cacheEndpoint: "${resources.cache.outputs.endpoint}",
    },
  };

  return deepFreeze({
    ...base,
    ...structuredClone(overrides),
    resources: structuredClone(overrides.resources ?? base.resources),
    stackOutputs: structuredClone(overrides.stackOutputs ?? base.stackOutputs),
  });
}

export function createOpenTofuAdapter(options = {}) {
  const binary = options.binary ?? createInMemoryOpenTofuBinary();
  const tofuVersion = options.tofuVersion ?? binary.tofuVersion ?? PINNED_OPENTOFU_VERSION;

  if (tofuVersion !== PINNED_OPENTOFU_VERSION) {
    throw new Error(`OpenTofu version mismatch: expected ${PINNED_OPENTOFU_VERSION}, got ${tofuVersion}`);
  }

  return deepFreeze({
    id: "@hobo/iac-opentofu",
    tofuVersion,
    async preview(program) {
      const compiled = compileOpenTofuProgram(program);
      return checkedPlan(binary, compiled);
    },
    async apply(program) {
      const compiled = compileOpenTofuProgram(program);
      const expected = await checkedPlan(binary, compiled);
      const result = await binary.apply(compiled, expected.changes);

      if (!sameChanges(expected.changes, result.appliedChanges)) {
        const unexpected = result.appliedChanges.find(
          (change) => !expected.changes.some((candidate) => sameChange(candidate, change)),
        );
        throw new OpenTofuApplyError(
          "plan-apply-divergence",
          `OpenTofu apply attempted unexpected resource ${unexpected?.resource ?? "unknown"}`,
        );
      }

      return result.outputs;
    },
    async refresh(program) {
      const compiled = compileOpenTofuProgram(program);
      return binary.refresh(compiled);
    },
    async destroy(program) {
      const compiled = compileOpenTofuProgram(program);
      return binary.destroy(compiled);
    },
  });
}

export function createInMemoryOpenTofuBinary(options = {}) {
  const state = { resources: {} };
  const commandLog = [];
  const heldLocks = new Map();
  let driftResources = [];

  return {
    tofuVersion: PINNED_OPENTOFU_VERSION,
    commandLog() {
      return structuredClone(commandLog);
    },
    mutateState(resourceName, patch) {
      const existing = state.resources[resourceName];
      if (!existing) {
        throw new OpenTofuApplyError("missing-state-resource", `no state resource named ${resourceName}`);
      }

      state.resources[resourceName] = {
        ...existing,
        specHash: stableJson({
          ...existing.sourceResource,
          ...structuredClone(patch),
        }),
      };
    },
    holdStateLock(stack, holder) {
      heldLocks.set(stack, holder);
    },
    async plan(compiled) {
      ensureNoStateLock(compiled.stack, heldLocks);
      commandLog.push({ command: "plan", stack: compiled.stack });
      const diff = diffFor(compiled, state);
      let changes = diff.changes;
      if (options.dropPlanResource) {
        changes = changes.filter((change) => change.resource !== options.dropPlanResource);
      }
      if (options.rewritePlanOp) {
        changes = changes.map((change) =>
          change.resource === options.rewritePlanOp.resource
            ? { ...change, op: options.rewritePlanOp.op }
            : change,
        );
      }
      if (options.skewPlan) {
        return deepFreeze({
          ...diff,
          changes: [...changes, { op: "create", resource: "sidecar", reason: "binary-plan-skew" }],
          dirty: true,
        });
      }

      return deepFreeze({
        ...diff,
        changes,
        dirty: changes.length > 0,
      });
    },
    async expectedPlan(compiled) {
      ensureNoStateLock(compiled.stack, heldLocks);
      return diffFor(compiled, state);
    },
    async apply(compiled, expectedChanges) {
      ensureNoStateLock(compiled.stack, heldLocks);
      commandLog.push({ command: "apply", stack: compiled.stack });
      const applied = [];

      for (const change of expectedChanges) {
        if (change.op === "delete") {
          delete state.resources[change.resource];
        }
      }

      for (const resource of compiled.resources) {
        state.resources[resource.name] = provisionedRecord(resource);
        applied.push(resource.name);

        if (options.failAfterResource === resource.name) {
          driftResources = compiled.resources.map((candidate) =>
            applied.includes(candidate.name)
              ? { name: candidate.name, reason: "partial-apply-provisioned" }
              : { name: candidate.name, reason: "not-applied-after-partial-failure" },
          );
          const next = compiled.resources[applied.length];
          throw new OpenTofuApplyError(
            "partial-apply",
            `partial apply failed after ${resource.name} before ${next?.name ?? "completion"}`,
          );
        }
      }

      driftResources = [];

      return {
        appliedChanges: structuredClone(expectedChanges),
        outputs: outputsFor(compiled, state),
      };
    },
    async refresh(compiled) {
      ensureNoStateLock(compiled.stack, heldLocks);
      commandLog.push({ command: "refresh", stack: compiled.stack });
      if (driftResources.length > 0) {
        return deepFreeze({
          kind: "drift-report",
          provider: "opentofu",
          drifted: true,
          resources: structuredClone(driftResources),
        });
      }

      const diff = diffFor(compiled, state);

      return deepFreeze({
        kind: "drift-report",
        provider: "opentofu",
        drifted: diff.changes.length > 0,
        resources: diff.changes.map((change) => ({
          name: change.resource,
          reason: change.reason,
        })),
      });
    },
    async destroy(compiled) {
      ensureNoStateLock(compiled.stack, heldLocks);
      commandLog.push({ command: "destroy", stack: compiled.stack });
      const destroyed = {};

      for (const resource of compiled.resources) {
        const existing = state.resources[resource.name];
        destroyed[resource.name] = {
          id: existing?.id ?? resourceId(resource.name),
          status: "destroyed",
          outputs: {},
        };
        delete state.resources[resource.name];
      }

      return deepFreeze({
        kind: "outputs",
        provider: "opentofu",
        resources: destroyed,
        stackOutputs: {},
      });
    },
  };
}

async function checkedPlan(binary, compiled) {
  const plan = await binary.plan(compiled);
  const expectedPlan =
    binary.expectedPlan instanceof Function
      ? await binary.expectedPlan(compiled)
      : {
          changes: plan.changes.filter((change) =>
            compiled.resources.some((resource) => resource.name === change.resource),
          ),
        };
  const skew = findPlanSkew(plan.changes, expectedPlan.changes);

  if (skew) {
    throw new OpenTofuPlanError(
      "binary-plan-skew",
      `OpenTofu binary plan diverged from compiled HCL for ${skew.resource}`,
    );
  }

  return plan;
}

function findPlanSkew(actualChanges, expectedChanges) {
  for (const expected of expectedChanges) {
    const actual = actualChanges.find((change) => change.resource === expected.resource);
    if (!actual || !samePlannedChange(actual, expected)) {
      return expected;
    }
  }

  return actualChanges.find((actual) => !expectedChanges.some((expected) => samePlannedChange(actual, expected)));
}

function ensureNoStateLock(stack, heldLocks) {
  const holder = heldLocks.get(stack);
  if (holder) {
    throw new OpenTofuApplyError("state-lock-held", `OpenTofu state lock for ${stack} is held by ${holder}`);
  }
}

export function compileOpenTofuProgram(program) {
  validateIacProgram(program);

  const resources = program.resources.map((resource) => {
    const hclType = RESOURCE_TYPE_TO_HCL.get(resource.type);
    if (!hclType) {
      throw new OpenTofuProgramError(
        "unsupported-hcl-mapping",
        `no OpenTofu HCL mapping for resource ${resource.name} type ${resource.type}`,
      );
    }

    return {
      ...structuredClone(resource),
      hclType,
    };
  });

  return deepFreeze({
    ...structuredClone(program),
    resources,
  });
}

export async function runIacBackendConformance({ adapter, program }) {
  const preview = await adapter.preview(program);
  assertConformance(preview.kind === "diff" && preview.dirty, "preview-diff");

  const outputs = await adapter.apply(program);
  assertConformance(outputs.kind === "outputs" && Object.keys(outputs.resources).length > 0, "apply-outputs");

  const refresh = await adapter.refresh(program);
  assertConformance(refresh.kind === "drift-report" && refresh.drifted === false, "refresh-clean");

  const destroy = await adapter.destroy(program);
  assertConformance(
    destroy.kind === "outputs" &&
      Object.values(destroy.resources).every((resource) => resource.status === "destroyed"),
    "destroy-clean",
  );

  return deepFreeze({
    suite: "@hobo/conformance/iac-backend",
    provider: "opentofu",
    passed: true,
    assertions: ["preview-diff", "apply-outputs", "refresh-clean", "destroy-clean"],
  });
}

export function validateIacProgram(program) {
  if (!program || !isJsonObject(program)) {
    throw new OpenTofuProgramError("invalid-program", "IacProgram must be an object");
  }
  if (program.apiVersion !== IAC_PROGRAM_API_VERSION) {
    throw new OpenTofuProgramError(
      "invalid-api-version",
      `IacProgram apiVersion must be ${IAC_PROGRAM_API_VERSION}`,
    );
  }
  if (program.kind !== "iac-program") {
    throw new OpenTofuProgramError("invalid-kind", "IacProgram kind must be iac-program");
  }
  if (program.provider !== "opentofu") {
    throw new OpenTofuProgramError("invalid-provider", "IacProgram provider must be opentofu");
  }
  if (!Array.isArray(program.resources) || program.resources.length === 0) {
    throw new OpenTofuProgramError("empty-program", "IacProgram must include at least one resource");
  }

  const resources = new Map();
  for (const resource of program.resources) {
    if (!resource?.name) {
      throw new OpenTofuProgramError("invalid-resource", "IacProgram resource missing name");
    }
    if (resources.has(resource.name)) {
      throw new OpenTofuProgramError(
        "duplicate-resource",
        `IacProgram includes duplicate resource ${resource.name}`,
      );
    }
    resources.set(resource.name, resource);
  }

  for (const value of collectValues(program.resources)) {
    validateOutputReference(value, resources);
  }
  for (const value of Object.values(program.stackOutputs ?? {})) {
    validateOutputReference(value, resources);
  }

  return deepFreeze(structuredClone(program));
}

function assertConformance(condition, assertion) {
  if (!condition) {
    throw new OpenTofuApplyError("conformance-failed", `IaC backend conformance assertion failed: ${assertion}`);
  }
}

function validateOutputReference(value, resources) {
  if (!isJsonString(value) || !value.startsWith("${resources.")) {
    return;
  }

  const match = OUTPUT_REF.exec(value);
  if (!match) {
    throw new OpenTofuProgramError("invalid-output-reference", `invalid output reference ${value}`);
  }

  const [, resourceName, outputName] = match;
  const resource = resources.get(resourceName);
  if (!resource || !(resource.outputs ?? []).includes(outputName)) {
    throw new OpenTofuProgramError(
      "unresolved-output-reference",
      `unresolved output reference resources.${resourceName}.outputs.${outputName}`,
    );
  }
}

function diffFor(compiled, state) {
  const desired = new Map(compiled.resources.map((resource) => [resource.name, resource]));
  const changes = [];

  for (const resource of compiled.resources) {
    const existing = state.resources[resource.name];
    if (!existing) {
      changes.push({ op: "create", resource: resource.name, reason: "missing-from-state" });
      continue;
    }
    if (existing.specHash !== stableJson(resource)) {
      changes.push({ op: "update", resource: resource.name, reason: "spec-drift" });
    }
  }

  for (const name of Object.keys(state.resources)) {
    if (!desired.has(name)) {
      changes.push({ op: "delete", resource: name, reason: "extra-in-state" });
    }
  }

  return deepFreeze({
    kind: "diff",
    provider: "opentofu",
    changes,
    dirty: changes.length > 0,
  });
}

function provisionedRecord(resource) {
  const outputs = {
    endpoint: `memory://${resource.name}`,
    resourceId: resourceId(resource.name),
  };

  return {
    id: resourceId(resource.name),
    status: "provisioned",
    outputs,
    sourceResource: structuredClone(resource),
    specHash: stableJson(resource),
  };
}

function outputsFor(compiled, state) {
  const resources = {};
  for (const resource of compiled.resources) {
    const existing = state.resources[resource.name] ?? provisionedRecord(resource);
    resources[resource.name] = {
      id: existing.id,
      status: existing.status,
      outputs: structuredClone(existing.outputs),
    };
  }

  return deepFreeze({
    kind: "outputs",
    provider: "opentofu",
    resources,
    stackOutputs: resolveStackOutputs(compiled.stackOutputs ?? {}, resources),
  });
}

function resolveStackOutputs(stackOutputs, resources) {
  return Object.fromEntries(
    Object.entries(stackOutputs).map(([key, value]) => [key, resolveValue(value, resources)]),
  );
}

function resolveValue(value, resources) {
  const match = isJsonString(value) ? OUTPUT_REF.exec(value) : undefined;
  if (!match) {
    return structuredClone(value);
  }

  const [, resourceName, outputName] = match;
  return resources[resourceName].outputs[outputName];
}

function resourceId(name) {
  return `opentofu:local:${name}`;
}

function collectValues(value) {
  if (!value || !isJsonObject(value)) {
    return [value];
  }

  return Object.values(value).flatMap((child) => collectValues(child));
}

function sameChanges(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((change) => right.some((candidate) => sameChange(change, candidate)));
}

function sameChange(left, right) {
  return left.op === right.op && left.resource === right.resource;
}

function samePlannedChange(left, right) {
  return left.op === right.op && left.resource === right.resource && left.reason === right.reason;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}
