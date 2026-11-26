import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const REGISTRY_BUNDLE_SCHEMA = "registry.bundle/v1";
export const REGISTRY_BUNDLE_IMPORTED_EVENT = "registry.BundleImported";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const OCI_DIGEST_URI_RE = /^oci:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const VERIFICATION_GATES = Object.freeze([
  "signature",
  "provenance",
  "conformance",
  "revocation",
  "antiRollback",
  "transparency"
]);

export function createFixtureBundle() {
  const logRoot = digest("rekor-root-2026-06-25");
  const bundle = {
    schema: REGISTRY_BUNDLE_SCHEMA,
    bundleId: "bundle.airgap.acme.2026-06-25",
    version: "1.0.0",
    createdAt: "2026-06-25T07:55:00.000Z",
    curator: {
      id: "acme-platform",
      trustDomain: "spiffe://acme.example"
    },
    contents: {
      listings: [
        listingEntry("provider-aws", "provider"),
        listingEntry("postgres-pack", "resource-pack")
      ],
      baseImages: [
        artifactEntry("wasmcloud-host", {
          mediaType: "application/vnd.oci.image.manifest.v1+json"
        })
      ],
      modelWeights: [
        artifactEntry("embedding-small", {
          mediaType: "application/vnd.hobo.model.weights.v1+tar"
        })
      ]
    },
    trust: {
      revocationList: {
        issuedAt: "2026-06-24T00:00:00.000Z",
        expiresAt: "2026-07-24T00:00:00.000Z",
        signingKeyId: "fulcio-root-2026",
        ref: artifactRef("offline-revocation-list", {
          mediaType: "application/vnd.hobo.offline-revocations.v1+json"
        })
      },
      transparencyLog: {
        logId: "rekor-prod",
        pinnedRoot: logRoot
      },
      antiRollback: {
        yardId: "yard.airgap.acme",
        stateEpoch: "2026-06-25T00:00:00.000Z"
      }
    }
  };
  bundle.bundleDigest = digest(canonicalJson(bundle));
  return bundle;
}

