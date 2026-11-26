import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const MANIFEST_SCHEMA = "hobo.execution-host-capability-manifest/v1";
const COST_SCHEMA = "hobo.cost/v1";
const OBJECTIVES = new Set(["cost", "latency", "single-provider", "carbon", "maximize-credits"]);
const CATEGORIES = new Set(["runner", "build-machine"]);
const CATEGORY_PORTS = {
  runner: "hobo:runner",
  "build-machine": "hobo:build-machine",
};
const CATEGORY_SKUS = {
  runner: "runner.minutes",
  "build-machine": "build.minutes",
};
const DEFAULT_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function createSelfHostedRunnerProvider({
  id = "self-hosted",
  freeTierUnits = 10000,
  marginalPrice = "0.0000",
} = {}) {
  return {
    id,
    category: "runner",
    capabilityManifest() {
      return createCapabilityManifest({
        id,
        category: "runner",
        freeTierUnits,
        marginalPrice,
      });
    },
    async run(job) {
      const jobId = requireString(job?.jobId, "job.jobId");
      return {
        providerId: id,
        category: "runner",
        jobId,
        status: "succeeded",
        command: job.command ?? "",
        events: [
          { type: "runner.JobStarted", jobId, providerId: id },
          { type: "runner.JobSucceeded", jobId, providerId: id },
        ],
      };
    },
  };
}

export function createSelfHostedBuildMachineProvider({
  id = "self-hosted",
  buildProvider = createFixtureBuildProvider(),
  creditBudget = { remainingUnits: Number.POSITIVE_INFINITY },
  freeTierUnits = 5000,
  marginalPrice = "0.0000",
} = {}) {
  return {
    id,
    category: "build-machine",
    capabilityManifest() {
      return createCapabilityManifest({
        id,
        category: "build-machine",
        freeTierUnits,
        marginalPrice,
      });
    },
    async execute(build) {
      const buildId = requireString(build?.buildId, "build.buildId");
      const estimatedUnits = build.estimatedUnits ?? 1;
      if ((creditBudget.remainingUnits ?? 0) < estimatedUnits) {
        const error = new Error(`build-machine ${id} has insufficient credit for ${estimatedUnits} units`);
        error.code = "credit.exhausted";
        error.providerId = id;
        error.buildId = buildId;
        throw error;
      }

      return buildProvider.build({
        ...clone(build),
        hostProviderId: id,
      });
    },
  };
}

export function createFixtureBuildProvider({
  digest = DEFAULT_DIGEST,
  mediaType = "application/vnd.wasm.content.layer.v1+wasm",
} = {}) {
  const calls = [];
  return {
    calls,
    async build(build) {
      calls.push(clone(build));
      return {
        mediaType,
        uri: `oci://registry.example/hobo/${build.buildId}@${digest}`,
        digest,
      };
    },
  };
}

export function createExecutionHostRegistry(providers = []) {
  const byCategory = new Map();
  const byId = new Map();

  for (const provider of providers) {
    validateProviderContract(provider);
    const manifest = provider.capabilityManifest();
    const validation = validateExecutionHostManifest(manifest, { category: provider.category });
    if (!validation.ok) {
      throw new Error(`provider ${provider.id} has invalid manifest: ${validation.errors.join("; ")}`);
    }
    const record = {
      provider,
      manifest,
      id: provider.id,
      category: provider.category,
    };
    byId.set(`${provider.category}:${provider.id}`, record);
    const bucket = byCategory.get(provider.category) ?? [];
    bucket.push(record);
    byCategory.set(provider.category, bucket);
  }

  return { providers: [...providers], byCategory, byId };
}

export function selectExecutionHost(request, registry) {
  const category = requireCategory(request?.category);
  const objective = request.objective ?? "maximize-credits";
  if (!OBJECTIVES.has(objective)) {
    throw new Error(`unsupported objective ${objective}`);
  }
  const dispatchId = requireString(request.dispatchId, "dispatchId");
  const units = request.units ?? 1;
  const ledgerView = request.ledgerView ?? { seq: 0, balanceHash: digestRef({ empty: true }), balances: {} };

  if (request.withProvider) {
    const pinned = registry.byId.get(`${category}:${request.withProvider}`);
    if (!pinned) {
      throw new Error(`pinned provider ${request.withProvider} is not registered for ${category}`);
    }
    return createDecision({
      dispatchId,
      category,
      objective,
      ledgerView,
      selected: pinned,
      candidates: [rankCandidate(pinned, ledgerView, units)],
      routingMode: "pinned",
      optedOutOfRouting: true,
    });
  }

  const candidates = (registry.byCategory.get(category) ?? [])
    .map((record) => rankCandidate(record, ledgerView, units))
    .sort((left, right) => {
      if (left.effectiveMarginalCost !== right.effectiveMarginalCost) {
        return left.effectiveMarginalCost - right.effectiveMarginalCost;
      }
      return left.providerId.localeCompare(right.providerId);
    });

  if (candidates.length === 0) {
    throw new Error(`no registered providers for ${category}`);
  }

  const selected = registry.byId.get(`${category}:${candidates[0].providerId}`);
  return createDecision({
    dispatchId,
    category,
    objective,
    ledgerView,
    selected,
    candidates,
    routingMode: "ranked",
    optedOutOfRouting: false,
  });
}

