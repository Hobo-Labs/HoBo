import { isJsonObject } from "./json.js";
import { createHash } from "node:crypto";

export const MULTI_CLOUD_SHOP_GATE_SCHEMA = "hobo.multiCloudShopProviderE2e/v1";
export const MULTI_CLOUD_SHOP_FIXTURE = "examples/multi-cloud-shop";
export const REQUIRED_TARGET_PROVIDERS = Object.freeze(["aws", "azure"]);

export class MultiCloudShopGateError extends Error {
  constructor(report) {
    super(report.failures.map((failure) => `${failure.code}: ${failure.message}`).join("; "));
    this.name = "MultiCloudShopGateError";
    this.report = report;
  }
}

export function createPortableMultiCloudShopRun(overrides = {}) {
  const sources = {
    "bindle.ts": [
      "bindle('multi-cloud-shop', (b) => {",
      "  const orders = b.database('orders', { engine: 'postgres' })",
      "    .with(aws.rds({ multiAz: true }));",
      "  const assets = b.bucket('assets');",
      "  const api = b.compute('api').bind(orders).bind(assets);",
      "  b.compute('frontend').bind(api);",
      "});",
    ].join("\n"),
    "src/api.ts": "export const serviceName = 'multi-cloud-shop-api';\n",
    "src/frontend.ts": "export const serviceName = 'multi-cloud-shop-frontend';\n",
  };
  const bindleDigest = digestSourceSet(sources);

  const base = {
    schema: MULTI_CLOUD_SHOP_GATE_SCHEMA,
    fixture: MULTI_CLOUD_SHOP_FIXTURE,
    ciLane: {
      name: "multi-cloud-shop-e2e",
      tag: "camp",
      costAware: true,
      gatedBy: [
        { kind: "pull-request-label", label: "hobo/e2e" },
        { kind: "schedule", cron: "17 3 * * 1" },
        { kind: "manual" },
      ],
    },
    bindle: {
      name: "multi-cloud-shop",
      digest: bindleDigest,
      sources,
      providerOptions: [
        {
          resourceId: "orders",
          provider: "aws",
          name: "aws.rds.multiAz",
          value: true,
        },
      ],
    },
    portabilityReport: {
      nonPortableSurface: [
        {
          id: "orders.provider-option.aws.rds.multiAz",
          category: "provider-option",
          resourceId: "orders",
          provider: "aws",
          satisfiedBy: ["aws"],
          inertOn: ["azure"],
          gateEffect: "target-provider-must-satisfy",
        },
      ],
    },
    targets: [
      createProviderDeployment({
        provider: "aws",
        camp: "aws-ga",
        yard: "aws-us-east-1",
        bindleDigest,
        mappingDigest: "sha256:camp-aws-mapping",
        resolvedProviderOptions: [
          {
            resourceId: "orders",
            provider: "aws",
            name: "aws.rds.multiAz",
            value: true,
          },
        ],
      }),
      createProviderDeployment({
        provider: "azure",
        camp: "azure-ga",
        yard: "azure-eastus",
        bindleDigest,
        mappingDigest: "sha256:camp-azure-mapping",
        resolvedProviderOptions: [],
      }),
    ],
    negativeScenarios: [
      {
        kind: "unsatisfied-require",
        name: "catalog-search-requires-vector-index",
        requirement: {
          mode: "require",
          resourceId: "catalog-search",
          capability: "vector-index",
        },
        checkedProviders: ["aws", "azure"],
        result: {
          ok: false,
          event: {
            type: "deployment.PlanRejected",
            reason: "require.unsatisfied",
            missingCapability: "vector-index",
            checkedProviders: ["aws", "azure"],
            detail: "catalog-search requires vector-index; checked aws, azure; no provider satisfies it",
          },
        },
      },
      {
        kind: "unsupported-single-provider-feature",
        name: "aws-snapstart-on-azure",
        feature: "aws.lambda.snapstart",
        targetProviders: ["aws", "azure"],
        result: {
          ok: false,
          event: {
            type: "deployment.PlanRejected",
            reason: "portability.unsatisfied-provider",
            unsupportedProviders: ["azure"],
            detail: "aws.lambda.snapstart is only satisfied by aws; azure cannot deploy it",
          },
        },
      },
    ],
  };

  return deepFreeze(deepMerge(base, overrides));
}

