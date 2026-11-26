import { createInBoundaryRegistryMirror, createRegistryImporter } from "../../registry-import-contract/src/registry-import.js";
import { parseBundleManifest } from "../../signed-offline-bundle-contract/src/bundle-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const OFFLINE_IMPORT_INTEGRITY_CONTRACT = "hobo.offline-import-integrity/v1";

export function createOfflineIntegrityImporter({
  mirror = createInBoundaryRegistryMirror(),
  now = () => new Date().toISOString(),
} = {}) {
  const baseImporter = createRegistryImporter({ mirror, now });

  return Object.freeze({
    importBundle({
      bundle,
      payloads,
      trustBoundary,
      offlineTrust,
      installedState = { artifacts: [] },
      forceDowngrade = null,
      onEgressAttempt = null,
    } = {}) {
      const importedAt = now();
      const parsed = parseBundleManifest(bundle);
      if (!parsed.ok) {
        return rejected({
          reasons: parsed.errors.map((error) => `bundle.invalid: ${error}`),
          mirror,
        });
      }

      const gate = evaluateOfflineGates({
        manifest: parsed.manifest,
        payloads,
        offlineTrust,
        installedState,
        forceDowngrade,
        importedAt,
      });

      if (!gate.ok) {
        const event = recordBundleImported({
          mirror,
          manifest: parsed.manifest,
          importedAt,
          status: "Refused",
          verification: gate.verification,
          artifacts: gate.artifacts,
          forceDowngrade: gate.forceDowngrade,
        });

        return Object.freeze({
          ok: false,
          contract: OFFLINE_IMPORT_INTEGRITY_CONTRACT,
          reasons: Object.freeze(gate.reasons),
          artifacts: Object.freeze(gate.artifacts.map(clone)),
          event: clone(event),
          mirror,
        });
      }

      const imported = baseImporter.importBundle({ bundle, payloads, trustBoundary, onEgressAttempt });
      const importedArtifactEvents = imported.artifacts.map((artifact) => ({
        name: artifact.name,
        version: artifact.version,
        kind: artifact.kind,
        digest: artifact.digest,
        status: artifact.status,
        reasons: artifact.reasons,
      }));
      const baseImageGateEvents = gate.artifacts
        .filter((artifact) => artifact.section === "baseImages")
        .map(({ section: _section, ...artifact }) => artifact);
      const event = recordBundleImported({
        mirror,
        manifest: parsed.manifest,
        importedAt,
        status: imported.ok ? "Imported" : "Partial",
        verification: {
          signature: imported.event?.verification?.signature ?? "checked",
          provenance: imported.event?.verification?.provenance ?? "checked",
          conformance: imported.event?.verification?.conformance ?? "checked",
          revocation: gate.verification.revocation,
          antiRollback: gate.verification.antiRollback,
          transparency: gate.verification.transparency,
        },
        artifacts: [
          ...importedArtifactEvents,
          ...baseImageGateEvents,
        ],
        forceDowngrade: gate.forceDowngrade,
      });

      return Object.freeze({
        ok: imported.ok,
        contract: OFFLINE_IMPORT_INTEGRITY_CONTRACT,
        reasons: imported.reasons,
        artifacts: imported.artifacts,
        event: clone(event),
        mirror,
      });
    },
    mirror,
  });
}

