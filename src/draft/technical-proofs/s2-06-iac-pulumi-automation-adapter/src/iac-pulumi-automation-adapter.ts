export const PINNED_PULUMI_AUTOMATION_VERSION = "3.130.0";
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
export const ADAPTER_ID = "@hobo/iac-pulumi";

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

export class PulumiStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PulumiStateError";
    this.code = code;
  }
}

export function createTrivialIacProgram(overrides = {}) {
  const base = {
    apiVersion: IAC_PROGRAM_API_VERSION,
    kind: "iac-program",
    provider: "pulumi",
    deploymentId: "trivial-demo",
    stack: "tenant/trivial-demo",
    resources: [
      {
        name: "hello",
        type: "hobo:trivial/greeting",
        provider: "local",
        inputs: { message: "hello-bindle" },
        outputs: ["greeting", "resourceId"],
      },
    ],
    stackOutputs: {
      greeting: "${resources.hello.outputs.greeting}",
    },
  };

  return deepFreeze({
    ...base,
    ...structuredClone(overrides),
    resources: structuredClone(overrides.resources ?? base.resources),
    stackOutputs: structuredClone(overrides.stackOutputs ?? base.stackOutputs),
  });
}

export function createPerResourceStackKey(program, resourceName) {
  const deploymentId = program.deploymentId ?? program.stack ?? "default";
  return `${deploymentId}/${resourceName}`;
}

export function createStateBackendConfig(overrides = {}) {
  return deepFreeze({
    kind: "memory",
    lockHolder: null,
    ...structuredClone(overrides),
  });
}

export function createPulumiAutomationAdapter(options = {}) {
  const stateBackend = options.stateBackend ?? createInMemoryStateBackend();
  const engine = options.engine ?? createInMemoryAutomationEngine({ stateBackend });
  const pulumiVersion = options.pulumiVersion ?? engine.pulumiVersion ?? PINNED_PULUMI_AUTOMATION_VERSION;

  if (pulumiVersion !== PINNED_PULUMI_AUTOMATION_VERSION) {
    throw new Error(
      `Pulumi Automation API version mismatch: expected ${PINNED_PULUMI_AUTOMATION_VERSION}, got ${pulumiVersion}`,
    );
  }

  return deepFreeze({
    id: ADAPTER_ID,
    pulumiVersion,
    stateBackend: stateBackend.describe(),
    async preview(program) {
      const parsed = validateIacProgram(program);
      return engine.preview(parsed);
    },
    async apply(program) {
      const parsed = validateIacProgram(program);
      const expected = await engine.preview(parsed);
      const result = await engine.apply(parsed, expected.changes);

      if (!sameChanges(expected.changes, result.appliedChanges)) {
        const unexpected = result.appliedChanges.find(
          (change) => !expected.changes.some((candidate) => sameChange(candidate, change)),
        );
        throw new PulumiApplyError(
          "preview-apply-divergence",
          `preview/apply divergence: apply attempted unexpected resource ${unexpected?.resource ?? "unknown"}`,
        );
      }

      return {
        ...result.outputs,
        bindings: outputsToBindings(result.outputs),
      };
    },
    async refresh(program) {
      const parsed = validateIacProgram(program);
      return engine.refresh(parsed);
    },
    async destroy(program) {
      const parsed = validateIacProgram(program);
      return engine.destroy(parsed);
    },
  });
}

export function createInMemoryStateBackend(options = {}) {
  const stores = new Map();
  const locks = new Map();

  return {
    kind: "memory",
    describe() {
      return deepFreeze({ kind: "memory", lockHolder: locks.get("global") ?? null });
    },
    read(stackKey) {
      return structuredClone(stores.get(stackKey) ?? { resources: {} });
    },
    write(stackKey, state) {
      if (options.failOnWriteFor === stackKey) {
        throw new PulumiStateError("state-write-failed", `state write failed for ${stackKey}`);
      }
      stores.set(stackKey, structuredClone(state));
    },
    holdLock(stackKey, holder) {
      const existing = locks.get(stackKey);
      if (existing && existing !== holder) {
        throw new PulumiStateError(
          "state-lock-held",
          `Pulumi state lock for ${stackKey} is held by ${existing}`,
        );
      }
      locks.set(stackKey, holder);
    },
    releaseLock(stackKey, holder) {
      if (locks.get(stackKey) === holder) {
        locks.delete(stackKey);
      }
    },
    snapshot() {
      return deepFreeze(Object.fromEntries(stores.entries()));
    },
  };
}

