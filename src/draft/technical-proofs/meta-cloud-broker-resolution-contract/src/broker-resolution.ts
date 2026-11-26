import { createHash } from "node:crypto";
import { isJsonObject, type JsonValue } from "./json.js";


export const RESOLUTION_RECEIPT_SCHEMA = "hobo.resolution-receipt/v1";
export const RESOLUTION_REJECTION_SCHEMA = "hobo.resolution-rejection/v1";
export const BROKER_AUTHORITY = "meta-cloud-broker";

export type ContractManifest = Readonly<{
  schema: "hobo.contract-manifest/v1";
  manifestId: string;
  manifestDigest: string;
  resources: readonly ManifestResource[];
}>;

export type ManifestResource = Readonly<{
  resourceId: string;
  interface: string;
  requiredFeatures: readonly string[];
  action: "provision" | "deploy" | "bind";
}>;

export type BrokerEnvironment = Readonly<{
  schema: "hobo.broker-environment/v1";
  snapshotId: string;
  environmentDigest: string;
  catalogDigest: string;
  mappings: readonly MappingContract[];
  catalog: readonly CatalogCapability[];
}>;

export type MappingContract = Readonly<{
  mappingId: string;
  resourceId: string;
  capabilityId: string;
  provider: string;
  approved: boolean;
}>;

export type CatalogCapability = Readonly<{
  capabilityId: string;
  provider: string;
  interface: string;
  features: readonly string[];
  approved: boolean;
  compatible: boolean;
  available: boolean;
  defaultForInterface?: boolean;
}>;

export type ResourcePlan = Readonly<{
  resourceId: string;
  provider: string;
  capabilityId: string;
  action: "provision" | "deploy" | "bind";
}>;

export type ResolutionReceipt = Readonly<{
  schema: typeof RESOLUTION_RECEIPT_SCHEMA;
  receiptId: string;
  resolutionAuthority: typeof BROKER_AUTHORITY;
  manifestId: string;
  environmentSnapshotId: string;
  manifestDigest: string;
  environmentDigest: string;
  catalogSnapshotDigest: string;
  issuedAt: string;
  resourcePlans: readonly ResourcePlan[];
  replay: ReplayEvidence;
  digest: string;
  signature: string;
}>;

export type ResolutionRejection = Readonly<{
  schema: typeof RESOLUTION_REJECTION_SCHEMA;
  rejectionId: string;
  resolutionAuthority: typeof BROKER_AUTHORITY;
  manifestDigest: string;
  environmentDigest: string;
  catalogSnapshotDigest: string;
  reason: Readonly<{
    code: "mapping.ambiguous" | "mapping.incompatible" | "mapping.unavailable";
    message: string;
    details: readonly string[];
  }>;
  replay: ReplayEvidence;
  fallbackAttempted: false;
  digest: string;
  signature: string;
}>;

export type ReplayEvidence = Readonly<{
  inputs: Readonly<{
    manifestDigest: string;
    environmentDigest: string;
    catalogSnapshotDigest: string;
  }>;
}>;

export type ResolutionResult =
  | Readonly<{ ok: true; receipt: ResolutionReceipt }>
  | Readonly<{ ok: false; rejection: ResolutionRejection }>;

type ResolveInput = Readonly<{
  manifest: ContractManifest;
  environment: BrokerEnvironment;
  yardFallbackResolver?: () => JsonValue;
}>;

type EnvironmentOverrides = Partial<
  Pick<BrokerEnvironment, "snapshotId" | "environmentDigest" | "catalogDigest" | "mappings" | "catalog">
>;

export function buildAcceptedManifestFixture(): ContractManifest {
  return deepFreeze({
    schema: "hobo.contract-manifest/v1",
    manifestId: "orders-prod",
    manifestDigest: "sha256:manifest-orders-prod",
    resources: [
      {
        resourceId: "orders-db",
        interface: "hobo:database/postgres",
        requiredFeatures: ["ha", "managed"],
        action: "provision",
      },
      {
        resourceId: "orders-cache",
        interface: "hobo:cache/kv",
        requiredFeatures: ["edge"],
        action: "provision",
      },
    ],
  });
}

export function buildBrokerEnvironmentFixture(overrides: EnvironmentOverrides = {}): BrokerEnvironment {
  return deepFreeze({
    schema: "hobo.broker-environment/v1",
    snapshotId: overrides.snapshotId ?? "broker-env-prod",
    environmentDigest: overrides.environmentDigest ?? "sha256:broker-env-prod",
    catalogDigest: overrides.catalogDigest ?? "sha256:catalog-prod",
    mappings: clone(overrides.mappings ?? acceptedMappings()),
    catalog: clone(overrides.catalog ?? acceptedCatalog()),
  });
}

