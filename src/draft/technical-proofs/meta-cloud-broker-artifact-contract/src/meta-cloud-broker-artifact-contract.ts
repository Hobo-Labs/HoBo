import { createHash } from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const BROKER_ARTIFACT_SCHEMAS = {
  "contract-manifest": "hobo.meta-cloud-broker.contract-manifest/v1",
  "broker-environment": "hobo.meta-cloud-broker.environment/v1",
  "mapping-contract": "hobo.meta-cloud-broker.mapping-contract/v1",
  "broker-catalog-snapshot": "hobo.meta-cloud-broker.catalog-snapshot/v1",
  "resolution-receipt": "hobo.meta-cloud-broker.resolution-receipt/v1",
  "resolution-rejection": "hobo.meta-cloud-broker.resolution-rejection/v1",
} as const;

export type BrokerArtifactKind = keyof typeof BROKER_ARTIFACT_SCHEMAS;

// domain-view: parse-produced draft-proof record; its wire form is the BrokerArtifactEnvelope proto message in data-models/.
export interface BrokerArtifactEnvelope<TPayload = JsonObject> {
  kind: BrokerArtifactKind;
  schema: string;
  version: string;
  owner: string;
  provenance: BrokerArtifactProvenance;
  payload: TPayload;
}

// domain-view: parse-produced draft-proof record; its wire form is the BrokerArtifactProvenance proto message in data-models/.
export interface BrokerArtifactProvenance {
  source: {
    issue: string;
    refs: string[];
  };
  proofMode: "schema-test" | "contract-test" | "negative-test" | "policy-fixture";
  signature: {
    issuer: string;
    algorithm: "ed25519";
    digest: string;
  };
}

export type ParseResult =
  | { ok: true; artifacts: BrokerArtifactEnvelope[]; errors: [] }
  | { ok: false; artifacts: []; errors: string[] };

export type ResolutionDecision =
  | {
      kind: "resolution-receipt";
      decision: "accepted";
      receipt: {
        receiptId: string;
        manifestDigest: string;
        environmentDigest: string;
        catalogSnapshotDigest: string;
        mappingDigest: string;
        signatureDigest: string;
        yardHandoff: {
          mode: "consume-receipt";
          noHostedBrokerReResolve: true;
        };
      };
    }
  | {
      kind: "resolution-rejection";
      decision: "rejected";
      rejection: {
        rejectionId: string;
        manifestDigest: string;
        environmentDigest: string;
        reason: {
          code:
            | "stale-catalog-snapshot"
            | "incompatible-mapping"
            | "ambiguous-mapping"
            | "unsupported-capability";
          message: string;
        };
        signatureDigest: string;
      };
    };

// SAFETY: `const ARTIFACT_KINDS = Object.keys(BROKER_ARTIFACT_SCHEMAS) as BrokerArtifactKin` is required at this I/O or test boundary.
const ARTIFACT_KINDS = Object.keys(BROKER_ARTIFACT_SCHEMAS) as BrokerArtifactKind[];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^sha256:[a-zA-Z0-9._:-]+$/;

