import { parseDescriptor } from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import { verifyInstallCandidate } from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import { isJsonObject } from "./json.js";


export const HOBO_ADD_INSTALL_CONTRACT = "hobo.add.install-verification/v1";

export function createHoboAddCatalog(initialEntries = []) {
  const entries = new Map();
  const entriesByDigest = new Map();

  for (const entry of initialEntries) {
    register(entry);
  }

  function register(entry) {
    const normalized = Object.freeze({
      listing: Object.freeze({
        kind: entry.listing.kind,
        name: entry.listing.name,
        version: entry.listing.version,
      }),
      coordinate: entry.coordinate,
      mediaType: entry.mediaType,
      uri: entry.uri,
      digest: entry.digest,
      availableToMatching: true,
      selectedByMatching: false,
      assurance: entry.assurance,
      trust: Object.freeze({ ...entry.trust }),
    });
    entries.set(entryKey(normalized), normalized);
    entriesByDigest.set(normalized.digest, normalized);
    return normalized;
  }

  return Object.freeze({
    register,
    entries: () => Object.freeze([...entries.values()]),
    selectedEntries: () => Object.freeze([...entries.values()].filter((entry) => entry.selectedByMatching)),
    findByDigest: (digest) => entriesByDigest.get(digest) ?? null,
  });
}

export function hoboAdd({
  catalog,
  listing,
  candidate,
  trustBoundary,
  considerCost,
  considerMirrors,
} = {}) {
  const targetCatalog = catalog ?? createHoboAddCatalog();
  const reasons = [];
  const parsed = parseDescriptor(listing);

  if (!parsed.ok) {
    reasons.push(...parsed.errors.map((error) => `descriptor.invalid: ${error}`));
  }

  reasons.push(...preflightReasons({ descriptor: parsed.descriptor, candidate }));
  const installVerification = verifyInstallCandidate({ candidate, trustBoundary });
  reasons.push(...installVerification.reasons);

  if (uniqueReasons(reasons).length > 0) {
    return rejected(uniqueReasons(reasons));
  }

  ensureInstallDoesNotSelect({ considerCost, considerMirrors });

  const entry = targetCatalog.register({
    listing: {
      kind: parsed.descriptor.kind,
      name: parsed.descriptor.name,
      version: parsed.descriptor.version,
    },
    coordinate: installVerification.ref.coordinate,
    mediaType: installVerification.ref.mediaType,
    uri: installVerification.ref.uri,
    digest: installVerification.ref.digest,
    availableToMatching: true,
    selectedByMatching: false,
    assurance: installVerification.assurance,
    trust: installVerification.trust,
  });

  return Object.freeze({
    ok: true,
    reasons: Object.freeze([]),
    contract: HOBO_ADD_INSTALL_CONTRACT,
    entry,
    availableToMatching: true,
    selectedByMatching: false,
  });
}

function preflightReasons({ descriptor, candidate }) {
  const reasons = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return ["candidate.required"];
  }

  if (!candidate.signature) {
    reasons.push("signature.required");
  }
  if (!candidate.provenance) {
    reasons.push("provenance.required");
  }
  if (!candidate.conformance) {
    reasons.push("conformance.required");
  }

  if (descriptor?.artifact?.digest && candidate.artifact?.digest && descriptor.artifact.digest !== candidate.artifact.digest) {
    reasons.push("descriptor.artifact_digest_mismatch");
  }

  if (descriptor?.evidence?.conformanceReportRefs?.length === 0) {
    reasons.push("descriptor.conformance_report.required");
  }

  return reasons;
}

function ensureInstallDoesNotSelect({ considerCost, considerMirrors }) {
  if (considerCost !== undefined && !(considerCost instanceof Function)) {
    throw new TypeError("considerCost must be a function when provided");
  }
  if (considerMirrors !== undefined && !(considerMirrors instanceof Function)) {
    throw new TypeError("considerMirrors must be a function when provided");
  }
}

function rejected(reasons) {
  return Object.freeze({
    ok: false,
    reasons: Object.freeze(reasons),
    contract: HOBO_ADD_INSTALL_CONTRACT,
    availableToMatching: false,
    selectedByMatching: false,
  });
}

function uniqueReasons(reasons) {
  return Object.freeze([...new Set(reasons)]);
}

function entryKey(entry) {
  return `${entry.listing.name}@${entry.listing.version}:${entry.digest}`;
}
