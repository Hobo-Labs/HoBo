import { isJsonObject } from "./json.js";
const STRICTNESS = new Set(["require", "prefer"]);

export function createPortRequest(name, port, options = {}) {
  const strictness = options.strictness ?? "require";

  if (!STRICTNESS.has(strictness)) {
    throw new Error(`Unknown port strictness: ${strictness}`);
  }

  return deepFreeze({
    kind: "port-request",
    name,
    port,
    verbs: [...(options.verbs ?? [])],
    strictness,
    options: structuredClone(options.options ),
  });
}

export function createFakeCapability({ port, supports, cost = undefined }) {
  const supportedVerbs = new Set(supports);

  return deepFreeze({
    port,
    supports: [...supportedVerbs].sort(),
    satisfies(request) {
      if (request.port !== port) {
        return { level: "none", missing: ["port"] };
      }

      const missing = request.verbs.filter((verb) => !supportedVerbs.has(verb));

      return missing.length === 0
        ? { level: "full", missing: [] }
        : { level: "partial", missing };
    },
    estimateCost() {
      return cost ? structuredClone(cost) : undefined;
    },
  });
}

export function matchCapability(capability, request) {
  const satisfaction = capability.satisfies(request);
  const cost = normalizeCostSignal(capability.estimateCost(satisfaction));

  if (satisfaction.level === "none") {
    return deepFreeze({
      accepted: false,
      level: satisfaction.level,
      reason: "capability-unavailable",
      missing: satisfaction.missing,
      warnings: [],
      cost,
    });
  }

  if (satisfaction.level === "partial" && request.strictness === "require") {
    return deepFreeze({
      accepted: false,
      level: satisfaction.level,
      reason: "missing-required-capability",
      missing: satisfaction.missing,
      warnings: [],
      cost,
    });
  }

  if (satisfaction.level === "partial") {
    return deepFreeze({
      accepted: true,
      level: satisfaction.level,
      reason: "preferred-capability-degraded",
      missing: satisfaction.missing,
      warnings: satisfaction.missing.map((item) => `missing preferred capability: ${item}`),
      cost,
    });
  }

  return deepFreeze({
    accepted: true,
    level: satisfaction.level,
    reason: "capability-satisfied",
    missing: [],
    warnings: [],
    cost,
  });
}

export function planResource({ name, port, provider, options = {}, build = undefined }) {
  return deepFreeze({
    kind: "resource-plan",
    name,
    port,
    provider,
    options: structuredClone(options),
    build: build ? structuredClone(build) : undefined,
  });
}

export function createFakeCloudProvider({ id, regions, capabilities }) {
  return deepFreeze({
    id,
    regions: [...regions],
    capabilities,
    capabilityManifest() {
      return deepFreeze({
        schema: "hobo.capability-manifest/v1",
        provider: id,
        capabilities: capabilities.map((capability) => ({
          port: capability.port,
          verbs: [...capability.supports],
        })),
      });
    },
    async realize(plan) {
      if (plan.provider !== id) {
        throw new Error(`ResourcePlan provider ${plan.provider} does not match ${id}`);
      }

      return deepFreeze({
        iac: {
          kind: "iac-program",
          provider: id,
          resources: [
            {
              name: plan.name,
              port: plan.port,
              options: structuredClone(plan.options),
            },
          ],
        },
        build: plan.build ? structuredClone(plan.build) : undefined,
      });
    },
    client(port, outputs) {
      return deepFreeze({
        port,
        outputs: structuredClone(outputs),
      });
    },
  });
}

export function createFakeIacProvider(provider, options = {}) {
  let driftResources = [];

  return deepFreeze({
    id: provider,
    async preview(program) {
      return deepFreeze({
        kind: "diff",
        provider,
        changes: program.resources.map((resource) => ({
          op: "create",
          resource: resource.name,
        })),
        dirty: false,
      });
    },
    async apply(program) {
      if (options.dirtyOnApply) {
        driftResources = program.resources.map((resource) => ({
          name: resource.name,
          reason: "apply-dirty-after-clean-preview",
        }));
        throw new Error("IacProgram apply became dirty after clean preview");
      }

      return outputsFor(provider, program, "provisioned");
    },
    async refresh() {
      return deepFreeze({
        kind: "drift-report",
        provider,
        drifted: driftResources.length > 0,
        resources: structuredClone(driftResources),
      });
    },
    async destroy(program) {
      return outputsFor(provider, program, "destroyed");
    },
  });
}

function normalizeCostSignal(cost) {
  if (!cost) {
    return {
      kind: "cost-signal",
      objectiveInput: "none",
      reason: "absent-cost-signal",
    };
  }

  return {
    kind: "cost-signal",
    objectiveInput: "marginal-cost",
    ...structuredClone(cost),
  };
}

function outputsFor(provider, program, status) {
  return deepFreeze({
    kind: "outputs",
    provider,
    resources: Object.fromEntries(
      program.resources.map((resource) => [
        resource.name,
        {
          id: `${provider}:${resource.name}`,
          status,
        },
      ]),
    ),
  });
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