export function createAcceptedBrokerFixture() {
  const catalogDigest = digestRef("catalog:fixture-local:v1");
  const manifestDigest = digestRef("manifest:shop:v1");
  const environmentDigest = digestRef("environment:prod-approved:v1");
  const mappingDigest = digestRef("mapping:prod-default:v1");

  const artifacts: BrokerArtifactEnvelope[] = [
    envelope("contract-manifest", "App developer / SDK authoring", {
      manifestDigest,
      manifestSchema: "hobo.manifest/v1",
      requestedCapabilities: ["hobo:database"],
      constraints: {
        region: "us-east-1",
        contractIrModes: ["declared", "inferred"],
      },
      declaredFacts: [
        {
          ref: "contract.ir/v1",
          edge: "resource-binding",
          digest: digestRef("contract-ir:shop-db"),
        },
      ],
    }),
    envelope("broker-environment", "Broker admin", {
      environmentDigest,
      approvedBy: "broker-admin:platform",
      catalogSnapshotDigest: catalogDigest,
      versionPins: {
        contractManifest: "hobo.manifest/v1",
        contractIr: "contract.ir/v1",
        capabilityManifest: "hobo.capability-manifest/v1",
      },
      allowedProviderIds: ["fixture-local-provider"],
      policies: [
        {
          id: "prod-deny-ceiling",
          authority: "gatekeeper",
          kind: "gatekeeper-policy",
          digest: digestRef("policy:prod-deny-ceiling"),
        },
      ],
    }),
    envelope("mapping-contract", "Platform engineering", {
      mappingDigest,
      environmentDigest,
      allowedProviders: [
        {
          providerId: "fixture-local-provider",
          catalogDigest,
          priority: 10,
        },
      ],
      constraints: {
        authority: "provider-catalog-input",
        unilateralSelection: false,
      },
    }),
    envelope("broker-catalog-snapshot", "Registry / provider catalog", {
      snapshotDigest: catalogDigest,
      catalogVersion: "2026.06.29",
      issuedAt: "2026-06-29T18:30:00Z",
      staleAfter: "2026-07-29T18:30:00Z",
      capabilityManifests: [
        {
          providerId: "fixture-local-provider",
          manifestDigest: digestRef("capability-manifest:fixture-local-provider"),
          schema: "hobo.capability-manifest/v1",
          conformanceDigest: digestRef("conformance:fixture-local-provider:hobo-database"),
          trustTier: "pre-approved",
        },
      ],
      capabilities: [
        {
          providerId: "fixture-local-provider",
          port: "hobo:database",
          interface: "wasi:sql/query",
          version: "0.1.0",
          stability: "preview",
        },
      ],
    }),
    envelope("resolution-receipt", "Meta-cloud Broker", {
      receiptId: "rr_fixtureaccepted",
      manifestDigest,
      environmentDigest,
      catalogSnapshotDigest: catalogDigest,
      mappingDigest,
      decision: "accepted",
      signatureEnvelope: {
        issuer: "spiffe://hobo/meta-cloud-broker",
        algorithm: "ed25519",
        digest: digestRef("receipt:fixtureaccepted"),
      },
      yardHandoff: {
        mode: "consume-receipt",
        noHostedBrokerReResolve: true,
      },
    }),
    envelope("resolution-rejection", "Meta-cloud Broker", {
      rejectionId: "rej_fixtureunsupported",
      manifestDigest,
      environmentDigest,
      decision: "rejected",
      reason: {
        code: "unsupported-capability",
        message: "capability hobo:gpu-runner is not available in catalog snapshot",
      },
      signatureEnvelope: {
        issuer: "spiffe://hobo/meta-cloud-broker",
        algorithm: "ed25519",
        digest: digestRef("rejection:fixtureunsupported"),
      },
    }),
  ];

  return { artifacts };
}

export function createRejectionBrokerFixture(
  reason: "unsupported-capability" | "stale-catalog-snapshot" | "incompatible-mapping" | "ambiguous-mapping",
) {
  const fixture = clone(createAcceptedBrokerFixture());
  const manifest = requireArtifact(fixture.artifacts, "contract-manifest");
  const rejection = requireArtifact(fixture.artifacts, "resolution-rejection");

  manifest.payload.requestedCapabilities = ["hobo:database", "hobo:gpu-runner"];
  rejection.payload.reason = {
    code: reason,
    message: "capability hobo:gpu-runner is not available in catalog snapshot",
  };

  return fixture;
}

export function parseBrokerArtifactSet(input: JsonValue): ParseResult {
  if (!Array.isArray(input)) {
    return { ok: false, artifacts: [], errors: ["artifact set must be an array"] };
  }

  const errors: string[] = [];
  // SAFETY: `const artifacts = input as BrokerArtifactEnvelope[];` is required at this I/O or test boundary.
  const artifacts = input as BrokerArtifactEnvelope[];
  const seenKinds = new Set<string>();

  for (const artifact of artifacts) {
    validateEnvelope(artifact, errors);
    if (artifact?.kind) {
      seenKinds.add(artifact.kind);
    }
  }

  for (const kind of ARTIFACT_KINDS) {
    if (!seenKinds.has(kind)) {
      errors.push(`missing broker artifact ${kind}`);
    }
  }

  validateMappingContract(requireMaybe(artifacts, "mapping-contract"), errors);
  validateBrokerEnvironment(requireMaybe(artifacts, "broker-environment"), errors);
  validateCatalog(requireMaybe(artifacts, "broker-catalog-snapshot"), errors);
  validateReceipt(requireMaybe(artifacts, "resolution-receipt"), errors);
  validateRejection(requireMaybe(artifacts, "resolution-rejection"), errors);

  return errors.length === 0 ? { ok: true, artifacts: sortArtifacts(artifacts), errors: [] } : { ok: false, artifacts: [], errors };
}