export function createInMemoryAutomationEngine(options = {}) {
  const stateBackend = options.stateBackend ?? createInMemoryStateBackend();
  let driftStacks = new Map();

  return {
    pulumiVersion: PINNED_PULUMI_AUTOMATION_VERSION,
    stateBackend,
    snapshot() {
      return stateBackend.snapshot();
    },
    async preview(program) {
      const changes = [];

      for (const resource of program.resources) {
        const stackKey = createPerResourceStackKey(program, resource.name);
        const state = stateBackend.read(stackKey);
        const diff = diffResource(resource, state);

        if (diff) {
          changes.push({ op: diff.op, resource: resource.name, stackKey, reason: diff.reason });
        }
      }

      for (const [stackKey, state] of Object.entries(stateBackend.snapshot())) {
        const resourceName = stackKey.split("/").at(-1);
        const stillDesired = program.resources.some((resource) => resource.name === resourceName);

        if (!stillDesired && Object.keys(state.resources ?? {}).length > 0) {
          changes.push({
            op: "delete",
            resource: resourceName,
            stackKey,
            reason: "extra-per-resource-stack",
          });
        }
      }

      return deepFreeze({
        kind: "diff",
        provider: "pulumi",
        model: "per-resource-stack",
        changes,
        dirty: changes.length > 0,
      });
    },
    async apply(program, expectedChanges) {
      if (options.divergeOnApply) {
        driftStacks.set("sidecar", { reason: "preview-apply-divergence" });
        return {
          appliedChanges: [
            ...structuredClone(expectedChanges),
            {
              op: "create",
              resource: "sidecar",
              stackKey: createPerResourceStackKey(program, "sidecar"),
              reason: "unexpected-during-apply",
            },
          ],
          outputs: outputsFor(program, stateBackend),
        };
      }

      for (const resource of program.resources) {
        const stackKey = createPerResourceStackKey(program, resource.name);
        stateBackend.holdLock(stackKey, options.lockHolder ?? "resource-actor:self");
        const record = provisionedRecord(resource);

        try {
          stateBackend.write(stackKey, { resources: { [resource.name]: record } });
        } finally {
          stateBackend.releaseLock(stackKey, options.lockHolder ?? "resource-actor:self");
        }

        if (options.failAfterResource === resource.name) {
          for (const candidate of program.resources) {
            driftStacks.set(createPerResourceStackKey(program, candidate.name), {
              reason: candidate.name === resource.name
                ? "partial-apply-provisioned"
                : "not-applied-after-partial-failure",
            });
          }
          const next = program.resources[program.resources.indexOf(resource) + 1];
          throw new PulumiApplyError(
            "partial-apply",
            `partial apply failed after ${resource.name} before ${next?.name ?? "completion"}`,
          );
        }
      }

      driftStacks = new Map();

      return {
        appliedChanges: structuredClone(expectedChanges),
        outputs: outputsFor(program, stateBackend),
      };
    },
    async refresh(program) {
      if (driftStacks.size > 0) {
        return deepFreeze({
          kind: "drift-report",
          provider: "pulumi",
          model: "per-resource-stack",
          drifted: true,
          resources: [...driftStacks.entries()].map(([stackKey, detail]) => ({
            name: stackKey.split("/").at(-1),
            stackKey,
            reason: detail.reason,
          })),
        });
      }

      const preview = await this.preview(program);

      return deepFreeze({
        kind: "drift-report",
        provider: "pulumi",
        model: "per-resource-stack",
        drifted: preview.dirty,
        resources: preview.changes.map((change) => ({
          name: change.resource,
          stackKey: change.stackKey,
          reason: change.reason,
        })),
      });
    },
    async destroy(program) {
      const destroyed = {};
      const reverseOrder = [...program.resources].reverse();

      for (const resource of reverseOrder) {
        const stackKey = createPerResourceStackKey(program, resource.name);
        const state = stateBackend.read(stackKey);
        const existing = state.resources?.[resource.name];

        destroyed[resource.name] = {
          id: existing?.id ?? resourceId(resource.name),
          stackKey,
          status: "destroyed",
          outputs: {},
        };

        stateBackend.write(stackKey, { resources: {} });
      }

      driftStacks = new Map();

      return deepFreeze({
        kind: "outputs",
        provider: "pulumi",
        model: "per-resource-stack",
        resources: destroyed,
        stackOutputs: {},
        bindings: {},
      });
    },
  };
}

