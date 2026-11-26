import { isJsonString } from "./json.js";
import { hoboAdd, createHoboAddCatalog } from "../../hobo-add-install-verification-contract/src/hobo-add-install-verification.js";
import { createListingLifecycle } from "../../listing-lifecycle-yank-contract/src/listing-lifecycle-yank.js";
import { resolvePinnedRegistryArtifact } from "../../registry-dependency-confusion-guard-contract/src/registry-dependency-confusion-guard.js";

export const REGISTRY_COMPROMISE_GUARD_CONTRACT = "hobo.registry-compromise-guard/v1";

export function verifyRegistryInstallAgainstCompromise({
  catalog,
  listing,
  candidate,
  trustBoundary,
} = {}) {
  const targetCatalog = catalog ?? createHoboAddCatalog();
  const binding = verifyConformanceReportBinding({ listing, candidate });
  if (!binding.ok) {
    return rejected({
      reasons: binding.reasons,
      stage: "conformance-binding",
      catalog: targetCatalog,
    });
  }

  const install = hoboAdd({
    catalog: targetCatalog,
    listing,
    candidate,
    trustBoundary,
  });

  if (!install.ok) {
    return rejected({
      reasons: install.reasons,
      stage: "install-verification",
      catalog: targetCatalog,
    });
  }

  return Object.freeze({
    ok: true,
    contract: REGISTRY_COMPROMISE_GUARD_CONTRACT,
    stage: "install-verification",
    reasons: Object.freeze([]),
    entry: install.entry,
    assurance: "integrity-and-conformance-verified-not-benignity-proof",
    residualRisks: Object.freeze([
      "validly-signed-but-malicious",
      "compromised-builder-or-key",
      "forged-report-from-compromised-pipeline",
    ]),
    mitigations: Object.freeze([
      "fresh-capability-spec-reverification",
      "listing-yank-on-disclosure",
      "pinned-digest-consumer-fetch",
    ]),
    catalogEntries: targetCatalog.entries(),
  });
}

export function verifyConformanceReportBinding({ listing, candidate } = {}) {
  const reasons = [];
  const descriptorReports = listing?.evidence?.conformanceReportRefs;
  const descriptorDigests = Array.isArray(descriptorReports)
    ? descriptorReports.map((report) => report?.ref?.digest).filter(Boolean)
    : [];

  if (!candidate?.conformance?.digest) {
    reasons.push("conformance.digest_required");
  } else if (!descriptorDigests.includes(candidate.conformance.digest)) {
    reasons.push("descriptor.conformance_report_digest_mismatch");
  }

  const certifiedArtifactDigest = candidate?.conformance?.report?.artifactDigest;
  if (!certifiedArtifactDigest) {
    reasons.push("conformance.artifact_digest_required");
  } else if (certifiedArtifactDigest !== candidate?.artifact?.digest) {
    reasons.push("conformance.artifact_digest_mismatch");
  }

  return Object.freeze({
    ok: reasons.length === 0,
    contract: REGISTRY_COMPROMISE_GUARD_CONTRACT,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export function reverifyCapabilitySpecAndYankOnRegression({
  lifecycle,
  certifiedListing,
  runningSet,
  expectedExports,
  observedExports,
  actor,
  occurredAt,
} = {}) {
  const targetLifecycle = lifecycle ?? createListingLifecycle();
  const listing = targetLifecycle.certify(certifiedListing);
  if (runningSet) {
    targetLifecycle.registerRunningSet(runningSet);
  }

  const missingExports = difference(expectedExports, observedExports);
  if (missingExports.length === 0) {
    return Object.freeze({
      ok: true,
      contract: REGISTRY_COMPROMISE_GUARD_CONTRACT,
      reason: "capability_spec.current",
      missingExports: Object.freeze([]),
      authorTimeSnapshotTrusted: false,
      evidenceSource: "fresh-reverification",
      canDeploy: targetLifecycle.canDeploy({
        selection: { listingId: listing.listingId },
        operation: "redeploy",
      }),
      doctor: targetLifecycle.doctor(),
    });
  }

  const yank = targetLifecycle.yank({
    listingId: listing.listingId,
    actor,
    reason: `capability-spec.regressed: missing ${missingExports.join(", ")}`,
    severity: "critical",
    occurredAt,
  });

  return Object.freeze({
    ok: false,
    contract: REGISTRY_COMPROMISE_GUARD_CONTRACT,
    reason: "capability_spec.regressed",
    missingExports: Object.freeze(missingExports),
    authorTimeSnapshotTrusted: false,
    evidenceSource: "fresh-reverification",
    yank,
    canDeploy: targetLifecycle.canDeploy({
      selection: { listingId: listing.listingId },
      operation: "redeploy",
    }),
    doctor: targetLifecycle.doctor(),
    events: Object.freeze(targetLifecycle.events()),
    obligations: Object.freeze(targetLifecycle.obligations()),
  });
}

export async function verifyPinnedRegistryFetch({ pin, mirrors, selectedMirrorId } = {}) {
  const result = await resolvePinnedRegistryArtifact({ pin, mirrors, selectedMirrorId });
  return Object.freeze({
    ...result,
    contract: REGISTRY_COMPROMISE_GUARD_CONTRACT,
    consumerDigestCheck: "required",
  });
}

function rejected({ reasons, stage, catalog }) {
  return Object.freeze({
    ok: false,
    contract: REGISTRY_COMPROMISE_GUARD_CONTRACT,
    stage,
    reasons: Object.freeze([...new Set(reasons)]),
    assurance: "rejected",
    residualRisks: Object.freeze([]),
    mitigations: Object.freeze([]),
    catalogEntries: catalog.entries(),
  });
}

function difference(expected, observed) {
  const observedSet = new Set(asStringArray(observed));
  return Object.freeze(asStringArray(expected).filter((value) => !observedSet.has(value)));
}

function asStringArray(values) {
  if (!Array.isArray(values)) {
    throw new Error("capability spec exports must be arrays");
  }
  return values.map((value) => {
    if (!isJsonString(value) || value.trim().length === 0) {
      throw new Error("capability spec exports must be non-empty strings");
    }
    return value;
  });
}
