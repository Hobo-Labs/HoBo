import { createHash } from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue } from "./json.js";


export const RESOLUTION_REJECTION_SCHEMA = "hobo.resolution-rejection/v1";
export const BROKER_AUTHORITY = "meta-cloud-broker";

export type RejectionCaseId =
  | "stale-catalog"
  | "incompatible-mapping"
  | "ambiguous-mapping"
  | "missing-mapping"
  | "unsupported-capability";

export type BrokerRejectionCode =
  | "catalog.stale"
  | "mapping.incompatible"
  | "mapping.ambiguous"
  | "mapping.missing"
  | "capability.unsupported";

export type BlockedOptimism =
  | "best-effort-selection"
  | "stale-catalog-optimism"
  | "provider-default-fallback"
  | "hidden-yard-planning";

export type BrokerRejectionFixtureInput = Readonly<{
  caseId: RejectionCaseId;
  resourceId: string;
  interface: string;
  manifestDigest: string;
  environmentDigest: string;
  catalogSnapshotDigest: string;
  expectedCode: BrokerRejectionCode;
  detail: string;
  remediationHint: string;
  blockedOptimism: readonly BlockedOptimism[];
  unsafeDebugMaterial?: JsonValue;
}>;

export type BrokerRejectionMatrix = Readonly<{
  schema: "hobo.broker-rejection-matrix/v1";
  issue: "HOBO-528";
  rejections: readonly BrokerResolutionRejection[];
}>;

export type BrokerResolutionRejection = Readonly<{
  schema: typeof RESOLUTION_REJECTION_SCHEMA;
  rejectionId: string;
  resolutionAuthority: typeof BROKER_AUTHORITY;
  caseId: RejectionCaseId;
  reason: Readonly<{
    code: BrokerRejectionCode;
    message: string;
    details: readonly string[];
    remediationHint: string;
    blockedOptimism: readonly BlockedOptimism[];
    supportSafe: true;
  }>;
  replay: ReplayEvidence;
  supportEvidence: SupportEvidence;
  fallbackAttempted: false;
  yardPlanningAllowed: false;
  partialReceiptEmitted: false;
  digest: `sha256:${string}`;
  signature: string;
}>;

export type ReplayEvidence = Readonly<{
  inputs: Readonly<{
    manifestDigest: string;
    environmentDigest: string;
    catalogSnapshotDigest: string;
  }>;
}>;

export type SupportEvidence = Readonly<{
  evidenceId: string;
  resourceId: string;
  interface: string;
  manifestDigest: string;
  environmentDigest: string;
  catalogSnapshotDigest: string;
  customerSafeSummary: string;
}>;

type EvaluateInput = Readonly<{
  cases: readonly BrokerRejectionFixtureInput[];
  yardFallbackResolver?: () => JsonValue;
}>;

type BuildFixturesOptions = Readonly<{
  unsafeDebugMaterial?: JsonValue;
}>;

export function buildBrokerRejectionMatrixFixtures(
  options: BuildFixturesOptions = {},
): readonly BrokerRejectionFixtureInput[] {
  return deepFreeze([
    fixture({
      caseId: "stale-catalog",
      expectedCode: "catalog.stale",
      detail: "catalog snapshot expired before broker resolution",
      remediationHint: "Publish a fresh Broker Catalog Snapshot and resolve against the new digest.",
      blockedOptimism: ["stale-catalog-optimism"],
      unsafeDebugMaterial: options.unsafeDebugMaterial,
    }),
    fixture({
      caseId: "incompatible-mapping",
      expectedCode: "mapping.incompatible",
      detail: "approved mapping lacks required managed HA feature",
      remediationHint: "Select a mapping whose Capability Spec satisfies the manifest feature set.",
      blockedOptimism: [],
      unsafeDebugMaterial: options.unsafeDebugMaterial,
    }),
    fixture({
      caseId: "ambiguous-mapping",
      expectedCode: "mapping.ambiguous",
      detail: "multiple approved mappings match the same resource without a tie authority",
      remediationHint: "Remove the ambiguity or publish a Broker Environment with one approved mapping.",
      blockedOptimism: ["best-effort-selection"],
      unsafeDebugMaterial: options.unsafeDebugMaterial,
    }),
    fixture({
      caseId: "missing-mapping",
      expectedCode: "mapping.missing",
      detail: "no approved mapping exists for the requested resource; catalog defaults are ignored",
      remediationHint: "Approve a Mapping Contract for the resource before issuing broker evidence.",
      blockedOptimism: ["provider-default-fallback"],
      unsafeDebugMaterial: options.unsafeDebugMaterial,
    }),
    fixture({
      caseId: "unsupported-capability",
      expectedCode: "capability.unsupported",
      detail: "requested capability is not present in the approved Broker Catalog Snapshot",
      remediationHint: "Route to provider/catalog publication before retrying broker resolution.",
      blockedOptimism: ["hidden-yard-planning"],
      unsafeDebugMaterial: options.unsafeDebugMaterial,
    }),
  ]);
}

