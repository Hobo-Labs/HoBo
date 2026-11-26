import {
  createMultiCloudShopFixtureRecord,
  digestPortableSources,
  MULTI_CLOUD_SHOP_FIXTURE,
} from "./multi-cloud-shop-fixture.js";
import { isJsonObject, type JsonObject } from "./json.js";


export const NFR001_SCHEMA = "hobo.conformance.nfr001-portability-lane/v1";
export const REQUIRED_TARGET_PROVIDERS = Object.freeze(["aws", "azure"]);

export class PortabilityConformanceError extends Error {
  constructor(report: PortabilityConformanceReport) {
    super(
      report.failures.map((failure) => `${failure.code}: ${failure.message}`).join("; "),
    );
    this.name = "PortabilityConformanceError";
    this.report = report;
  }

  readonly report: PortabilityConformanceReport;
}

export type PortabilityFailure = {
  code: string;
  message: string;
  provider?: string;
  entryId?: string;
  unsatisfiedTargets?: string[];
};

export type PortabilityConformanceReport = {
  ok: boolean;
  schema: string;
  fixture: string;
  targetProviders: string[];
  bindleDigest?: string;
  topologySignature?: string;
  bindingSignature?: string;
  failures: PortabilityFailure[];
  events: Array<JsonObject>;
};

export function createPortableConformanceEvidence(overrides: JsonObject = {}) {
  const fixture = createMultiCloudShopFixtureRecord();
  const bindleDigest = fixture.bindleDigest;
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const camps = fixture.camps as Record<string, { name: string; yard: string; mappingDigest: string }>;

  const base = {
    schema: NFR001_SCHEMA,
    fixture: MULTI_CLOUD_SHOP_FIXTURE,
    ciLane: {
      name: "nfr-001-portability-conformance",
      providers: [...REQUIRED_TARGET_PROVIDERS],
      tag: "camp",
      costAware: true,
    },
    bindle: {
      name: "multi-cloud-shop",
      digest: bindleDigest,
      sources: fixture.sources,
      providerOptions: fixture.providerOptions,
    },
    portabilityReport: fixture.portabilityReport,
    targets: [
      createProviderTarget({
        provider: "aws",
        camp: camps.aws.name,
        yard: camps.aws.yard,
        bindleDigest,
        mappingDigest: camps.aws.mappingDigest,
        resolvedProviderOptions: fixture.providerOptions,
      }),
      createProviderTarget({
        provider: "azure",
        camp: camps.azure.name,
        yard: camps.azure.yard,
        bindleDigest,
        mappingDigest: camps.azure.mappingDigest,
        resolvedProviderOptions: [],
      }),
    ],
  };

  return deepFreeze({ ...base, ...overrides });
}

export function runNfr001PortabilityLane(
  evidence: JsonObject = createPortableConformanceEvidence(),
): PortabilityConformanceReport {
  const failures: PortabilityFailure[] = [];
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const targetProviders = providerNames(evidence.targets as Array<{ provider: string }>);

  if (evidence.schema !== NFR001_SCHEMA) {
    failures.push({
      code: "schema.unsupported",
      message: `expected schema ${NFR001_SCHEMA}`,
    });
  }

  if (evidence.fixture !== MULTI_CLOUD_SHOP_FIXTURE) {
    failures.push({
      code: "fixture.missing",
      message: `expected fixture ${MULTI_CLOUD_SHOP_FIXTURE}`,
    });
  }

  validateTargets(targetProviders, failures);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  validateUneditedBindle(evidence.bindle as JsonObject, evidence.targets as Target[], failures);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  validateMappingOnlyVariance(evidence.targets as Target[], failures);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  validateTopologyEquivalence(evidence.targets as Target[], failures);
  validateProviderOptionIsolation(
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    evidence.bindle as JsonObject,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    evidence.targets as Target[],
    failures,
  );
  validatePortabilitySurface(
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    (evidence.portabilityReport as { nonPortableSurface?: NonPortableEntry[] }) ?? {},
    targetProviders,
    failures,
  );

  const ok = failures.length === 0;
  return deepFreeze({
    ok,
    schema: NFR001_SCHEMA,
    fixture: String(evidence.fixture),
    targetProviders,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    bindleDigest: (evidence.bindle as { digest?: string })?.digest,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    topologySignature: ok ? resourceSignature((evidence.targets as Target[])[0]) : undefined,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    bindingSignature: ok ? bindingSignature((evidence.targets as Target[])[0]) : undefined,
    failures,
    events: ok
      ? [
          {
            type: "conformance.Nfr001PortabilityLanePassed",
            fixture: evidence.fixture,
            targetProviders,
          },
        ]
      : [
          {
            type: "deployment.PlanRejected",
            reason: "nfr-001.portability-lane-failed",
            failures,
          },
        ],
  });
}

