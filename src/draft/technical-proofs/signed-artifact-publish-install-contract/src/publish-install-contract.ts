import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_ALG = "Ed25519";
const PROVENANCE_TIER_ORDER = Object.freeze([
  "builder-observed",
  "sandboxed-builder",
  "slsa-build-l3",
]);

export function createFixtureSigningKey({ keyId, builderId }) {
  assertNonEmptyString(keyId, "keyId");
  assertNonEmptyString(builderId, "builderId");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    keyId,
    builderId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
}

export function createTrustBoundary({
  trustedKeyIds,
  trustedBuilderIds,
  requiredConformanceSuites,
  allowedCoordinateScopes,
  minimumProvenanceTier,
}) {
  assertKnownProvenanceTier(minimumProvenanceTier, "minimumProvenanceTier");

  return Object.freeze({
    trustedKeyIds: freezeStringList(trustedKeyIds, "trustedKeyIds"),
    trustedBuilderIds: freezeStringList(trustedBuilderIds, "trustedBuilderIds"),
    requiredConformanceSuites: freezeStringList(
      requiredConformanceSuites,
      "requiredConformanceSuites",
    ),
    allowedCoordinateScopes: freezeStringList(allowedCoordinateScopes, "allowedCoordinateScopes"),
    minimumProvenanceTier,
  });
}

export function createArtifactPayload({ coordinate, version, mediaType, bytes }) {
  assertNonEmptyString(coordinate, "coordinate");
  assertNonEmptyString(version, "version");
  assertNonEmptyString(mediaType, "mediaType");
  assertNonEmptyString(bytes, "bytes");

  const artifact = { coordinate, version, mediaType, bytes };
  const digest = artifactDigest(artifact);
  return Object.freeze({
    ...artifact,
    digest,
    uri: `${coordinate}@${digest}`,
  });
}

export function artifactDigest(artifact) {
  assertObject(artifact, "artifact");
  return `sha256:${createHash("sha256").update(stableStringify({
    bytes: artifact.bytes,
    coordinate: artifact.coordinate,
    mediaType: artifact.mediaType,
    version: artifact.version,
  })).digest("hex")}`;
}

export function publishSignedArtifact({
  artifact,
  signingKey,
  conformanceReport,
  issuedAt,
  provenanceTier,
}) {
  assertObject(artifact, "artifact");
  assertObject(signingKey, "signingKey");
  assertObject(conformanceReport, "conformanceReport");
  assertIsoTimestamp(issuedAt, "issuedAt");
  assertKnownProvenanceTier(provenanceTier, "provenanceTier");

  const normalizedArtifact = normalizeArtifact(artifact);
  const provenance = {
    schema: "slsa.dev/provenance/v1",
    slsa: {
      builder: {
        id: signingKey.builderId,
      },
      subject: {
        name: `${normalizedArtifact.coordinate}@${normalizedArtifact.version}`,
        digest: normalizedArtifact.digest,
      },
      materials: [],
      issuedAt,
      provenanceTier,
    },
  };
  const conformance = {
    schema: "hobo.conformance.report-ref/v1",
    report: sortKeys(conformanceReport),
    digest: contentDigest(conformanceReport),
  };
  const signaturePayload = createSignaturePayload({
    artifact: normalizedArtifact,
    provenance,
    conformance,
  });
  const signatureValue = sign(
    null,
    Buffer.from(stableStringify(signaturePayload)),
    createPrivateKey(signingKey.privateKeyPem),
  ).toString("base64url");

  return Object.freeze({
    artifact: normalizedArtifact,
    provenance,
    conformance,
    signature: {
      alg: SIGNATURE_ALG,
      keyId: signingKey.keyId,
      publicKeyPem: signingKey.publicKeyPem,
      payloadDigest: normalizedArtifact.digest,
      value: signatureValue,
    },
  });
}