export function evaluateBrokerRejectionMatrix({ cases }: EvaluateInput): BrokerRejectionMatrix {
  const parsedCases = sortedBy(
    cases.map(parseRejectionFixture),
    (entry) => String(caseOrder[entry.caseId]),
  );

  return deepFreeze({
    schema: "hobo.broker-rejection-matrix/v1",
    issue: "HOBO-528",
    rejections: parsedCases.map(toSignedRejection),
  });
}

interface RejectionCaseOrder {
  readonly "stale-catalog": number;
  readonly "incompatible-mapping": number;
  readonly "ambiguous-mapping": number;
  readonly "missing-mapping": number;
  readonly "unsupported-capability": number;
}

const caseOrder: RejectionCaseOrder = {
  "stale-catalog": 0,
  "incompatible-mapping": 1,
  "ambiguous-mapping": 2,
  "missing-mapping": 3,
  "unsupported-capability": 4,
};

function fixture(
  overrides: Pick<
    BrokerRejectionFixtureInput,
    "caseId" | "expectedCode" | "detail" | "remediationHint" | "blockedOptimism" | "unsafeDebugMaterial"
  >,
): BrokerRejectionFixtureInput {
  return {
    resourceId: "orders-db",
    interface: "hobo:database/postgres",
    manifestDigest: "sha256:manifest-orders-prod",
    environmentDigest: "sha256:broker-env-prod",
    catalogSnapshotDigest: "sha256:catalog-prod",
    ...overrides,
  };
}

function parseRejectionFixture(input: BrokerRejectionFixtureInput): BrokerRejectionFixtureInput {
  const requiredStrings: Array<[string, string]> = [
    ["caseId", input.caseId],
    ["resourceId", input.resourceId],
    ["interface", input.interface],
    ["manifestDigest", input.manifestDigest],
    ["environmentDigest", input.environmentDigest],
    ["catalogSnapshotDigest", input.catalogSnapshotDigest],
    ["expectedCode", input.expectedCode],
    ["detail", input.detail],
    ["remediationHint", input.remediationHint],
  ];

  for (const [field, value] of requiredStrings) {
    if (!isJsonString(value) || value.length === 0) {
      throw new Error(`invalid broker rejection fixture: ${field}`);
    }
  }

  if (!input.manifestDigest.startsWith("sha256:")) {
    throw new Error("invalid broker rejection fixture: manifestDigest");
  }
  if (!input.environmentDigest.startsWith("sha256:")) {
    throw new Error("invalid broker rejection fixture: environmentDigest");
  }
  if (!input.catalogSnapshotDigest.startsWith("sha256:")) {
    throw new Error("invalid broker rejection fixture: catalogSnapshotDigest");
  }

  return {
    ...input,
    blockedOptimism: [...input.blockedOptimism].sort(),
    unsafeDebugMaterial: undefined,
  };
}

function toSignedRejection(input: BrokerRejectionFixtureInput): BrokerResolutionRejection {
  const replay = replayEvidence(input);
  const supportEvidence = supportEvidenceFor(input);
  const payload = {
    schema: RESOLUTION_REJECTION_SCHEMA,
    rejectionId: stableId("rejection", {
      caseId: input.caseId,
      code: input.expectedCode,
      replay,
      detail: input.detail,
    }),
    resolutionAuthority: BROKER_AUTHORITY,
    caseId: input.caseId,
    reason: {
      code: input.expectedCode,
      message: `${input.caseId} rejected by broker rejection matrix`,
      details: [input.detail],
      remediationHint: input.remediationHint,
      blockedOptimism: input.blockedOptimism,
      supportSafe: true,
    },
    replay,
    supportEvidence,
    fallbackAttempted: false,
    yardPlanningAllowed: false,
    partialReceiptEmitted: false,
  } satisfies Omit<BrokerResolutionRejection, "digest" | "signature">;
  const digest = digestOf(payload);

  return {
    ...payload,
    digest,
    signature: `signed:${BROKER_AUTHORITY}:${digest}`,
  };
}

function replayEvidence(input: BrokerRejectionFixtureInput): ReplayEvidence {
  return {
    inputs: {
      manifestDigest: input.manifestDigest,
      environmentDigest: input.environmentDigest,
      catalogSnapshotDigest: input.catalogSnapshotDigest,
    },
  };
}

function supportEvidenceFor(input: BrokerRejectionFixtureInput): SupportEvidence {
  return {
    evidenceId: stableId("support", {
      caseId: input.caseId,
      resourceId: input.resourceId,
      catalogSnapshotDigest: input.catalogSnapshotDigest,
    }),
    resourceId: input.resourceId,
    interface: input.interface,
    manifestDigest: input.manifestDigest,
    environmentDigest: input.environmentDigest,
    catalogSnapshotDigest: input.catalogSnapshotDigest,
    customerSafeSummary: `${input.caseId} for ${input.resourceId}`,
  };
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

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