export function parseBundleManifest(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["bundle manifest must be an object"], manifest: null, resolvedListings: [] };
  }

  if (candidate.schema !== REGISTRY_BUNDLE_SCHEMA) {
    errors.push(`schema must be ${REGISTRY_BUNDLE_SCHEMA}`);
  }
  if (!isNonEmptyString(candidate.bundleId)) {
    errors.push("bundleId must be a non-empty string");
  }
  if (!isNonEmptyString(candidate.version)) {
    errors.push("version must be a non-empty string");
  }
  if (!isIsoDate(candidate.createdAt)) {
    errors.push("createdAt must be an ISO timestamp");
  }
  if (!isSha256Digest(candidate.bundleDigest)) {
    errors.push("bundleDigest must be sha256:<64 hex chars>");
  } else if (candidate.bundleDigest !== digest(canonicalJson(withoutKey(candidate, "bundleDigest")))) {
    errors.push("bundleDigest must match canonical manifest content");
  }

  validateCurator(candidate.curator, errors);
  validateTrustMaterial(candidate.trust, errors);
  const pinnedLogRoot = isSha256Digest(candidate.trust?.transparencyLog?.pinnedRoot)
    ? candidate.trust.transparencyLog.pinnedRoot
    : null;
  const pinnedLogId = isNonEmptyString(candidate.trust?.transparencyLog?.logId)
    ? candidate.trust.transparencyLog.logId
    : null;

  const contents = candidate.contents ?? {};
  const listingErrors = [];
  const resolvedListings = validateArray(contents.listings, "contents.listings", listingErrors)
    ? contents.listings.map((entry, index) => validateListingEntry(entry, index, listingErrors, pinnedLogRoot, pinnedLogId)).filter(Boolean)
    : [];
  errors.push(...listingErrors);

  for (const [section, required] of [["baseImages", true], ["modelWeights", false]]) {
    if (required || contents[section] !== undefined) {
      if (validateArray(contents[section], `contents.${section}`, errors)) {
        contents[section].forEach((entry, index) => validateArtifactEntry(entry, `contents.${section}.${index}`, errors, pinnedLogRoot, pinnedLogId));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0 ? sortKeys(candidate) : null,
    resolvedListings
  };
}

export function serializeBundleManifest(manifest) {
  const parsed = parseBundleManifest(manifest);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return canonicalJson(parsed.manifest);
}

export function deserializeBundleManifest(text) {
  return parseBundleManifest(JSON.parse(text));
}

export function parseBundleImportEvent(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["bundle import event must be an object"], event: null };
  }
  if (candidate.type !== REGISTRY_BUNDLE_IMPORTED_EVENT) {
    errors.push(`type must be ${REGISTRY_BUNDLE_IMPORTED_EVENT}`);
  }
  if (!isSha256Digest(candidate.bundleDigest)) {
    errors.push("bundleDigest must be sha256:<64 hex chars>");
  }
  if (!isIsoDate(candidate.importedAt)) {
    errors.push("importedAt must be an ISO timestamp");
  }
  for (const gate of VERIFICATION_GATES) {
    if (candidate.verification?.[gate] !== "passed") {
      errors.push(`verification.${gate} must be passed`);
    }
  }
  if (!Array.isArray(candidate.importedArtifacts) || candidate.importedArtifacts.length === 0) {
    errors.push("importedArtifacts must be a non-empty digest array");
  } else {
    candidate.importedArtifacts.forEach((artifactDigest, index) => {
      if (!isSha256Digest(artifactDigest)) {
        errors.push(`importedArtifacts.${index} must be sha256:<64 hex chars>`);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    event: errors.length === 0 ? sortKeys(candidate) : null
  };
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function listingEntry(name, kind) {
  return {
    kind,
    name: `@acme/${name}`,
    version: "1.2.3",
    descriptor: artifactRef(`${name}-descriptor`, {
      mediaType: "application/vnd.hobo.registry.descriptor.v1+json"
    }),
    buildTimestamp: "2026-06-25T00:00:00.000Z",
    provenance: artifactRef(`${name}-slsa`, {
      mediaType: "application/vnd.in-toto+json"
    }),
    conformanceReports: [
      artifactRef(`${name}-conformance`, {
        mediaType: "application/vnd.hobo.conformance.report.v1+json"
      })
    ],
    transparency: transparencyProof("rekor-prod", "rekor-root-2026-06-25", `${name}-rekor-proof`)
  };
}

function artifactEntry(name, { mediaType }) {
  return {
    name,
    artifact: artifactRef(name, { mediaType }),
    buildTimestamp: "2026-06-25T00:00:00.000Z",
    provenance: artifactRef(`${name}-slsa`, {
      mediaType: "application/vnd.in-toto+json"
    }),
    transparency: transparencyProof("rekor-prod", "rekor-root-2026-06-25", `${name}-rekor-proof`)
  };
}

function transparencyProof(logId, rootSeed, proofSeed) {
  return {
    logId,
    logRoot: digest(rootSeed),
    inclusionProof: artifactRef(proofSeed, {
      mediaType: "application/vnd.dev.sigstore.bundle+json"
    })
  };
}

function validateTrustMaterial(trust, errors) {
  if (!trust || !isJsonObject(trust) || Array.isArray(trust)) {
    errors.push("trust must be an object");
    return;
  }
  if (!trust.revocationList) {
    errors.push("trust.revocationList is required for offline import");
  } else {
    if (!isIsoDate(trust.revocationList.issuedAt)) errors.push("trust.revocationList.issuedAt must be an ISO timestamp");
    if (!isIsoDate(trust.revocationList.expiresAt)) errors.push("trust.revocationList.expiresAt must be an ISO timestamp");
    if (!isNonEmptyString(trust.revocationList.signingKeyId)) errors.push("trust.revocationList.signingKeyId must be a non-empty string");
    validateArtifactRef(trust.revocationList.ref, "trust.revocationList.ref", errors);
  }
  if (!trust.transparencyLog) {
    errors.push("trust.transparencyLog is required for offline import");
  } else {
    if (!isNonEmptyString(trust.transparencyLog.logId)) errors.push("trust.transparencyLog.logId must be a non-empty string");
    if (!isSha256Digest(trust.transparencyLog.pinnedRoot)) errors.push("trust.transparencyLog.pinnedRoot must be sha256:<64 hex chars>");
  }
  if (!trust.antiRollback) {
    errors.push("trust.antiRollback is required for offline import");
  } else {
    if (!isNonEmptyString(trust.antiRollback.yardId)) errors.push("trust.antiRollback.yardId must be a non-empty string");
    if (!isIsoDate(trust.antiRollback.stateEpoch)) errors.push("trust.antiRollback.stateEpoch must be an ISO timestamp");
  }
}

function validateCurator(curator, errors) {
  if (!curator || !isJsonObject(curator) || Array.isArray(curator)) {
    errors.push("curator must be an object");
    return;
  }
  if (!isNonEmptyString(curator.id)) errors.push("curator.id must be a non-empty string");
  if (!isNonEmptyString(curator.trustDomain)) errors.push("curator.trustDomain must be a non-empty string");
}

function validateListingEntry(entry, index, errors, pinnedLogRoot, pinnedLogId) {
  const path = `contents.listings.${index}`;
  validateArtifactEntry({ ...entry, artifact: entry?.descriptor }, path, errors, pinnedLogRoot, pinnedLogId);
  if (!isNonEmptyString(entry?.kind)) errors.push(`${path}.kind must be a non-empty string`);
  if (!isNonEmptyString(entry?.version)) errors.push(`${path}.version must be a non-empty string`);

  return entry?.descriptor?.digest
    ? { name: entry.name, kind: entry.kind, version: entry.version, descriptorDigest: entry.descriptor.digest }
    : null;
}

function validateArtifactEntry(entry, path, errors, pinnedLogRoot, pinnedLogId) {
  if (!entry || !isJsonObject(entry) || Array.isArray(entry)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(entry.name)) errors.push(`${path}.name must be a non-empty string`);
  validateArtifactRef(entry.artifact, `${path}.artifact`, errors);
  if (!isIsoDate(entry.buildTimestamp)) errors.push(`${path}.buildTimestamp must be an ISO timestamp`);
  validateArtifactRef(entry.provenance, `${path}.provenance`, errors);
  validateTransparency(entry.transparency, `${path}.transparency`, errors, pinnedLogRoot, pinnedLogId);
  if (path.includes("contents.listings") && (!Array.isArray(entry.conformanceReports) || entry.conformanceReports.length === 0)) {
    errors.push(`${path}.conformanceReports must be a non-empty array`);
  } else if (entry.conformanceReports !== undefined && validateArray(entry.conformanceReports, `${path}.conformanceReports`, errors)) {
    entry.conformanceReports.forEach((report, index) => {
      validateArtifactRef(report, `${path}.conformanceReports.${index}`, errors);
    });
  }
}

function validateTransparency(transparency, path, errors, pinnedLogRoot, pinnedLogId) {
  if (!transparency || !isJsonObject(transparency) || Array.isArray(transparency)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(transparency.logId)) errors.push(`${path}.logId must be a non-empty string`);
  if (pinnedLogId && transparency.logId !== pinnedLogId) {
    errors.push(`${path}.logId must match trust.transparencyLog.logId`);
  }
  if (!isSha256Digest(transparency.logRoot)) errors.push(`${path}.logRoot must be sha256:<64 hex chars>`);
  if (pinnedLogRoot && transparency.logRoot !== pinnedLogRoot) {
    errors.push(`${path}.logRoot must match trust.transparencyLog.pinnedRoot`);
  }
  validateArtifactRef(transparency.inclusionProof, `${path}.inclusionProof`, errors);
}

function validateArtifactRef(ref, path, errors) {
  if (!ref || !isJsonObject(ref) || Array.isArray(ref)) {
    errors.push(`${path} must be an artifact reference object`);
    return;
  }
  const allowed = new Set(["mediaType", "uri", "digest"]);
  for (const key of Object.keys(ref)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed; artifact references must be digest-only`);
    }
  }
  if (!isNonEmptyString(ref.mediaType)) errors.push(`${path}.mediaType must be a non-empty string`);
  if (!isNonEmptyString(ref.uri) || !OCI_DIGEST_URI_RE.test(ref.uri)) errors.push(`${path}.uri must be an OCI digest reference`);
  if (!isSha256Digest(ref.digest)) errors.push(`${path}.digest must be sha256:<64 hex chars>`);
  if (isSha256Digest(ref.digest) && OCI_DIGEST_URI_RE.test(ref.uri ?? "")) {
    const uriDigest = ref.uri.slice(ref.uri.lastIndexOf("@") + 1);
    if (uriDigest !== ref.digest) {
      errors.push(`${path}.uri digest must match ${path}.digest`);
    }
  }
}

function validateArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return false;
  }
  return true;
}

function artifactRef(seed, { mediaType }) {
  const value = digest(seed);
  return {
    mediaType,
    uri: `oci://registry.example/hobo/${seed}@${value}`,
    digest: value
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isSha256Digest(value) {
  return isJsonString(value) && DIGEST_RE.test(value);
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isIsoDate(value) {
  return isJsonString(value) && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
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

function withoutKey(value, keyToRemove) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== keyToRemove)
      .map(([key, entry]) => [key, entry])
  );
}