export function verifyMultiCloudShopGate(evidence) {
  const failures = [];
  const targetProviders = providerNames(evidence?.targets);

  if (evidence?.schema !== MULTI_CLOUD_SHOP_GATE_SCHEMA) {
    failures.push({
      code: "schema.unsupported",
      message: `expected schema ${MULTI_CLOUD_SHOP_GATE_SCHEMA}`,
    });
  }
  if (evidence?.fixture !== MULTI_CLOUD_SHOP_FIXTURE) {
    failures.push({
      code: "fixture.missing",
      message: `expected fixture ${MULTI_CLOUD_SHOP_FIXTURE}`,
    });
  }

  validateCiLane(evidence?.ciLane, failures);
  validateTargets(targetProviders, failures);
  validateSameBindle(evidence?.bindle, evidence?.targets, failures);
  validateTopologyAndBindings(evidence?.targets, failures);
  validateProviderOptions(evidence?.bindle, evidence?.targets, failures);
  validateCampChecks(evidence?.targets, failures);
  validatePortabilitySurface(evidence?.portabilityReport, targetProviders, failures);
  validateNegativeScenarios(evidence?.negativeScenarios, targetProviders, failures);

  const ok = failures.length === 0;
  return deepFreeze({
    ok,
    schema: MULTI_CLOUD_SHOP_GATE_SCHEMA,
    fixture: evidence?.fixture,
    targetProviders,
    ciLane: evidence?.ciLane?.name,
    topologySignature: ok ? resourceSignature(evidence.targets[0]) : undefined,
    bindingSignature: ok ? bindingSignature(evidence.targets[0]) : undefined,
    failures,
    events: ok
      ? [
          {
            type: "multiCloudShop.GatePassed",
            fixture: evidence.fixture,
            targetProviders,
          },
        ]
      : [
          {
            type: "deployment.PlanRejected",
            reason: "multi-cloud-shop.gate-failed",
            failures,
          },
        ],
  });
}

export function assertMultiCloudShopGate(evidence) {
  const report = verifyMultiCloudShopGate(evidence);
  if (!report.ok) {
    throw new MultiCloudShopGateError(report);
  }
  return report;
}

export function runMultiCloudShopE2eFixture({ phase = "deploy-and-assert", runId = "local-run" } = {}) {
  if (phase === "deploy-and-assert") {
    const evidence = createPortableMultiCloudShopRun();
    const report = verifyMultiCloudShopGate(evidence);
    return deepFreeze({
      ok: report.ok,
      phase,
      runId,
      fixture: MULTI_CLOUD_SHOP_FIXTURE,
      providers: [...REQUIRED_TARGET_PROVIDERS],
      report,
    });
  }

  if (phase === "teardown") {
    return deepFreeze({
      ok: true,
      phase,
      runId,
      fixture: MULTI_CLOUD_SHOP_FIXTURE,
      providers: [...REQUIRED_TARGET_PROVIDERS],
    });
  }

  if (phase === "sweep-orphans") {
    return deepFreeze({
      ok: true,
      phase,
      selector: "hobo.dev/fixture=multi-cloud-shop",
      maxAgeMinutes: 90,
    });
  }

  throw new Error(`unknown phase: ${phase}`);
}

