import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "../json.js";


export type ProvenanceTier = "builder-observed" | "sandboxed-builder" | "slsa-build-l3";

export type RefusalReason =
  | "candidate.required"
  | "artifact.required"
  | "artifact.digest_mismatch"
  | "artifact.digest_invalid"
  | "artifact.uri_digest_mismatch"
  | "artifact.coordinate_scope"
  | "signature.required"
  | "signature.alg"
  | "signature.key_untrusted"
  | "signature.payload_digest_mismatch"
  | "signature.invalid"
  | "provenance.builder_untrusted"
  | "provenance.tier_below_policy_minimum"
  | "provenance.subject_digest_mismatch"
  | "conformance.required"
  | "conformance.suite_untrusted"
  | "conformance.failed";

export interface SigningKey {
  readonly keyId: string;
  readonly builderId: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export interface TrustBoundaryInput {
  readonly trustedKeyIds: readonly string[];
  readonly trustedBuilderIds: readonly string[];
  readonly requiredConformanceSuites: readonly string[];
  readonly allowedCoordinateScopes: readonly string[];
  readonly minimumProvenanceTier: ProvenanceTier;
}

// domain-view: parse-produced draft-proof record; its wire form is the TrustBoundary proto message in data-models/.
export interface TrustBoundary {
  readonly trustedKeyIds: readonly string[];
  readonly trustedBuilderIds: readonly string[];
  readonly requiredConformanceSuites: readonly string[];
  readonly allowedCoordinateScopes: readonly string[];
  readonly minimumProvenanceTier: ProvenanceTier;
}

// domain-view: parse-produced draft-proof record; its wire form is the ArtifactRef proto message in data-models/.
export interface ArtifactRef {
  readonly coordinate: string;
  readonly version: string;
  readonly mediaType: string;
  readonly bytes: string;
  readonly digest: string;
  readonly uri: string;
}

export interface ConformanceReport {
  readonly suiteId: string;
  readonly passed: boolean;
  readonly assertions?: readonly string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the SignedArtifactCandidate proto message in data-models/.
export interface SignedArtifactCandidate {
  readonly artifact: ArtifactRef;
  readonly provenance: {
    readonly schema: "slsa.dev/provenance/v1";
    readonly slsa: {
      readonly builder: { readonly id: string };
      readonly subject: { readonly name: string; readonly digest: string };
      readonly materials: readonly unknown[];
      readonly issuedAt: string;
      readonly provenanceTier: ProvenanceTier;
    };
  };
  readonly conformance: {
    readonly schema: "hobo.conformance.report-ref/v1";
    readonly report: ConformanceReport;
    readonly digest: string;
  };
  readonly signature: {
    readonly alg: "Ed25519";
    readonly keyId: string;
    readonly publicKeyPem: string;
    readonly payloadDigest: string;
    readonly value: string;
  };
}

export type InstallVerdict =
  | {
      readonly ok: true;
      readonly reasons: readonly [];
      readonly availableToMatching: true;
      readonly selectedByMatching: false;
      readonly assurance: "integrity-and-conformance-verified";
      readonly residualRisks: readonly ["validly-signed-but-malicious", "compromised-builder-or-key"];
      readonly trust: {
        readonly provenanceTier: ProvenanceTier;
        readonly policyMinimum: ProvenanceTier;
      };
      readonly ref: {
        readonly coordinate: string;
        readonly version: string;
        readonly mediaType: string;
        readonly uri: string;
        readonly digest: string;
      };
    }
  | {
      readonly ok: false;
      readonly reasons: readonly RefusalReason[];
      readonly availableToMatching: false;
      readonly selectedByMatching: false;
      readonly assurance: "rejected";
      readonly residualRisks: readonly [];
      readonly ref: null;
    };

export type VerifiedInstall = Extract<InstallVerdict, { ok: true }>;

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_ALG = "Ed25519" as const;
const PROVENANCE_TIER_ORDER: readonly ProvenanceTier[] = Object.freeze([
  "builder-observed",
  "sandboxed-builder",
  "slsa-build-l3",
]);

export class ArtifactVerificationRefusedError extends Error {
  readonly code = "artifact.verification_refused" as const;
  readonly reasons: readonly RefusalReason[];