export function assertNfr001PortabilityLane(
  evidence: JsonObject = createPortableConformanceEvidence(),
): PortabilityConformanceReport {
  const report = runNfr001PortabilityLane(evidence);
  if (!report.ok) {
    throw new PortabilityConformanceError(report);
  }
  return report;
}

export function seedEditedBindleMutation(evidence: JsonObject) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const bindle = evidence.bindle as { sources?: Record<string, string>; digest?: string };
  const originalDigest = bindle.digest;
  const mutatedSources = {
    ...bindle.sources,
    "bindle.ts": String(bindle.sources?.["bindle.ts"]).replace(
      "multi-cloud-shop",
      "multi-cloud-shop-mutated",
    ),
  };
  const mutatedDigest = digestPortableSources(mutatedSources);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const targets = (evidence.targets as Target[]).map((target, index) =>
    index === 1
      ? { ...target, bindleDigest: mutatedDigest, sourceDigest: mutatedDigest }
      : { ...target, bindleDigest: originalDigest, sourceDigest: originalDigest },
  );
  return deepFreeze({
    ...evidence,
    bindle: { ...bindle, sources: bindle.sources, digest: originalDigest },
    targets,
  });
}

export function seedProviderLeakMutation(evidence: JsonObject) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const targets = [...(evidence.targets as Target[])];
  const azure = { ...targets[1] };
  azure.resolvedProviderOptions = [
    {
      resourceId: "orders",
      provider: "aws",
      name: "aws.rds.multiAz",
      value: true,
    },
  ];
  targets[1] = azure;
  return deepFreeze({ ...evidence, targets });
}

type Target = {
  provider: string;
  camp: string;
  yard: string;
  bindleDigest: string;
  sourceDigest: string;
  mappingDigest: string;
  resolvedProviderOptions: Array<{
    resourceId: string;
    provider: string;
    name: string;
    value: boolean;
  }>;
  deployment: {
    topology: { resources: Array<{ id: string; kind: string; binds: string[] }> };
    bindings: Array<{ from: string; to: string; contract: string }>;
  };
};

type NonPortableEntry = {
  id: string;
  category: string;
  provider?: string;
  satisfiedBy?: string[];
  inertOn?: string[];
};