export function buildAmbiguousEnvironmentFixture({ reverseMappings = false } = {}): BrokerEnvironment {
  const mappings = [
    ...acceptedMappings(),
    {
      mappingId: "map-orders-db-azure",
      resourceId: "orders-db",
      capabilityId: "azure.postgres.ha",
      provider: "provider.azure",
      approved: true,
    },
  ];

  return buildBrokerEnvironmentFixture({
    mappings: reverseMappings ? mappings.reverse() : mappings,
    catalog: [
      ...acceptedCatalog(),
      {
        capabilityId: "azure.postgres.ha",
        provider: "provider.azure",
        interface: "hobo:database/postgres",
        features: ["ha", "managed"],
        approved: true,
        compatible: true,
        available: true,
      },
    ],
  });
}

export function buildIncompatibleEnvironmentFixture(): BrokerEnvironment {
  return buildBrokerEnvironmentFixture({
    mappings: [
      {
        mappingId: "map-orders-db-basic",
        resourceId: "orders-db",
        capabilityId: "azure.postgres.basic",
        provider: "provider.azure",
        approved: true,
      },
      acceptedMappings()[1],
    ],
    catalog: [
      {
        capabilityId: "azure.postgres.basic",
        provider: "provider.azure",
        interface: "hobo:database/postgres",
        features: ["managed"],
        approved: true,
        compatible: true,
        available: true,
      },
      acceptedCatalog()[1],
    ],
  });
}

export function buildUnavailableEnvironmentFixture({
  catalogIncludesImplicitDefault = false,
}: {
  catalogIncludesImplicitDefault?: boolean;
} = {}): BrokerEnvironment {
  const catalog = catalogIncludesImplicitDefault
    ? [
        ...acceptedCatalog(),
        {
          capabilityId: "aws.postgres.default",
          provider: "provider.aws",
          interface: "hobo:database/postgres",
          features: ["ha", "managed"],
          approved: true,
          compatible: true,
          available: true,
          defaultForInterface: true,
        },
      ]
    : [acceptedCatalog()[1]];

  return buildBrokerEnvironmentFixture({
    mappings: [acceptedMappings()[1]],
    catalog,
  });
}

export function resolveBrokerManifest({
  manifest,
  environment,
  yardFallbackResolver: _yardFallbackResolver,
}: ResolveInput): ResolutionResult {
  const replay = replayEvidence(manifest, environment);
  const plans: ResourcePlan[] = [];

  for (const resource of manifest.resources) {
    const mappings = sortedBy(
      environment.mappings.filter((mapping) => mapping.resourceId === resource.resourceId && mapping.approved),
      (entry) => `${entry.capabilityId}:${entry.mappingId}`,
    );

    if (mappings.length === 0) {
      return reject({
        code: "mapping.unavailable",
        message: `no approved broker mapping for ${resource.resourceId}`,
        details: unavailableDetails(resource, environment),
        replay,
      });
    }

    const evaluated = mappings.map((mapping) => evaluateMapping(resource, mapping, environment));
    const compatible = evaluated.filter((entry) => entry.ok);

    if (compatible.length > 1) {
      return reject({
        code: "mapping.ambiguous",
        message: `multiple approved broker mappings for ${resource.resourceId}`,
        details: compatible
          .map((entry) => `${resource.resourceId}:${entry.plan.provider}:${entry.plan.capabilityId}`)
          .sort(),
        replay,
      });
    }

    if (compatible.length === 0) {
      const unavailable = evaluated.filter((entry) => entry.code === "mapping.unavailable");
      const incompatible = evaluated.filter((entry) => entry.code === "mapping.incompatible");
      const code = unavailable.length > 0 && incompatible.length === 0 ? "mapping.unavailable" : "mapping.incompatible";
      return reject({
        code,
        message: `${code} for ${resource.resourceId}`,
        details: evaluated.flatMap((entry) => entry.details).sort(),
        replay,
      });
    }

    plans.push(compatible[0].plan);
  }

  return {
    ok: true,
    receipt: signedReceipt({
      schema: RESOLUTION_RECEIPT_SCHEMA,
      receiptId: stableId("receipt", {
        manifestDigest: manifest.manifestDigest,
        environmentDigest: environment.environmentDigest,
        catalogSnapshotDigest: environment.catalogDigest,
        plans,
      }),
      resolutionAuthority: BROKER_AUTHORITY,
      manifestId: manifest.manifestId,
      environmentSnapshotId: environment.snapshotId,
      manifestDigest: manifest.manifestDigest,
      environmentDigest: environment.environmentDigest,
      catalogSnapshotDigest: environment.catalogDigest,
      issuedAt: "2026-06-30T00:00:00.000Z",
      resourcePlans: plans,
      replay,
    }),
  };
}

