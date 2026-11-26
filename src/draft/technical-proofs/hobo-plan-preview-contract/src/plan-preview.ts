import {
  DEPLOYMENT_PLAN_IR_VERSION,
  canonicalJson,
  planContentAddress
} from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";

export const PLAN_PREVIEW_SCHEMA = "hobo.plan-preview/v1";

const COST_ASSUMPTIONS = Object.freeze([
  "30 day month",
  "provider catalog prices are list estimates",
  "egress rounded to the declared connectivity tier"
]);

const PORT_INTERFACES = Object.freeze({
  bucket: "wasi:blobstore/blobstore",
  http: "wasi:http/incoming-handler",
  kv: "hobo:data/kv",
  analytics: "hobo:data/analytics"
});

export function createSamplePlanFixture(overrides = {}) {
  const resources = [
    {
      id: "catalog",
      port: "kv",
      className: "standard",
      requiredCapability: "key-value",
      outputs: ["endpoint"],
      rawEscapes: ["catalog.query.raw"]
    },
    {
      id: "images",
      port: "bucket",
      className: "standard",
      requiredCapability: "object-storage",
      outputs: ["bucketName"]
    },
    {
      id: "api",
      port: "http",
      className: "wasm",
      requiredCapability: "http-service",
      outputs: ["url"],
      deps: ["catalog", "images"]
    }
  ];

  const providerDefinitions = [
    {
      id: "azure-table-storage",
      port: "kv",
      provider: "azure.tableStorage",
      cloud: "azure",
      driver: "terraform",
      costMonthlyUsd: 12.4,
      reason: "provider default for prod kv",
      supportedCapabilities: ["key-value"],
      match: { camp: "prod" },
      priority: 10
    },
    {
      id: "aws-s3-standard",
      port: "bucket",
      provider: "aws.s3",
      cloud: "aws",
      driver: "terraform",
      costMonthlyUsd: 9.1,
      reason: "provider default for prod bucket",
      supportedCapabilities: ["object-storage"],
      match: { camp: "prod" },
      priority: 20
    },
    {
      id: "azure-container-app",
      port: "http",
      provider: "azure.containerApp",
      cloud: "azure",
      driver: "terraform",
      costMonthlyUsd: 42,
      reason: "component host for prod api",
      supportedCapabilities: ["http-service"],
      match: { camp: "prod" },
      priority: 30
    },
    {
      id: "local-kv",
      port: "kv",
      provider: "local.kv",
      cloud: "local",
      driver: "runtime-local",
      costMonthlyUsd: 0,
      reason: "runtime-local staging kv",
      supportedCapabilities: ["key-value"],
      match: { camp: "staging" },
      priority: 10
    }
  ];

  return {
    app: "snapshop",
    tenant: "tenant-acme",
    camps: {
      prod: { env: "prod", envType: "production" },
      staging: { env: "staging", envType: "staging" }
    },
    resources: [...resources, ...(overrides.resources ?? [])],
    providerDefinitions: [...providerDefinitions, ...(overrides.providerDefinitions ?? [])],
    currentDeploymentSet: overrides.currentDeploymentSet ?? null
  };
}