export function evaluateBrokerArtifacts(artifacts: BrokerArtifactEnvelope[]): ResolutionDecision {
  const manifest = requireArtifact(artifacts, "contract-manifest");
  const environment = requireArtifact(artifacts, "broker-environment");
  const mapping = requireArtifact(artifacts, "mapping-contract");
  const catalog = requireArtifact(artifacts, "broker-catalog-snapshot");
  const receipt = requireArtifact(artifacts, "resolution-receipt");
  const rejection = requireArtifact(artifacts, "resolution-rejection");

  const available = new Set(catalog.payload.capabilities.map((capability: any) => capability.port));
  const missing = manifest.payload.requestedCapabilities.filter((capability: string) => !available.has(capability));

  if (missing.length > 0) {
    const reason = rejection.payload.reason;
    // SAFETY: `return sortKeys({` is required at this I/O or test boundary.
    return sortKeys({
      kind: "resolution-rejection",
      decision: "rejected",
      rejection: {
        rejectionId: rejection.payload.rejectionId,
        manifestDigest: manifest.payload.manifestDigest,
        environmentDigest: environment.payload.environmentDigest,
        reason: {
          code: reason.code,
          message: `capability ${missing[0]} is not available in catalog snapshot`,
        },
        signatureDigest: rejection.payload.signatureEnvelope.digest,
      },
    }) as ResolutionDecision;
  }

  // SAFETY: `return sortKeys({` is required at this I/O or test boundary.
  return sortKeys({
    kind: "resolution-receipt",
    decision: "accepted",
    receipt: {
      receiptId: receipt.payload.receiptId,
      manifestDigest: manifest.payload.manifestDigest,
      environmentDigest: environment.payload.environmentDigest,
      catalogSnapshotDigest: catalog.payload.snapshotDigest,
      mappingDigest: mapping.payload.mappingDigest,
      signatureDigest: receipt.payload.signatureEnvelope.digest,
      yardHandoff: receipt.payload.yardHandoff,
    },
  }) as ResolutionDecision;
}

export function stableDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function envelope(kind: BrokerArtifactKind, owner: string, payload: JsonObject): BrokerArtifactEnvelope {
  return {
    kind,
    schema: BROKER_ARTIFACT_SCHEMAS[kind],
    version: "0.1.0",
    owner,
    provenance: {
      source: {
        issue: "HOBO-522",
        refs: [
          "docs/design/meta-cloud-broker.md",
          "docs/design/contracts-policy-flags.md",
          "src/draft/exp-proofs/api/meta-cloud-broker-scope-contract/README.md",
        ],
      },
      proofMode: kind === "resolution-rejection" ? "negative-test" : "schema-test",
      signature: {
        issuer: "spiffe://hobo/meta-cloud-broker-artifact-contract",
        algorithm: "ed25519",
        digest: digestRef(`artifact:${kind}`),
      },
    },
    payload,
  };
}