  constructor(reasons: readonly RefusalReason[]) {
    super(`artifact verification refused: ${reasons.join(", ")}`);
    this.name = "ArtifactVerificationRefusedError";
    this.reasons = Object.freeze([...reasons]);
  }
}

export function assertVerifiedInstall(verdict: InstallVerdict): VerifiedInstall {
  if (verdict.ok) {
    return verdict;
  }
  throw new ArtifactVerificationRefusedError(verdict.reasons);
}

export function createFixtureSigningKey(input: { keyId: string; builderId: string }): SigningKey {
  const keyId = parseNonEmptyString(input.keyId, "keyId");
  const builderId = parseNonEmptyString(input.builderId, "builderId");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    keyId,
    builderId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

export function createTrustBoundary(input: TrustBoundaryInput): TrustBoundary {
  parseProvenanceTier(input.minimumProvenanceTier, "minimumProvenanceTier");
  return Object.freeze({
    trustedKeyIds: freezeStringList(input.trustedKeyIds, "trustedKeyIds"),
    trustedBuilderIds: freezeStringList(input.trustedBuilderIds, "trustedBuilderIds"),
    requiredConformanceSuites: freezeStringList(
      input.requiredConformanceSuites,
      "requiredConformanceSuites",
    ),
    allowedCoordinateScopes: freezeStringList(
      input.allowedCoordinateScopes,
      "allowedCoordinateScopes",
    ),
    minimumProvenanceTier: input.minimumProvenanceTier,
  });
}

export function createArtifactPayload(input: {
  coordinate: string;
  version: string;
  mediaType: string;
  bytes: string;
}): ArtifactRef {
  const coordinate = parseNonEmptyString(input.coordinate, "coordinate");
  const version = parseNonEmptyString(input.version, "version");
  const mediaType = parseNonEmptyString(input.mediaType, "mediaType");
  const bytes = parseNonEmptyString(input.bytes, "bytes");
  const digest = artifactDigest({ coordinate, version, mediaType, bytes });
  return Object.freeze({
    coordinate,
    version,
    mediaType,
    bytes,
    digest,
    uri: `${coordinate}@${digest}`,
  });
}

export function artifactDigest(artifact: Pick<ArtifactRef, "bytes" | "coordinate" | "mediaType" | "version">): string {
  return `sha256:${createHash("sha256")
    .update(
      stableStringify({
        bytes: artifact.bytes,
        coordinate: artifact.coordinate,
        mediaType: artifact.mediaType,
        version: artifact.version,
      }),
    )
    .digest("hex")}`;
}

export function publishSignedArtifact(input: {
  artifact: ArtifactRef;
  signingKey: SigningKey;
  conformanceReport: ConformanceReport;
  issuedAt: string;
  provenanceTier: ProvenanceTier;
}): SignedArtifactCandidate {
  const issuedAt = parseIsoTimestamp(input.issuedAt, "issuedAt");
  parseProvenanceTier(input.provenanceTier, "provenanceTier");
  const normalizedArtifact = normalizeArtifact(input.artifact);
  const provenance = {
    schema: "slsa.dev/provenance/v1" as const,
    slsa: {
      builder: { id: input.signingKey.builderId },
      subject: {
        name: `${normalizedArtifact.coordinate}@${normalizedArtifact.version}`,
        digest: normalizedArtifact.digest,
      },
      materials: Object.freeze([]),
      issuedAt,
      provenanceTier: input.provenanceTier,
    },
  };
  const conformance = {
    schema: "hobo.conformance.report-ref/v1" as const,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    report: sortKeys(input.conformanceReport) as ConformanceReport,
    digest: contentDigest(input.conformanceReport),
  };
  const signaturePayload = createSignaturePayload({
    artifact: normalizedArtifact,
    provenance,
    conformance,
  });
  const signatureValue = sign(
    null,
    Buffer.from(stableStringify(signaturePayload)),
    createPrivateKey(input.signingKey.privateKeyPem),
  ).toString("base64url");

  return Object.freeze({
    artifact: normalizedArtifact,
    provenance,
    conformance,
    signature: {
      alg: SIGNATURE_ALG,
      keyId: input.signingKey.keyId,
      publicKeyPem: input.signingKey.publicKeyPem,
      payloadDigest: normalizedArtifact.digest,
      value: signatureValue,
    },
  });
}

export function verifyInstallCandidate(input: {
  candidate: JsonValue;
  trustBoundary: TrustBoundary;
}): InstallVerdict {
  const reasons: RefusalReason[] = [];
  const { candidate, trustBoundary } = input;

  if (!isRecord(candidate)) {
    return rejected(["candidate.required"]);
  }

  const artifact = candidate.artifact;
  if (!isRecord(artifact)) {
    reasons.push("artifact.required");
  } else {
    const computedDigest = artifactDigest({
      bytes: String(artifact.bytes ?? ""),
      coordinate: String(artifact.coordinate ?? ""),
      mediaType: String(artifact.mediaType ?? ""),
      version: String(artifact.version ?? ""),
    });
    if (artifact.digest !== computedDigest) {
      reasons.push("artifact.digest_mismatch");
    }
    if (!SHA256_DIGEST_RE.test(String(artifact.digest ?? ""))) {
      reasons.push("artifact.digest_invalid");
    }
    if (!String(artifact.uri ?? "").endsWith(`@${String(artifact.digest ?? "")}`)) {
      reasons.push("artifact.uri_digest_mismatch");
    }
    if (
      !trustBoundary.allowedCoordinateScopes.some((scope) =>
        String(artifact.coordinate ?? "").startsWith(scope),
      )
    ) {
      reasons.push("artifact.coordinate_scope");
    }
  }

  const signature = candidate.signature;
  if (!isRecord(signature)) {
    reasons.push("signature.required");
  } else {
    if (signature.alg !== SIGNATURE_ALG) {
      reasons.push("signature.alg");
    }
    if (!trustBoundary.trustedKeyIds.includes(String(signature.keyId ?? ""))) {
      reasons.push("signature.key_untrusted");
    }
    if (signature.payloadDigest !== (isRecord(artifact) ? artifact.digest : undefined)) {
      reasons.push("signature.payload_digest_mismatch");
    }
    if (!verifySignature(candidate)) {
      reasons.push("signature.invalid");
    }
  }

  const provenance = isRecord(candidate.provenance) ? candidate.provenance : undefined;
  const slsa = isRecord(provenance?.slsa) ? provenance.slsa : undefined;
  const builderId = slsa?.builder && isRecord(slsa.builder) ? slsa.builder.id : undefined;
  if (!trustBoundary.trustedBuilderIds.includes(String(builderId ?? ""))) {
    reasons.push("provenance.builder_untrusted");
  }
  const provenanceTier = slsa?.provenanceTier;
  if (tierRank(String(provenanceTier ?? "")) < tierRank(trustBoundary.minimumProvenanceTier)) {
    reasons.push("provenance.tier_below_policy_minimum");
  }
  if (
    (isRecord(slsa?.subject) ? slsa.subject.digest : undefined) !==
    (isRecord(artifact) ? artifact.digest : undefined)
  ) {
    reasons.push("provenance.subject_digest_mismatch");
  }

  const conformance = isRecord(candidate.conformance) ? candidate.conformance : undefined;
  const report = conformance?.report;
  if (!isRecord(report)) {
    reasons.push("conformance.required");
  } else {
    if (!trustBoundary.requiredConformanceSuites.includes(String(report.suiteId ?? ""))) {
      reasons.push("conformance.suite_untrusted");
    }
    if (report.passed !== true) {
      reasons.push("conformance.failed");
    }
  }

  if (reasons.length > 0) {
    return rejected(reasons);
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const artifactRecord = artifact as JsonObject;
  return Object.freeze({
    ok: true,
    reasons: [],
    availableToMatching: true,
    selectedByMatching: false,
    assurance: "integrity-and-conformance-verified",
    residualRisks: Object.freeze(["validly-signed-but-malicious", "compromised-builder-or-key"]),
    trust: Object.freeze({
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      provenanceTier: String(provenanceTier) as ProvenanceTier,
      policyMinimum: trustBoundary.minimumProvenanceTier,
    }),
    ref: Object.freeze({
      coordinate: String(artifactRecord.coordinate),
      version: String(artifactRecord.version),
      mediaType: String(artifactRecord.mediaType),
      uri: String(artifactRecord.uri),
      digest: String(artifactRecord.digest),
    }),
  });
}

function verifySignature(candidate: JsonObject): boolean {
  try {
    const artifact = candidate.artifact;
    const signature = candidate.signature;
    const provenance = candidate.provenance;
    const conformance = candidate.conformance;
    if (!isRecord(artifact) || !isRecord(signature) || !isRecord(provenance) || !isRecord(conformance)) {
      return false;
    }
    const signaturePayload = createSignaturePayload({
      artifact: normalizeArtifact({
        coordinate: String(artifact.coordinate),
        version: String(artifact.version),
        mediaType: String(artifact.mediaType),
        bytes: String(artifact.bytes),
        digest: String(artifact.digest),
        uri: String(artifact.uri),
      }),
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      provenance: provenance as SignedArtifactCandidate["provenance"],
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      conformance: conformance as SignedArtifactCandidate["conformance"],
    });
    return verify(
      null,
      Buffer.from(stableStringify(signaturePayload)),
      createPublicKey(String(signature.publicKeyPem)),
      Buffer.from(String(signature.value), "base64url"),
    );
  } catch {
    return false;
  }
}

function normalizeArtifact(artifact: ArtifactRef): ArtifactRef {
  const digest = artifactDigest(artifact);
  return Object.freeze({
    coordinate: artifact.coordinate,
    version: artifact.version,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes,
    digest,
    uri: `${artifact.coordinate}@${digest}`,
  });
}

function createSignaturePayload(input: {
  artifact: ArtifactRef;
  provenance: SignedArtifactCandidate["provenance"];
  conformance: SignedArtifactCandidate["conformance"];
}): JsonObject {
  return sortKeys({
    artifact: {
      coordinate: input.artifact.coordinate,
      digest: input.artifact.digest,
      mediaType: input.artifact.mediaType,
      uri: input.artifact.uri,
      version: input.artifact.version,
    },
    provenance: input.provenance,
    conformance: input.conformance,
  });
}

function rejected(reasons: RefusalReason[]): InstallVerdict {
  return Object.freeze({
    ok: false,
    reasons: Object.freeze([...new Set(reasons)]),
    availableToMatching: false,
    selectedByMatching: false,
    assurance: "rejected",
    residualRisks: Object.freeze([]),
    ref: null,
  });
}

function contentDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function freezeStringList(values: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  for (const value of values) {
    parseNonEmptyString(value, name);
  }
  return Object.freeze([...values]);
}

function parseNonEmptyString(value: JsonValue, name: string): string {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function parseIsoTimestamp(value: JsonValue, name: string): string {
  const parsed = parseNonEmptyString(value, name);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return parsed;
}

function parseProvenanceTier(value: JsonValue, name: string): asserts value is ProvenanceTier {
  parseNonEmptyString(value, name);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  if (!PROVENANCE_TIER_ORDER.includes(value as ProvenanceTier)) {
    throw new Error(`${name} must be a known provenance tier`);
  }
}

function tierRank(value: string): number {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return PROVENANCE_TIER_ORDER.indexOf(value as ProvenanceTier);
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}

function stableStringify(value: JsonValue): string {
  if (!isJsonObject(value) && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`)
    .join(",")}}`;
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return value.map((entry) => sortKeys(entry)) as T;
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const record = value as JsonObject;
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  ) as T;
}