export function runHoboPlan(argv = [], fixture = createSamplePlanFixture()) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    return commandFailure(parsed.error);
  }

  if (!parsed.camp) {
    return commandFailure("missing required --camp");
  }

  const camp = fixture.camps?.[parsed.camp];
  if (!camp) {
    return commandFailure(`unknown camp "${parsed.camp}"; known camps: ${Object.keys(fixture.camps ?? {}).join(", ")}`);
  }

  const preview = createPlanPreview({ ...fixture, campName: parsed.camp, camp });
  if (preview.status === "would-fail-planning") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${preview.error.message}\n`,
      preview
    };
  }

  const stdout = parsed.json ? renderJsonPlan(preview) : renderHumanPlan(preview);
  return {
    exitCode: preview.exitCode,
    stdout,
    stderr: "",
    preview
  };
}

export function createPlanPreview(input) {
  const decisions = [];
  const warnings = [];
  const failures = [];

  for (const resource of input.resources ?? []) {
    const decision = decideProvider({
      resource,
      campName: input.campName,
      providerDefinitions: input.providerDefinitions ?? []
    });

    if (!decision.ok) {
      failures.push(decision.failure);
      continue;
    }

    decisions.push({ resource, decision });
    warnings.push(...decision.warnings);
  }

  if (failures.length > 0) {
    const failure = failures[0];
    return {
      schema: PLAN_PREVIEW_SCHEMA,
      command: "hobo plan",
      camp: input.campName,
      status: "would-fail-planning",
      exitCode: 2,
      error: {
        code: "required-capability-unresolved",
        message: `cannot resolve required capability ${failure.requiredCapability}; offending port ${failure.resourceId} (${failure.port})`,
        resourceId: failure.resourceId,
        port: failure.port
      },
      sideEffectEvents: []
    };
  }

  warnings.push(...nonPortableRawWarnings(input.resources ?? []));
  const deploymentPlan = buildDeploymentPlan({
    app: input.app,
    tenant: input.tenant,
    campName: input.campName,
    camp: input.camp,
    decisions
  });
  const planHash = planContentAddress(deploymentPlan);
  const crossCloudEdges = findCrossCloudEdges(decisions);
  warnings.push(...crossCloudEdges.map(crossCloudWarning));

  const noOp = input.currentDeploymentSet?.camp === input.campName &&
    input.currentDeploymentSet?.planHash === planHash;
  const resourceChanges = noOp
    ? []
    : decisions.map(({ resource, decision }) => ({
        action: "would-create-or-update",
        resourceId: resource.id,
        provider: decision.provider
      }));
  const cost = costEstimate(decisions);
  const status = noOp ? "no-op" : "would-change";

  return {
    schema: PLAN_PREVIEW_SCHEMA,
    command: "hobo plan",
    camp: input.campName,
    status,
    exitCode: noOp ? 0 : 1,
    summary: noOp ? "0 changes" : `${resourceChanges.length} changes`,
    planHash,
    deploymentPlan,
    resources: decisions.map(({ resource, decision }) => ({
      id: resource.id,
      port: resource.port,
      provider: decision.provider,
      providerDefinitionId: decision.definitionId,
      reason: decision.reason,
      estimatedMonthlyUsd: decision.estimatedMonthlyUsd
    })),
    changes: resourceChanges,
    cost,
    warnings,
    crossCloudEdges,
    sideEffectEvents: []
  };
}

export function renderHumanPlan(preview) {
  const lines = [
    "Resource  Port    Provider",
    ...preview.resources.map(
      (resource) =>
        `${resource.id.padEnd(9)} ${resource.port.padEnd(7)} -> ${resource.provider} [${resource.reason}; est ${formatCurrency(resource.estimatedMonthlyUsd)}/mo]`
    ),
    "",
    `Summary: ${preview.summary}`,
    `Cost: estimate ${formatCurrency(preview.cost.monthlyUsd)}/mo`,
    "Assumptions:",
    ...preview.cost.assumptions.map((assumption) => `- ${assumption}`)
  ];

  if (preview.warnings.length > 0) {
    lines.push("", "Warnings", ...preview.warnings.map((warning) => `- ${warning.message}`));
  }

  lines.push("", `Plan hash: ${preview.planHash}`);
  return `${lines.join("\n")}\n`;
}

export function renderJsonPlan(preview) {
  return canonicalJson(preview);
}

function parseArgs(argv) {
  const parsed = { camp: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--camp") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: "option --camp requires a value" };
      }
      parsed.camp = value;
      index += 1;
      continue;
    }
    return { error: `unknown option "${token}"` };
  }
  return parsed;
}

function commandFailure(message) {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n`,
    preview: {
      schema: PLAN_PREVIEW_SCHEMA,
      status: "would-fail-planning",
      exitCode: 2,
      error: { message },
      sideEffectEvents: []
    }
  };
}