function validateEnvelope(artifact: any, errors: string[]): void {
  if (!artifact || !isJsonObject(artifact) || Array.isArray(artifact)) {
    errors.push("artifact must be an object");
    return;
  }
  const kind = String(artifact.kind ?? "<JsonValue>");
  if (!(kind in BROKER_ARTIFACT_SCHEMAS)) {
    errors.push(`${kind} kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
    return;
  }
  // SAFETY: `if (artifact.schema !== BROKER_ARTIFACT_SCHEMAS[kind as BrokerArtifactKind]) {` is required at this I/O or test boundary.
  if (artifact.schema !== BROKER_ARTIFACT_SCHEMAS[kind as BrokerArtifactKind]) {
    // SAFETY: `errors.push(`${kind} schema must be ${BROKER_ARTIFACT_SCHEMAS[kind as BrokerArti` is required at this I/O or test boundary.
    errors.push(`${kind} schema must be ${BROKER_ARTIFACT_SCHEMAS[kind as BrokerArtifactKind]}`);
  }
  if (!SEMVER.test(String(artifact.version ?? ""))) {
    errors.push(`${kind} version must be semantic version`);
  }
  if (!isNonEmptyString(artifact.owner)) {
    errors.push(`${kind} owner must be a non-empty string`);
  }
  if (artifact.provenance?.source?.issue !== "HOBO-522") {
    errors.push(`${kind} provenance.source.issue must be HOBO-522`);
  }
  if (!SHA256.test(String(artifact.provenance?.signature?.digest ?? ""))) {
    errors.push(`${kind} provenance.signature.digest must be a sha256 digest`);
  }
  if (artifact.provenance?.signature?.algorithm !== "ed25519") {
    errors.push(`${kind} provenance.signature.algorithm must be ed25519`);
  }
  if (!artifact.payload || !isJsonObject(artifact.payload) || Array.isArray(artifact.payload)) {
    errors.push(`${kind} payload must be an object`);
  }
}

function validateMappingContract(artifact: BrokerArtifactEnvelope | undefined, errors: string[]): void {
  if (!artifact) return;
  if (!SHA256.test(String(artifact.payload.mappingDigest ?? ""))) {
    errors.push("mapping-contract payload.mappingDigest must be a sha256 digest");
  }
  if (artifact.payload.constraints?.unilateralSelection !== false) {
    errors.push("mapping-contract must not grant providers unilateral selection authority");
  }
  const priorities = new Set<number>();
  for (const provider of artifact.payload.allowedProviders ?? []) {
    if (priorities.has(provider.priority)) {
      errors.push("mapping-contract allowedProviders must not contain ambiguous priorities");
      break;
    }
    priorities.add(provider.priority);
  }
}

function validateBrokerEnvironment(artifact: BrokerArtifactEnvelope | undefined, errors: string[]): void {
  if (!artifact) return;
  if (!SHA256.test(String(artifact.payload.environmentDigest ?? ""))) {
    errors.push("broker-environment payload.environmentDigest must be a sha256 digest");
  }
  for (const policy of artifact.payload.policies ?? []) {
    if (policy.kind === "gatekeeper-policy" && policy.authority !== "gatekeeper") {
      errors.push(`broker-environment policy ${policy.id} must not masquerade as Gatekeeper policy`);
    }
  }
}

function validateCatalog(artifact: BrokerArtifactEnvelope | undefined, errors: string[]): void {
  if (!artifact) return;
  if (!SHA256.test(String(artifact.payload.snapshotDigest ?? ""))) {
    errors.push("broker-catalog-snapshot payload.snapshotDigest must be a sha256 digest");
  }
  for (const manifest of artifact.payload.capabilityManifests ?? []) {
    if (manifest.schema !== "hobo.capability-manifest/v1") {
      errors.push(`broker-catalog-snapshot capability manifest ${manifest.providerId} must use hobo.capability-manifest/v1`);
    }
    if (!SHA256.test(String(manifest.conformanceDigest ?? ""))) {
      errors.push(`broker-catalog-snapshot capability manifest ${manifest.providerId} must pin conformance digest`);
    }
  }
}

function validateReceipt(artifact: BrokerArtifactEnvelope | undefined, errors: string[]): void {
  if (!artifact) return;
  if (artifact.payload.decision !== "accepted") {
    errors.push("resolution-receipt decision must be accepted");
  }
  if (artifact.payload.yardHandoff?.noHostedBrokerReResolve !== true) {
    errors.push("resolution-receipt yard handoff must deny hosted broker re-resolution");
  }
}

function validateRejection(artifact: BrokerArtifactEnvelope | undefined, errors: string[]): void {
  if (!artifact) return;
  if (artifact.payload.decision !== "rejected") {
    errors.push("resolution-rejection decision must be rejected");
  }
  const code = artifact.payload.reason?.code;
  if (!["stale-catalog-snapshot", "incompatible-mapping", "ambiguous-mapping", "unsupported-capability"].includes(code)) {
    errors.push("resolution-rejection reason.code must be a deterministic broker rejection code");
  }
}

function requireArtifact(artifacts: BrokerArtifactEnvelope[], kind: BrokerArtifactKind): any {
  const artifact = artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) throw new Error(`missing broker artifact ${kind}`);
  return artifact;
}

function requireMaybe(artifacts: BrokerArtifactEnvelope[], kind: BrokerArtifactKind): BrokerArtifactEnvelope | undefined {
  return artifacts.find((candidate) => candidate.kind === kind);
}

function sortArtifacts(artifacts: BrokerArtifactEnvelope[]): BrokerArtifactEnvelope[] {
  return [...artifacts].sort((a, b) => ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind));
}

function clone<T>(value: T): T {
  // SAFETY: `return JSON.parse(JSON.stringify(value)) as T;` is required at this I/O or test boundary.
  return JSON.parse(JSON.stringify(value)) as T;
}

function digestRef(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function isNonEmptyString(value: JsonValue): value is string {
  return isJsonString(value) && value.trim().length > 0;
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