export function validateExecutionHostManifest(manifest, { category } = {}) {
  const errors = [];
  if (!manifest || !isJsonObject(manifest) || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    errors.push(`schema must be ${MANIFEST_SCHEMA}`);
  }
  if (!manifest.provider || !isJsonObject(manifest.provider)) {
    errors.push("provider must be an object");
  } else {
    requireField(manifest.provider, "id", errors, "provider.id");
    if (!CATEGORIES.has(manifest.provider.category)) {
      errors.push("provider.category must be runner or build-machine");
    }
    if (category && manifest.provider.category !== category) {
      errors.push(`provider.category must be ${category}`);
    }
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length !== 1) {
    errors.push("capabilities must contain exactly one execution-host port");
  } else {
    const capability = manifest.capabilities[0];
    const expectedPort = CATEGORY_PORTS[manifest.provider?.category];
    if (capability?.port !== expectedPort) {
      errors.push(`capabilities.0.port must be ${expectedPort}`);
    }
    requireField(capability, "interface", errors, "capabilities.0.interface");
    requireField(capability, "version", errors, "capabilities.0.version");
  }
  if (!manifest.cost || !isJsonObject(manifest.cost)) {
    errors.push("cost must be an object");
  } else {
    if (manifest.cost.schema !== COST_SCHEMA) {
      errors.push(`cost.schema must be ${COST_SCHEMA}`);
    }
    if (!Array.isArray(manifest.cost.facts) || manifest.cost.facts.length === 0) {
      errors.push("cost.facts must be non-empty");
    } else {
      const fact = manifest.cost.facts[0];
      if (fact?.sku !== CATEGORY_SKUS[manifest.provider?.category]) {
        errors.push(`cost.facts.0.sku must be ${CATEGORY_SKUS[manifest.provider?.category]}`);
      }
      if (fact?.source?.type !== "declared-provider") {
        errors.push("cost.facts.0.source.type must be declared-provider");
      }
      requireField(fact?.source ?? {}, "digest", errors, "cost.facts.0.source.digest");
    }
  }

  return { ok: errors.length === 0, errors };
}

function createCapabilityManifest({ id, category, freeTierUnits, marginalPrice }) {
  const port = CATEGORY_PORTS[category];
  const sku = CATEGORY_SKUS[category];
  return sortKeys({
    schema: MANIFEST_SCHEMA,
    provider: {
      id,
      category,
      kind: "execution-host-provider",
      adapter: id,
    },
    capabilities: [
      {
        port,
        interface: category === "runner" ? "hobo:runner/job" : "hobo:build-machine/host",
        version: "0.1.0",
        stability: "preview",
        features: category === "runner" ? ["ci-job"] : ["wasm-component-build"],
      },
    ],
    cost: {
      schema: COST_SCHEMA,
      currency: "USD",
      facts: [
        {
          sku,
          unit: "minute",
          marginalPrice,
          freeTier: {
            unit: "minute",
            included: freeTierUnits,
            reset: "monthly",
          },
          source: {
            type: "declared-provider",
            digest: digestRef({ id, category, sku, marginalPrice, freeTierUnits }),
          },
        },
      ],
    },
  });
}

function rankCandidate(record, ledgerView, units) {
  const sku = CATEGORY_SKUS[record.category];
  const quote = ledgerView.balances?.[record.id]?.[sku] ?? {};
  const freeHeadroom = quote.freeHeadroom ?? 0;
  const listUnitCost = quote.marginalUnitCost ?? Number(record.manifest.cost.facts[0].marginalPrice);
  const paidUnits = Math.max(0, units - freeHeadroom);
  const totalCost = Number((paidUnits * listUnitCost).toFixed(10));
  return {
    providerId: record.id,
    category: record.category,
    effectiveMarginalCost: freeHeadroom >= units ? 0 : listUnitCost,
    totalCost,
    costTrust: "declared-unverified",
  };
}

function createDecision({
  dispatchId,
  category,
  objective,
  ledgerView,
  selected,
  candidates,
  routingMode,
  optedOutOfRouting,
}) {
  return {
    selectedProvider: selected.id,
    category,
    routingMode,
    optedOutOfRouting,
    candidates,
    dispatchDecided: {
      type: "dispatch.Decided",
      data: {
        dispatchId,
        category,
        selectedProvider: selected.id,
        objective,
        ledgerInput: {
          view: "CreditLedgerView",
          seq: ledgerView.seq,
          reservationId: `reserve-${dispatchId}`,
          balanceHash: ledgerView.balanceHash,
        },
        candidates: candidates.map((candidate) => ({
          provider: candidate.providerId,
          effectiveMarginalCost: candidate.effectiveMarginalCost,
        })),
      },
    },
  };
}

function validateProviderContract(provider) {
  if (!provider || !isJsonObject(provider)) {
    throw new Error("provider must be an object");
  }
  requireString(provider.id, "provider.id");
  requireCategory(provider.category);
  if (!(provider.capabilityManifest instanceof Function)) {
    throw new Error(`provider ${provider.id} must expose capabilityManifest()`);
  }
}

function requireCategory(category) {
  if (!CATEGORIES.has(category)) {
    throw new Error(`category must be runner or build-machine`);
  }
  return category;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireField(value, field, errors, label = field) {
  if (!isJsonString(value?.[field]) || value[field].length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function digestRef(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