export function outputsToBindings(outputs) {
  const bindings = {};

  for (const [resourceName, resource] of Object.entries(outputs.resources ?? {})) {
    for (const [outputName, value] of Object.entries(resource.outputs ?? {})) {
      bindings[`${resourceName}.${outputName}`] = value;
      bindings[`\${resources.${resourceName}.outputs.${outputName}}`] = value;
    }
  }

  for (const [key, value] of Object.entries(outputs.stackOutputs ?? {})) {
    bindings[`stack.${key}`] = value;
  }

  return deepFreeze(bindings);
}

export async function runIacBackendConformance({ adapter, program }) {
  const preview = await adapter.preview(program);
  assertConformance(preview.kind === "diff" && preview.dirty, "preview-diff");

  const outputs = await adapter.apply(program);
  assertConformance(outputs.kind === "outputs" && Object.keys(outputs.resources).length > 0, "apply-outputs");
  assertConformance(outputs.bindings && Object.keys(outputs.bindings).length > 0, "binding-outputs");

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
    provider: "pulumi",
    passed: true,
    assertions: ["preview-diff", "apply-outputs", "binding-outputs", "refresh-clean", "destroy-clean"],
  });
}

export function validateIacProgram(program) {
  // Parse-don't-validate: returns ParsedIacProgram derived types.
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

function assertConformance(condition, assertion) {
  if (!condition) {
    throw new PulumiApplyError("conformance-failed", `IaC backend conformance assertion failed: ${assertion}`);
  }
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

function diffResource(resource, state) {
  const existing = state.resources?.[resource.name];

  if (!existing) {
    return { op: "create", reason: "missing-from-per-resource-stack" };
  }

  if (existing.specHash !== stableJson(resource)) {
    return { op: "update", reason: "spec-drift" };
  }

  return null;
}

function provisionedRecord(resource) {
  const outputs = {
    endpoint: `pulumi://${resource.name}`,
    resourceId: resourceId(resource.name),
    greeting: resource.inputs?.message ?? `hello-${resource.name}`,
  };

  return {
    id: resourceId(resource.name),
    status: "provisioned",
    outputs,
    specHash: stableJson(resource),
  };
}

function outputsFor(program, stateBackend) {
  const resources = {};

  for (const resource of program.resources) {
    const stackKey = createPerResourceStackKey(program, resource.name);
    const state = stateBackend.read(stackKey);
    const existing = state.resources?.[resource.name] ?? provisionedRecord(resource);

    resources[resource.name] = {
      id: existing.id,
      stackKey,
      status: existing.status,
      outputs: structuredClone(existing.outputs),
    };
  }

  const stackOutputs = resolveStackOutputs(program.stackOutputs ?? {}, resources);

  return deepFreeze({
    kind: "outputs",
    provider: "pulumi",
    model: "per-resource-stack",
    resources,
    stackOutputs,
    bindings: outputsToBindings({ resources, stackOutputs }),
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
  return `pulumi:stack:${name}`;
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

  return left.every((change) => right.some((candidate) => sameChange(candidate, change)));
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