function decideProvider({ resource, campName, providerDefinitions }) {
  const candidates = providerDefinitions
    .filter((definition) => definition.port === resource.port)
    .filter((definition) => (definition.match?.camp ?? campName) === campName)
    .filter((definition) => definition.supportedCapabilities?.includes(resource.requiredCapability))
    .sort(compareDefinition);

  if (candidates.length === 0) {
    return {
      ok: false,
      failure: {
        resourceId: resource.id,
        port: resource.port,
        requiredCapability: resource.requiredCapability
      }
    };
  }

  const winner = candidates[0];
  const tied = candidates.filter((candidate) => candidate.priority === winner.priority);
  const warnings = tied.length > 1
    ? [
        {
          code: "ambiguous-provider-resolution",
          resourceId: resource.id,
          message: `ambiguous provider resolution for ${resource.id}; stable winner ${winner.provider} with candidates ${tied.map((candidate) => candidate.provider).join(", ")}`,
          candidates: tied.map((candidate) => candidate.provider)
        }
      ]
    : [];

  return {
    ok: true,
    definitionId: winner.id,
    provider: winner.provider,
    cloud: winner.cloud,
    driver: winner.driver,
    reason: winner.reason,
    estimatedMonthlyUsd: winner.costMonthlyUsd,
    warnings
  };
}

function compareDefinition(left, right) {
  return descending(left.priority, right.priority) || left.provider.localeCompare(right.provider);
}

function buildDeploymentPlan({ app, tenant, campName, camp, decisions }) {
  const resources = decisions.map(({ resource, decision }) => ({
    id: resource.id,
    name: resource.id,
    port: {
      interface: PORT_INTERFACES[resource.port] ?? `hobo:${resource.port}`,
      type: resource.port,
      className: resource.className ?? "standard"
    },
    provider: {
      id: decision.provider,
      definitionId: decision.definitionId,
      driver: decision.driver
    },
    context: {
      app,
      tenant,
      env: camp.env,
      envType: camp.envType,
      resourceType: resource.port,
      resourceClass: resource.className ?? "standard",
      resourceId: resource.id
    },
    options: {},
    deps: [...(resource.deps ?? [])],
    strategy: "reconcile",
    replication: "single-region",
    workloadProfile: resource.port === "http" ? "wasm-component" : "managed-resource",
    outputs: [...(resource.outputs ?? [])]
  }));

  return {
    apiVersion: DEPLOYMENT_PLAN_IR_VERSION,
    deploymentId: `deploy-${app}-${campName}`,
    resources,
    edges: resources.flatMap((resource) =>
      resource.deps.map((dep) => ({ from: dep, to: resource.id, reason: "binding-output" }))
    ),
    meta: {
      objective: "cost",
      provenance: {
        sourceManifestHash: `sha256:${"1".repeat(64)}`,
        catalogContentHash: `sha256:${"2".repeat(64)}`,
        matchDecisionIds: decisions.map(({ resource, decision }) => `match-${resource.id}-${decision.definitionId}`)
      }
    }
  };
}

function findCrossCloudEdges(decisions) {
  const byResource = new Map(decisions.map(({ resource, decision }) => [resource.id, { resource, decision }]));
  const edges = [];

  for (const { resource, decision } of decisions) {
    for (const dep of resource.deps ?? []) {
      const dependency = byResource.get(dep);
      if (!dependency || dependency.decision.cloud === decision.cloud) {
        continue;
      }

      edges.push({
        from: resource.id,
        to: dep,
        fromProvider: decision.provider,
        toProvider: dependency.decision.provider,
        connectivityTier: "public-mtls"
      });
    }
  }

  return edges;
}

function crossCloudWarning(edge) {
  return {
    code: "cross-cloud-edge",
    resourceId: edge.from,
    message: `cross-cloud edge ${edge.from} -> ${edge.to} uses ${edge.connectivityTier}`,
    edge
  };
}

function nonPortableRawWarnings(resources) {
  return resources.flatMap((resource) =>
    (resource.rawEscapes ?? []).map((rawEscape) => ({
      code: "non-portable-raw",
      resourceId: resource.id,
      message: `non-portable raw() escape on ${resource.id}: ${rawEscape}`,
      rawEscape
    }))
  );
}

function costEstimate(decisions) {
  const monthlyUsd = decisions.reduce((sum, { decision }) => sum + decision.estimatedMonthlyUsd, 0);
  return {
    estimated: true,
    monthlyUsd: Number(monthlyUsd.toFixed(2)),
    currency: "USD",
    assumptions: [...COST_ASSUMPTIONS]
  };
}

function formatCurrency(value) {
  return `$${Number(value).toFixed(2)}`;
}

function descending(left, right) {
  return left > right ? -1 : left < right ? 1 : 0;
}