function evaluateOfflineGates({
  manifest,
  payloads,
  offlineTrust,
  installedState,
  forceDowngrade,
  importedAt,
}) {
  const artifacts = [];
  const reasons = [];
  let revocationFailed = false;
  let antiRollbackFailed = false;
  let transparencyFailed = false;
  let forceDowngradeUsed = false;

  for (const artifact of gateArtifactsFor(manifest)) {
    const artifactReasons = [
      ...checkRevocationGate({ manifest, artifact, payloads, offlineTrust, importedAt }),
      ...checkAntiRollbackGate({ artifact, installedState, forceDowngrade }),
      ...checkTransparencyGate({ manifest, artifact, offlineTrust }),
    ];

    if (artifactReasons.some((reason) => reason.startsWith("revocation."))) {
      revocationFailed = true;
    }
    if (artifactReasons.some((reason) => reason.startsWith("antiRollback."))) {
      antiRollbackFailed = true;
    }
    if (artifactReasons.some((reason) => reason.startsWith("transparency."))) {
      transparencyFailed = true;
    }
    if (needsForceDowngrade({ artifact, installedState }) && isValidForceDowngrade(forceDowngrade)) {
      forceDowngradeUsed = true;
    }

    const status = artifactReasons.length > 0 ? "refused" : "accepted";
    artifacts.push(Object.freeze({
      section: artifact.section,
      name: artifact.name,
      version: artifact.version,
      kind: artifact.kind,
      digest: artifact.digest,
      status,
      reasons: Object.freeze(artifactReasons),
    }));

    if (artifactReasons.length > 0) {
      reasons.push(`artifact ${artifact.label} refused: ${artifactReasons.join(",")}`);
    }
  }

  return Object.freeze({
    ok: reasons.length === 0,
    reasons: Object.freeze(reasons),
    artifacts: Object.freeze(artifacts),
    verification: Object.freeze({
      revocation: revocationFailed ? "failed" : "passed",
      antiRollback: antiRollbackFailed
        ? "failed"
        : forceDowngradeUsed
          ? "passed-with-force-downgrade"
          : "passed",
      transparency: transparencyFailed ? "failed" : "passed",
    }),
    forceDowngrade: forceDowngradeUsed ? clone(forceDowngrade) : null,
  });
}

function gateArtifactsFor(manifest) {
  return Object.freeze([
    ...manifest.contents.listings.map((listing) => Object.freeze({
      section: "listings",
      kind: listing.kind,
      name: listing.name,
      version: listing.version,
      digest: listing.descriptor.digest,
      payloadDigest: listing.descriptor.digest,
      buildTimestamp: listing.buildTimestamp,
      transparency: listing.transparency,
      label: `${listing.name}@${listing.version}`,
    })),
    ...(manifest.contents.baseImages ?? []).map((image) => Object.freeze({
      section: "baseImages",
      kind: "base-image",
      name: image.name,
      version: image.version ?? "unversioned",
      digest: image.artifact.digest,
      payloadDigest: image.artifact.digest,
      buildTimestamp: image.buildTimestamp,
      transparency: image.transparency,
      label: `${image.name}@${image.version ?? "unversioned"}`,
    })),
  ]);
}

function checkRevocationGate({ manifest, artifact, payloads, offlineTrust, importedAt }) {
  const revocationList = offlineTrust?.revocationList;
  if (!revocationList) {
    return ["revocation.missing"];
  }

  const reasons = [];
  if (revocationList.refDigest !== manifest.trust.revocationList.ref.digest) {
    reasons.push("revocation.digest_mismatch");
  }
  if (revocationList.signedBy !== manifest.trust.revocationList.signingKeyId) {
    reasons.push("revocation.signer_mismatch");
  }
  if (revocationList.signatureVerified !== true) {
    reasons.push("revocation.signature_invalid");
  }
  if (Date.parse(importedAt) > Date.parse(revocationList.expiresAt)) {
    reasons.push("revocation.expired");
  }

  const keyId = payloadFor(payloads, artifact.payloadDigest)?.candidate?.signature?.keyId;
  if (!keyId) {
    reasons.push("revocation.signing_key_unknown");
  } else if ((revocationList.revokedKeyIds ?? []).includes(keyId)) {
    reasons.push(`revocation.revoked_key:${keyId}`);
  }

  return reasons;
}

function checkAntiRollbackGate({ artifact, installedState, forceDowngrade }) {
  const rollback = rollbackFinding({ artifact, installedState });
  if (!rollback) {
    return [];
  }
  if (isValidForceDowngrade(forceDowngrade)) {
    return [];
  }
  return [`antiRollback.older_than_installed:${artifact.name}@${artifact.version}:${rollback}`];
}