export function verifyInstallCandidate({ candidate, trustBoundary }) {
  const reasons = [];
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return rejected(["candidate.required"]);
  }
  assertObject(trustBoundary, "trustBoundary");

  const artifact = candidate.artifact;
  if (!artifact || !isJsonObject(artifact) || Array.isArray(artifact)) {
    reasons.push("artifact.required");
  } else {
    const computedDigest = artifactDigest(artifact);
    if (artifact.digest !== computedDigest) {
      reasons.push("artifact.digest_mismatch");
    }
    if (!SHA256_DIGEST_RE.test(String(artifact.digest))) {
      reasons.push("artifact.digest_invalid");
    }
    if (!String(artifact.uri ?? "").endsWith(`@${artifact.digest}`)) {
      reasons.push("artifact.uri_digest_mismatch");
    }
    if (!trustBoundary.allowedCoordinateScopes.some((scope) => artifact.coordinate?.startsWith(scope))) {
      reasons.push("artifact.coordinate_scope");
    }
  }

  const signature = candidate.signature;
  if (!signature || !isJsonObject(signature) || Array.isArray(signature)) {
    reasons.push("signature.required");
  } else {
    if (signature.alg !== SIGNATURE_ALG) {
      reasons.push("signature.alg");
    }
    if (!trustBoundary.trustedKeyIds.includes(signature.keyId)) {
      reasons.push("signature.key_untrusted");
    }
    if (signature.payloadDigest !== artifact?.digest) {
      reasons.push("signature.payload_digest_mismatch");
    }
    if (!verifySignature(candidate)) {
      reasons.push("signature.invalid");
    }
  }

  const builderId = candidate.provenance?.slsa?.builder?.id;
  if (!trustBoundary.trustedBuilderIds.includes(builderId)) {
    reasons.push("provenance.builder_untrusted");
  }
  const provenanceTier = candidate.provenance?.slsa?.provenanceTier;
  if (tierRank(provenanceTier) < tierRank(trustBoundary.minimumProvenanceTier)) {
    reasons.push("provenance.tier_below_policy_minimum");
  }
  if (candidate.provenance?.slsa?.subject?.digest !== artifact?.digest) {
    reasons.push("provenance.subject_digest_mismatch");
  }

  const report = candidate.conformance?.report;
  if (!report || !isJsonObject(report) || Array.isArray(report)) {
    reasons.push("conformance.required");
  } else {
    if (!trustBoundary.requiredConformanceSuites.includes(report.suiteId)) {
      reasons.push("conformance.suite_untrusted");
    }
    if (report.passed !== true) {
      reasons.push("conformance.failed");
    }
  }

  if (reasons.length > 0) {
    return rejected(reasons);
  }

  return Object.freeze({
    ok: true,
    reasons: [],
    availableToMatching: true,
    selectedByMatching: false,
    assurance: "integrity-and-conformance-verified",
    residualRisks: Object.freeze([
      "validly-signed-but-malicious",
      "compromised-builder-or-key",
    ]),
    trust: Object.freeze({
      provenanceTier,
      policyMinimum: trustBoundary.minimumProvenanceTier,
    }),
    ref: Object.freeze({
      coordinate: artifact.coordinate,
      version: artifact.version,
      mediaType: artifact.mediaType,
      uri: artifact.uri,
      digest: artifact.digest,
    }),
  });
}

function verifySignature(candidate) {
  try {
    const signaturePayload = createSignaturePayload({
      artifact: candidate.artifact,
      provenance: candidate.provenance,
      conformance: candidate.conformance,
    });
    return verify(
      null,
      Buffer.from(stableStringify(signaturePayload)),
      createPublicKey(candidate.signature.publicKeyPem),
      Buffer.from(candidate.signature.value, "base64url"),
    );
  } catch {
    return false;
  }
}

function normalizeArtifact(artifact) {
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

function createSignaturePayload({ artifact, provenance, conformance }) {
  return sortKeys({
    artifact: {
      coordinate: artifact.coordinate,
      digest: artifact.digest,
      mediaType: artifact.mediaType,
      uri: artifact.uri,
      version: artifact.version,
    },
    provenance,
    conformance,
  });
}

function rejected(reasons) {
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

function contentDigest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function freezeStringList(values, name) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  for (const value of values) {
    assertNonEmptyString(value, name);
  }
  return Object.freeze([...values]);
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertIsoTimestamp(value, name) {
  assertNonEmptyString(value, name);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function assertKnownProvenanceTier(value, name) {
  assertNonEmptyString(value, name);
  if (!PROVENANCE_TIER_ORDER.includes(value)) {
    throw new Error(`${name} must be a known provenance tier`);
  }
}

function tierRank(value) {
  return PROVENANCE_TIER_ORDER.indexOf(value);
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
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