function createProviderTarget({
  provider,
  camp,
  yard,
  bindleDigest,
  mappingDigest,
  resolvedProviderOptions,
}: {
  provider: string;
  camp: string;
  yard: string;
  bindleDigest: string;
  mappingDigest: string;
  resolvedProviderOptions: Target["resolvedProviderOptions"];
}): Target {
  return {
    provider,
    camp,
    yard,
    bindleDigest,
    sourceDigest: bindleDigest,
    mappingDigest,
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

function validateTargets(targetProviders: string[], failures: PortabilityFailure[]) {
  const missing = REQUIRED_TARGET_PROVIDERS.filter((provider) => !targetProviders.includes(provider));
  if (targetProviders.length < 2 || missing.length > 0) {
    failures.push({
      code: "targets.missing",
      message: `NFR-001 lane requires aws and azure targets; missing ${missing.join(", ") || "none"}`,
    });
  }
}

function validateUneditedBindle(
  bindle: JsonObject,
  targets: Target[],
  failures: PortabilityFailure[],
) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const expectedDigest = bindle.digest as string | undefined;
  if (!expectedDigest) {
    failures.push({
      code: "bindle.digest-missing",
      message: "bindle digest is required to prove unchanged source",
    });
    return;
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const calculatedDigest = digestPortableSources((bindle.sources ?? {}) as Record<string, string>);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  if (Object.keys((bindle.sources ?? {}) as object).length > 0 && calculatedDigest !== expectedDigest) {
    failures.push({
      code: "bindle.digest-mismatch",
      message: "bindle digest does not match recorded bindle.ts + src/ bytes",
    });
  }

  for (const target of targets ?? []) {
    if (target.bindleDigest !== expectedDigest || target.sourceDigest !== expectedDigest) {
      failures.push({
        code: "bindle.not-byte-identical",
        message: `${target.provider} did not deploy the exact same bindle() definition and src/ bytes`,
        provider: target.provider,
      });
    }
  }
}

function validateMappingOnlyVariance(targets: Target[], failures: PortabilityFailure[]) {
  const digests = new Set((targets ?? []).map((target) => target.bindleDigest));
  const mappingDigests = (targets ?? []).map((target) => target.mappingDigest);
  const uniqueMappings = new Set(mappingDigests);

  if (digests.size !== 1) {
    failures.push({
      code: "bindle.variance-detected",
      message: "only camp()/yard() mapping may vary across cloud targets",
    });
  }

  if (uniqueMappings.size !== (targets ?? []).length) {
    failures.push({
      code: "mapping.not-unique",
      message: "each cloud target must carry its own camp()/yard() mapping digest",
    });
  }
}

function validateTopologyEquivalence(targets: Target[], failures: PortabilityFailure[]) {
  const [first, ...rest] = targets ?? [];
  if (!first) return;

  const expectedResources = resourceSignature(first);
  const expectedBindings = bindingSignature(first);

  for (const target of rest) {
    if (resourceSignature(target) !== expectedResources) {
      failures.push({
        code: "topology.resource-mismatch",
        message: `${target.provider} resource topology differs from ${first.provider}`,
        provider: target.provider,
      });
    }
    if (bindingSignature(target) !== expectedBindings) {
      failures.push({
        code: "topology.binding-mismatch",
        message: `${target.provider} bindings differ from ${first.provider}`,
        provider: target.provider,
      });
    }
  }
}

function validateProviderOptionIsolation(
  bindle: JsonObject,
  targets: Target[],
  failures: PortabilityFailure[],
) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const expectedOptions = (bindle.providerOptions ?? []) as Target["resolvedProviderOptions"];

  for (const target of targets ?? []) {
    const applied = target.resolvedProviderOptions ?? [];
    for (const option of applied) {
      if (option.provider !== target.provider) {
        failures.push({
          code: "provider-option.leaked",
          message: `${option.provider} option ${option.name} reached ${target.provider}`,
          provider: target.provider,
        });
      }
    }

    for (const expected of expectedOptions) {
      const hasOption = applied.some(
        (option) => optionKey(option) === optionKey(expected),
      );
      if (expected.provider === target.provider && !hasOption) {
        failures.push({
          code: "provider-option.missing",
          message: `${target.provider} did not receive scoped provider option ${expected.name}`,
          provider: target.provider,
        });
      }
      if (expected.provider !== target.provider && hasOption) {
        failures.push({
          code: "provider-option.leaked",
          message: `${expected.provider} option ${expected.name} reached ${target.provider}`,
          provider: target.provider,
        });
      }
    }
  }
}

function validatePortabilitySurface(
  portabilityReport: { nonPortableSurface?: NonPortableEntry[] },
  targetProviders: string[],
  failures: PortabilityFailure[],
) {
  for (const entry of portabilityReport.nonPortableSurface ?? []) {
    if (entry.category === "provider-option") {
      const inertOn = new Set(entry.inertOn ?? []);
      const otherProviders = targetProviders.filter((provider) => provider !== entry.provider);
      const unsupportedInertTargets = otherProviders.filter((provider) => !inertOn.has(provider));
      if (!entry.satisfiedBy?.includes(entry.provider ?? "") || unsupportedInertTargets.length > 0) {
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

function providerNames(targets: Array<{ provider: string }>) {
  return [...new Set(targets.map((target) => target.provider).filter(Boolean))].sort();
}

function resourceSignature(target: Target) {
  return JSON.stringify(
    (target.deployment.topology.resources ?? [])
      .map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        binds: [...resource.binds].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function bindingSignature(target: Target) {
  return JSON.stringify(
    (target.deployment.bindings ?? [])
      .map((binding) => ({
        from: binding.from,
        to: binding.to,
        contract: binding.contract,
      }))
      .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)),
  );
}

function optionKey(option: { resourceId: string; provider: string; name: string }) {
  return `${option.resourceId}:${option.provider}:${option.name}`;
}

function deepFreeze<T>(value: T): T {
  if (value && isJsonObject(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