function evaluateMapping(
  resource: ManifestResource,
  mapping: MappingContract,
  environment: BrokerEnvironment,
):
  | Readonly<{ ok: true; plan: ResourcePlan }>
  | Readonly<{ ok: false; code: "mapping.incompatible" | "mapping.unavailable"; details: readonly string[] }> {
  const capability = environment.catalog.find((entry) =>
    entry.capabilityId === mapping.capabilityId && entry.provider === mapping.provider
  );

  if (!capability || !capability.approved || !capability.available) {
    return {
      ok: false,
      code: "mapping.unavailable",
      details: [`${resource.resourceId}:${mapping.provider}:${mapping.capabilityId} unavailable or unapproved`],
    };
  }

  const missing = resource.requiredFeatures.filter((feature) => !capability.features.includes(feature)).sort();
  if (!capability.compatible || capability.interface !== resource.interface || missing.length > 0) {
    return {
      ok: false,
      code: "mapping.incompatible",
      details: [
        `${resource.resourceId}:${mapping.provider}:${mapping.capabilityId} incompatible`,
        ...missing.map((feature) => `${resource.resourceId} missing feature ${feature}`),
      ],
    };
  }

  return {
    ok: true,
    plan: {
      resourceId: resource.resourceId,
      provider: mapping.provider,
      capabilityId: mapping.capabilityId,
      action: resource.action,
    },
  };
}

function unavailableDetails(resource: ManifestResource, environment: BrokerEnvironment): string[] {
  const defaults = environment.catalog.filter((entry) =>
    entry.interface === resource.interface && entry.defaultForInterface
  );
  if (defaults.length > 0) {
    return [
      "provider defaults are catalog inputs, not broker decisions",
      ...defaults.map((entry) => `${resource.resourceId}:${entry.provider}:${entry.capabilityId}`),
    ];
  }
  return [`${resource.resourceId}:no approved broker mapping`];
}

function reject({
  code,
  message,
  details,
  replay,
}: {
  code: ResolutionRejection["reason"]["code"];
  message: string;
  details: readonly string[];
  replay: ReplayEvidence;
}) {
  return {
    ok: false,
    rejection: signedRejection({
      schema: RESOLUTION_REJECTION_SCHEMA,
      rejectionId: stableId("rejection", { code, replay, details }),
      resolutionAuthority: BROKER_AUTHORITY,
      manifestDigest: replay.inputs.manifestDigest,
      environmentDigest: replay.inputs.environmentDigest,
      catalogSnapshotDigest: replay.inputs.catalogSnapshotDigest,
      reason: {
        code,
        message,
        details,
      },
      replay,
      fallbackAttempted: false,
    }),
  };
}

function replayEvidence(manifest: ContractManifest, environment: BrokerEnvironment): ReplayEvidence {
  return {
    inputs: {
      manifestDigest: manifest.manifestDigest,
      environmentDigest: environment.environmentDigest,
      catalogSnapshotDigest: environment.catalogDigest,
    },
  };
}

function signedReceipt(
  payload: Omit<ResolutionReceipt, "digest" | "signature">,
): ResolutionReceipt {
  const digest = digestOf(payload);
  return deepFreeze({
    ...payload,
    digest,
    signature: `signed:${BROKER_AUTHORITY}:${digest}`,
  });
}

function signedRejection(
  payload: Omit<ResolutionRejection, "digest" | "signature">,
): ResolutionRejection {
  const digest = digestOf(payload);
  return deepFreeze({
    ...payload,
    digest,
    signature: `signed:${BROKER_AUTHORITY}:${digest}`,
  });
}

function acceptedMappings(): MappingContract[] {
  return [
    {
      mappingId: "map-orders-db-aws",
      resourceId: "orders-db",
      capabilityId: "aws.postgres.ha",
      provider: "provider.aws",
      approved: true,
    },
    {
      mappingId: "map-orders-cache-cloudflare",
      resourceId: "orders-cache",
      capabilityId: "cloudflare.kv.edge",
      provider: "provider.cloudflare",
      approved: true,
    },
  ];
}

function acceptedCatalog(): CatalogCapability[] {
  return [
    {
      capabilityId: "aws.postgres.ha",
      provider: "provider.aws",
      interface: "hobo:database/postgres",
      features: ["ha", "managed"],
      approved: true,
      compatible: true,
      available: true,
    },
    {
      capabilityId: "cloudflare.kv.edge",
      provider: "provider.cloudflare",
      interface: "hobo:cache/kv",
      features: ["edge"],
      approved: true,
      compatible: true,
      available: true,
    },
  ];
}

function stableId(prefix: string, value: JsonValue): string {
  return `${prefix}-${digestOf(value).slice("sha256:".length, "sha256:".length + 16)}`;
}

function digestOf(value: JsonValue): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortedBy<T>(entries: readonly T[], selector: (entry: T) => string): T[] {
  return [...entries].sort((left, right) => selector(left).localeCompare(selector(right)));
}

function clone<T>(value: T): T {
  // SAFETY: `return JSON.parse(JSON.stringify(value)) as T;` is required at this I/O or test boundary.
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
