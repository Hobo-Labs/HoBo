export const PINNED_PULUMI_AUTOMATION_VERSION = "3.130.0";
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";

const OUTPUT_REF = /^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;

export class PulumiProgramError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PulumiProgramError";
    this.code = code;
  }
}

export class PulumiApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PulumiApplyError";
    this.code = code;
  }
}

export function createFixtureIacProgram(overrides = {}) {
  const base = {
    apiVersion: IAC_PROGRAM_API_VERSION,
    kind: "iac-program",
    provider: "pulumi",
    stack: "hobo-local-fixture",
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

export function createPulumiAutomationAdapter(options = {}) {
  const engine = options.engine ?? createInMemoryAutomationEngine();
  const pulumiVersion = options.pulumiVersion ?? engine.pulumiVersion ?? PINNED_PULUMI_AUTOMATION_VERSION;

  if (pulumiVersion !== PINNED_PULUMI_AUTOMATION_VERSION) {
    throw new Error(
      `Pulumi Automation API version mismatch: expected ${PINNED_PULUMI_AUTOMATION_VERSION}, got ${pulumiVersion}`,
    );
  }

  return deepFreeze({
    id: "@hobo/iac-pulumi",
    pulumiVersion,
    async preview(program) {
      validateIacProgram(program);
      return engine.preview(program);
    },
    async apply(program) {
      validateIacProgram(program);
      const expected = await engine.preview(program);
      const result = await engine.apply(program, expected.changes);

      if (!sameChanges(expected.changes, result.appliedChanges)) {
        const unexpected = result.appliedChanges.find(
          (change) => !expected.changes.some((candidate) => sameChange(candidate, change)),
        );
        throw new PulumiApplyError(
          "preview-apply-divergence",
          `preview/apply divergence: apply attempted unexpected resource ${unexpected?.resource ?? "unknown"}`,
        );
      }

      return result.outputs;
    },
    async refresh(program) {
      validateIacProgram(program);
      return engine.refresh(program);
    },
    async destroy(program) {
      validateIacProgram(program);
      return engine.destroy(program);
    },
  });
}

export function createInMemoryAutomationEngine(options = {}) {
  const state = { resources: {} };
  let driftResources = [];
  const commandLog = [];

  return {
    pulumiVersion: PINNED_PULUMI_AUTOMATION_VERSION,
    commandLog() {
      return structuredClone(commandLog);
    },
    snapshot() {
      return deepFreeze(structuredClone(state));
    },
    async preview(program) {
      return diffFor(program, state);
    },
    async apply(program, expectedChanges) {
      if (options.divergeOnApply) {
        driftResources = [{ name: "sidecar", reason: "preview-apply-divergence" }];
        return {
          appliedChanges: [
            ...structuredClone(expectedChanges),
            { op: "create", resource: "sidecar", reason: "unexpected-during-apply" },
          ],
          outputs: outputsFor(program, state),
        };
      }

      const applied = [];

      for (const resource of program.resources) {
        const record = provisionedRecord(resource);
        state.resources[resource.name] = record;
        applied.push(resource.name);

        if (options.failAfterResource === resource.name) {
          driftResources = program.resources.map((candidate) =>
            applied.includes(candidate.name)
              ? { name: candidate.name, reason: "partial-apply-provisioned" }
              : { name: candidate.name, reason: "not-applied-after-partial-failure" },
          );
          const next = program.resources[applied.length];
          throw new PulumiApplyError(
            "partial-apply",
            `partial apply failed after ${resource.name} before ${next?.name ?? "completion"}`,
          );
        }
      }

      driftResources = [];

      return {
        appliedChanges: structuredClone(expectedChanges),
        outputs: outputsFor(program, state),
      };
    },
    async refresh(program) {
      if (driftResources.length > 0) {
        return deepFreeze({
          kind: "drift-report",
          provider: "pulumi",
          drifted: true,
          resources: structuredClone(driftResources),
        });
      }

      const diff = diffFor(program, state);

      return deepFreeze({
        kind: "drift-report",
        provider: "pulumi",
        drifted: diff.changes.length > 0,
        resources: diff.changes.map((change) => ({
          name: change.resource,
          reason: change.reason,
        })),
      });
    },
    async destroy(program) {
      const destroyed = {};

      for (const resource of program.resources) {
        const existing = state.resources[resource.name];
        destroyed[resource.name] = {
          id: existing?.id ?? resourceId(resource.name),
          status: "destroyed",
          outputs: {},
        };
        delete state.resources[resource.name];
      }

      driftResources = [];

      return deepFreeze({
        kind: "outputs",
        provider: "pulumi",
        resources: destroyed,
        stackOutputs: {},
      });
    },
  };
}

export function validateIacProgram(program) {
  if (!isObjectRecord(program)) {
    throw new PulumiProgramError("invalid-program", "IacProgram must be an object");
  }
  if (program.apiVersion !== IAC_PROGRAM_API_VERSION) {
    throw new PulumiProgramError(
      "invalid-api-version",
      `IacProgram apiVersion must be ${IAC_PROGRAM_API_VERSION}`,
    );
  }
  if (program.kind !== "iac-program") {
    throw new PulumiProgramError("invalid-kind", "IacProgram kind must be iac-program");
  }
  if (program.provider !== "pulumi") {
    throw new PulumiProgramError("invalid-provider", "IacProgram provider must be pulumi");
  }
  if (!Array.isArray(program.resources) || program.resources.length === 0) {
    throw new PulumiProgramError("empty-program", "IacProgram must include at least one resource");
  }

  const resources = new Map();

  for (const resource of program.resources) {
    if (!resource?.name) {
      throw new PulumiProgramError("invalid-resource", "IacProgram resource missing name");
    }
    if (resources.has(resource.name)) {
      throw new PulumiProgramError(
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

function validateOutputReference(value, resources) {
  if (!isString(value) || !value.startsWith("${resources.")) {
    return;
  }

  const match = OUTPUT_REF.exec(value);
  if (!match) {
    throw new PulumiProgramError("invalid-output-reference", `invalid output reference ${value}`);
  }

  const [, resourceName, outputName] = match;
  const resource = resources.get(resourceName);

  if (!resource || !(resource.outputs ?? []).includes(outputName)) {
    throw new PulumiProgramError(
      "unresolved-output-reference",
      `unresolved output reference resources.${resourceName}.outputs.${outputName}`,
    );
  }
}

function diffFor(program, state) {
  const desired = new Map(program.resources.map((resource) => [resource.name, resource]));
  const changes = [];

  for (const resource of program.resources) {
    const existing = state.resources[resource.name];

    if (!existing) {
      changes.push({ op: "create", resource: resource.name, reason: "missing-from-stack" });
      continue;
    }

    if (existing.specHash !== stableJson(resource)) {
      changes.push({ op: "update", resource: resource.name, reason: "spec-drift" });
    }
  }

  for (const name of Object.keys(state.resources)) {
    if (!desired.has(name)) {
      changes.push({ op: "delete", resource: name, reason: "extra-in-stack" });
    }
  }

  return deepFreeze({
    kind: "diff",
    provider: "pulumi",
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
    specHash: stableJson(resource),
  };
}

function outputsFor(program, state) {
  const resources = {};

  for (const resource of program.resources) {
    const existing = state.resources[resource.name] ?? provisionedRecord(resource);
    resources[resource.name] = {
      id: existing.id,
      status: existing.status,
      outputs: structuredClone(existing.outputs),
    };
  }

  return deepFreeze({
    kind: "outputs",
    provider: "pulumi",
    resources,
    stackOutputs: resolveStackOutputs(program.stackOutputs ?? {}, resources),
  });
}

function resolveStackOutputs(stackOutputs, resources) {
  return Object.fromEntries(
    Object.entries(stackOutputs).map(([key, value]) => [key, resolveValue(value, resources)]),
  );
}

function resolveValue(value, resources) {
  const match = isString(value) ? OUTPUT_REF.exec(value) : undefined;

  if (!match) {
    return structuredClone(value);
  }

  const [, resourceName, outputName] = match;
  return resources[resourceName].outputs[outputName];
}

function resourceId(name) {
  return `pulumi:local:${name}`;
}

function collectValues(value) {
  if (!isObjectRecord(value)) {
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

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isObjectRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