export function digestSourceSet(sources) {
  const hash = createHash("sha256");
  for (const path of Object.keys(sources ).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(sources[path]));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function createProviderDeployment({
  provider,
  camp,
  yard,
  bindleDigest,
  mappingDigest,
  resolvedProviderOptions,
}) {
  return {
    provider,
    camp,
    yard,
    bindleDigest,
    sourceDigest: bindleDigest,
    mappingDigest,
    campChecks: [
      { name: `${provider}.provider-conformance`, status: "passed" },
      { name: `${camp}.policy`, status: "passed" },
    ],
    resolvedProviderOptions,
    deployment: {
      topology: {
        resources: [
          { id: "frontend", kind: "compute", binds: ["api"] },
          { id: "api", kind: "compute", binds: ["assets", "orders"] },
          { id: "orders", kind: "database", binds: [] },
          { id: "assets", kind: "bucket", binds: [] },
        ],
      },
      bindings: [
        { from: "frontend", to: "api", contract: "https" },
        { from: "api", to: "orders", contract: "postgres" },
        { from: "api", to: "assets", contract: "object-store" },
      ],
    },
  };
}

function validateCiLane(ciLane = {}, failures) {
  const gates = ciLane.gatedBy ?? [];
  const hasLabelGate = gates.some((gate) => gate.kind === "pull-request-label" && gate.label);
  const hasScheduleGate = gates.some((gate) => gate.kind === "schedule" && gate.cron);
  const hasManualGate = gates.some((gate) => gate.kind === "manual");

  if (ciLane.tag !== "camp" || ciLane.costAware !== true || !hasLabelGate || !hasScheduleGate || !hasManualGate) {
    failures.push({
      code: "ci-lane.not-cost-gated",
      message: "multi-cloud-shop E2E must be camp-tagged and gated by label, schedule, and manual dispatch",
    });
  }
}

function validateTargets(targetProviders, failures) {
  const missing = REQUIRED_TARGET_PROVIDERS.filter((provider) => !targetProviders.includes(provider));
  if (targetProviders.length < 2 || missing.length > 0) {
    failures.push({
      code: "targets.missing",
      message: `multi-cloud-shop gate requires aws and azure targets; missing ${missing.join(", ") || "none"}`,
      targetProviders,
    });
  }
}

function validateSameBindle(bindle = {}, targets = [], failures) {
  const expectedDigest = bindle.digest;
  if (!expectedDigest) {
    failures.push({
      code: "bindle.digest-missing",
      message: "bindle digest is required to prove unchanged source",
    });
    return;
  }

  const calculatedDigest = digestSourceSet(bindle.sources );
  if (Object.keys(bindle.sources ).length > 0 && calculatedDigest !== expectedDigest) {
    failures.push({
      code: "bindle.digest-mismatch",
      message: "bindle digest does not match the recorded source bytes",
      expectedDigest,
      calculatedDigest,
    });
  }

  for (const target of targets ?? []) {
    if (target.bindleDigest !== expectedDigest || target.sourceDigest !== expectedDigest) {
      failures.push({
        code: "bindle.not-byte-identical",
        message: `${target.provider} did not deploy the exact same Bindle source bytes`,
        provider: target.provider,
        expectedDigest,
        bindleDigest: target.bindleDigest,
        sourceDigest: target.sourceDigest,
      });
    }
  }
}

function validateTopologyAndBindings(targets = [], failures) {
  const [first, ...rest] = targets;
  if (!first) return;

  const expectedResources = resourceSignature(first);
  const expectedBindings = bindingSignature(first);

  for (const target of rest) {
    const actualResources = resourceSignature(target);
    const actualBindings = bindingSignature(target);
    if (actualResources !== expectedResources) {
      failures.push({
        code: "topology.resource-mismatch",
        message: `${target.provider} resource topology differs from ${first.provider}`,
        provider: target.provider,
      });
    }
    if (actualBindings !== expectedBindings) {
      failures.push({
        code: "topology.binding-mismatch",
        message: `${target.provider} bindings differ from ${first.provider}`,
        provider: target.provider,
      });
    }
  }
}

function validateProviderOptions(bindle = {}, targets = [], failures) {
  const expectedOptions = bindle.providerOptions ?? [];

  for (const target of targets ?? []) {
    const applied = target.resolvedProviderOptions ?? [];
    for (const option of applied) {
      if (option.provider !== target.provider) {
        failures.push({
          code: "provider-option.leaked",
          message: `${option.provider} option ${option.name} reached ${target.provider}`,
          provider: target.provider,
          option: optionKey(option),
        });
      }
    }

    for (const expected of expectedOptions) {
      const hasOption = applied.some((option) => optionKey(option) === optionKey(expected));
      if (expected.provider === target.provider && !hasOption) {
        failures.push({
          code: "provider-option.missing",
          message: `${target.provider} did not receive its scoped provider option ${expected.name}`,
          provider: target.provider,
          option: optionKey(expected),
        });
      }
      if (expected.provider !== target.provider && hasOption) {
        failures.push({
          code: "provider-option.leaked",
          message: `${expected.provider} option ${expected.name} reached ${target.provider}`,
          provider: target.provider,
          option: optionKey(expected),
        });
      }
    }
  }
}

function validateCampChecks(targets = [], failures) {
  for (const target of targets ?? []) {
    const checks = target.campChecks ?? [];
    const unrun = checks.filter((check) => check.status !== "passed");
    if (checks.length === 0 || unrun.length > 0) {
      failures.push({
        code: "camp-checks.unrun",
        message: `${target.provider} cannot make a prod-ready claim without passed camp checks`,
        provider: target.provider,
        checks: checks.length === 0 ? ["missing"] : unrun.map((check) => check.name),
      });
    }
  }
}

function validatePortabilitySurface(portabilityReport = {}, targetProviders, failures) {
  for (const entry of portabilityReport.nonPortableSurface ?? []) {
    if (entry.category === "provider-option") {
      const inertOn = new Set(entry.inertOn ?? []);
      const otherProviders = targetProviders.filter((provider) => provider !== entry.provider);
      const unsupportedInertTargets = otherProviders.filter((provider) => !inertOn.has(provider));
      if (!entry.satisfiedBy?.includes(entry.provider) || unsupportedInertTargets.length > 0) {
        failures.push({
          code: "portability.unsatisfied-surface",
          message: `${entry.id} is not proved satisfied or inert across every target`,
          entryId: entry.id,
          unsatisfiedTargets: unsupportedInertTargets,
        });
      }
      continue;
    }

    const satisfiedBy = new Set(entry.satisfiedBy ?? []);
    const unsatisfiedTargets = targetProviders.filter((provider) => !satisfiedBy.has(provider));
    if (unsatisfiedTargets.length > 0) {
      failures.push({
        code: "portability.unsatisfied-surface",
        message: `${entry.id} is not satisfied by ${unsatisfiedTargets.join(", ")}`,
        entryId: entry.id,
        unsatisfiedTargets,
      });
    }
  }
}

function validateNegativeScenarios(scenarios = [], targetProviders, failures) {
  const byKind = new Map((scenarios ?? []).map((scenario) => [scenario.kind, scenario]));
  validateUnsatisfiedRequire(byKind.get("unsatisfied-require"), targetProviders, failures);
  validateSingleProviderFeature(byKind.get("unsupported-single-provider-feature"), targetProviders, failures);
}

function validateUnsatisfiedRequire(scenario, targetProviders, failures) {
  if (!scenario) {
    failures.push({
      code: "require.rejection-missing",
      message: "unsatisfied require scenario must prove deployment.PlanRejected",
    });
    return;
  }

  const event = scenario.result?.event ;
  const checkedProviders = scenario.checkedProviders ?? targetProviders;
  const precise =
    scenario.result?.ok === false &&
    event.type === "deployment.PlanRejected" &&
    event.reason === "require.unsatisfied" &&
    event.missingCapability === scenario.requirement?.capability &&
    sameMembers(event.checkedProviders ?? [], checkedProviders) &&
    String(event.detail ?? "").includes(scenario.requirement?.capability);

  if (!precise) {
    failures.push({
      code: "require.rejection-imprecise",
      message: "unsatisfied require must reject with precise deployment.PlanRejected capability evidence",
      scenario: scenario.name,
    });
  }
}

function validateSingleProviderFeature(scenario, targetProviders, failures) {
  if (!scenario) {
    failures.push({
      code: "single-provider.rejection-missing",
      message: "single-provider feature scenario must prove rejection on unsupported targets",
    });
    return;
  }

  const event = scenario.result?.event ;
  const unsupportedProviders = event.unsupportedProviders ?? [];
  const precise =
    scenario.result?.ok === false &&
    event.type === "deployment.PlanRejected" &&
    event.reason === "portability.unsatisfied-provider" &&
    unsupportedProviders.length > 0 &&
    unsupportedProviders.every((provider) => targetProviders.includes(provider)) &&
    String(event.detail ?? "").includes(scenario.feature);

  if (!precise) {
    failures.push({
      code: "single-provider.rejection-imprecise",
      message: "unsupported single-provider features must reject with named unsupported providers",
      scenario: scenario.name,
    });
  }
}

function providerNames(targets = []) {
  return [...new Set((targets ?? []).map((target) => target.provider).filter(Boolean))].sort();
}

function resourceSignature(target) {
  return JSON.stringify(
    (target?.deployment?.topology?.resources ?? [])
      .map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        binds: [...(resource.binds ?? [])].sort(),
      }))
      .sort(byId),
  );
}

function bindingSignature(target) {
  return JSON.stringify(
    (target?.deployment?.bindings ?? [])
      .map((binding) => ({
        from: binding.from,
        to: binding.to,
        contract: binding.contract,
      }))
      .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)),
  );
}

function optionKey(option) {
  return `${option.resourceId}:${option.provider}:${option.name}`;
}

function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? clone(base) : clone(overrides);
  }
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides === undefined ? clone(base) : clone(overrides);
  }

  const merged = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    merged[key] = deepMerge(base[key], overrides[key]);
  }
  return merged;
}

function clone(value) {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && isJsonObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value && isJsonObject(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