function checkTransparencyGate({ manifest, artifact, offlineTrust }) {
  const proof = proofFor(offlineTrust?.transparencyProofs, artifact.transparency.inclusionProof.digest);
  if (!proof) {
    return [`transparency.inclusion_proof_missing:${artifact.transparency.inclusionProof.digest}`];
  }

  const reasons = [];
  if (proof.verified !== true) {
    reasons.push(`transparency.inclusion_proof_invalid:${artifact.transparency.inclusionProof.digest}`);
  }
  if (proof.logId !== manifest.trust.transparencyLog.logId) {
    reasons.push("transparency.log_mismatch");
  }
  if (proof.logRoot !== manifest.trust.transparencyLog.pinnedRoot) {
    reasons.push("transparency.root_mismatch");
  }
  if (proof.artifactDigest !== artifact.digest) {
    reasons.push("transparency.artifact_digest_mismatch");
  }
  return reasons;
}

function needsForceDowngrade({ artifact, installedState }) {
  return Boolean(rollbackFinding({ artifact, installedState }));
}

function rollbackFinding({ artifact, installedState }) {
  const installed = (installedState?.artifacts ?? []).find((installedArtifact) =>
    installedArtifact.name === artifact.name
  );
  if (!installed) {
    return null;
  }

  if (installed.buildTimestamp && Date.parse(artifact.buildTimestamp) < Date.parse(installed.buildTimestamp)) {
    return "buildTimestamp";
  }
  if (installed.version && artifact.version !== "unversioned" && compareVersions(artifact.version, installed.version) < 0) {
    return "version";
  }
  return null;
}

function isValidForceDowngrade(forceDowngrade) {
  return isNonEmptyString(forceDowngrade?.approvedBy)
    && isNonEmptyString(forceDowngrade?.reason)
    && isNonEmptyString(forceDowngrade?.ticket);
}

function recordBundleImported({
  mirror,
  manifest,
  importedAt,
  status,
  verification,
  artifacts,
  forceDowngrade,
}) {
  const event = {
    type: "registry.BundleImported",
    contract: OFFLINE_IMPORT_INTEGRITY_CONTRACT,
    bundleDigest: manifest.bundleDigest,
    importedAt,
    status,
    verification: clone(verification),
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      version: artifact.version,
      kind: artifact.kind,
      digest: artifact.digest,
      status: artifact.status,
      reasons: artifact.reasons,
    })),
  };
  if (forceDowngrade) {
    event.forceDowngrade = clone(forceDowngrade);
  }
  mirror.recordImportEvent?.(event);
  return Object.freeze(event);
}

function payloadFor(payloads, digest) {
  if (payloads instanceof Map) {
    return payloads.get(digest) ?? null;
  }
  if (payloads && isJsonObject(payloads) && !Array.isArray(payloads)) {
    return payloads[digest] ?? null;
  }
  return null;
}

function proofFor(proofs, digest) {
  if (proofs instanceof Map) {
    return proofs.get(digest) ?? null;
  }
  if (proofs && isJsonObject(proofs) && !Array.isArray(proofs)) {
    return proofs[digest] ?? null;
  }
  return null;
}

function rejected({ reasons, mirror }) {
  return Object.freeze({
    ok: false,
    contract: OFFLINE_IMPORT_INTEGRITY_CONTRACT,
    reasons: Object.freeze(reasons),
    artifacts: Object.freeze([]),
    event: null,
    mirror,
  });
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".");
  const rightParts = String(right).split(".");
  const max = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < max; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);

    if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return Math.sign(leftNumber - rightNumber);
      }
      continue;
    }

    const compared = leftPart.localeCompare(rightPart);
    if (compared !== 0) {
      return Math.sign(compared);
    }
  }

  return 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
