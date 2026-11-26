import { createHash } from "node:crypto";

import { hoboAdd } from "../../hobo-add-install-verification-contract/src/hobo-add-install-verification.js";
import { canonicalJson as descriptorCanonicalJson, parseDescriptor } from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import { createInBoundaryRegistryMirror, createRegistryImporter } from "../../registry-import-contract/src/registry-import.js";
import { canonicalJson } from "../../signed-offline-bundle-contract/src/bundle-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const JUNCTION_REGISTRY_FEDERATION_CONTRACT = "hobo.junction-registry-federation/v1";
export const JUNCTION_ARTIFACT_SHARED_EVENT = "junction.ArtifactShared";

export function createFederatedYard({ yardId, trustBoundary, now = () => new Date().toISOString() } = {}) {
  assertNonEmptyString(yardId, "yardId");
  const mirror = createInBoundaryRegistryMirror();
  const importer = createRegistryImporter({ mirror, now });
  const listings = new Map();
  const localYanks = new Map();
  const registryLog = [];

  return Object.freeze({
    yardId,
    mirror,
    trustBoundary,

    certifyListing({ descriptor, candidate } = {}) {
      const parsed = parseDescriptor(descriptor);
      if (!parsed.ok) {
        return rejected(parsed.errors.map((error) => `descriptor.invalid: ${error}`));
      }

      const checked = hoboAdd({ listing: descriptor, candidate, trustBoundary });
      if (!checked.ok) {
        return rejected(checked.reasons);
      }

      const coordinate = {
        name: parsed.descriptor.name,
        version: parsed.descriptor.version,
      };
      const entry = Object.freeze({
        coordinate,
        descriptor: clone(parsed.descriptor),
        descriptorDigest: digestDescriptor(parsed.descriptor),
        candidate: clone(candidate),
        artifactDigest: checked.entry.digest,
        status: "certified",
      });
      listings.set(coordinateKey(coordinate), entry);
      appendRegistryLog(registryLog, {
        action: "listing.certified",
        coordinate,
        artifactDigest: entry.artifactDigest,
        at: now(),
      });

      return { ok: true, reasons: Object.freeze([]), entry: clone(entry) };
    },

    yankListing(coordinate, { reason } = {}) {
      const key = coordinateKey(coordinate);
      const entry = listings.get(key);
      if (!entry) {
        return rejected([`listing.not_found:${key}`]);
      }
      assertNonEmptyString(reason, "reason");
      listings.set(key, Object.freeze({
        ...entry,
        status: "yanked",
        reason,
      }));
      appendRegistryLog(registryLog, {
        action: "listing.yanked",
        coordinate: entry.coordinate,
        reason,
        at: now(),
      });
      return { ok: true, reasons: Object.freeze([]) };
    },

    exportBundle({ coordinate, targetYardId } = {}) {
      const entry = listings.get(coordinateKey(coordinate));
      if (!entry) {
        return rejected([`listing.not_found:${coordinateKey(coordinate)}`]);
      }
      if (entry.status !== "certified") {
        return rejected([`listing.not_certified:${coordinateKey(coordinate)}`]);
      }

      const bundle = bundleFor({
        sourceYardId: yardId,
        targetYardId,
        descriptor: entry.descriptor,
        descriptorDigest: entry.descriptorDigest,
        now: now(),
      });
      appendRegistryLog(registryLog, {
        action: "bundle.exported",
        coordinate: entry.coordinate,
        bundleDigest: bundle.bundleDigest,
        targetYardId,
        at: now(),
      });

      return {
        ok: true,
        reasons: Object.freeze([]),
        bundle,
        payloads: new Map([[entry.descriptorDigest, {
          descriptor: clone(entry.descriptor),
          candidate: clone(entry.candidate),
        }]]),
        sourceRegistryLogSeq: registryLog.at(-1).seq,
      };
    },

    importBundle({ bundle, payloads } = {}) {
      const result = importer.importBundle({ bundle, payloads, trustBoundary });
      appendRegistryLog(registryLog, {
        action: "bundle.imported",
        bundleDigest: bundle?.bundleDigest,
        status: result.ok ? "imported" : "refused",
        reasons: result.reasons,
        at: now(),
      });
      return {
        ...result,
        targetRegistryLogSeq: registryLog.at(-1).seq,
      };
    },

    discover(coordinate) {
      if (localYanks.has(coordinateKey(coordinate))) {
        return null;
      }
      return mirror.discover(coordinate);
    },

    install(coordinate) {
      const yank = localYanks.get(coordinateKey(coordinate));
      if (yank) {
        throw new Error(`listing ${coordinateKey(coordinate)} is locally yanked: ${yank.reason}`);
      }
      return mirror.install(coordinate);
    },

    applyPeerYank({ coordinate, sourceYardId, reason } = {}) {
      const key = coordinateKey(coordinate);
      assertNonEmptyString(sourceYardId, "sourceYardId");
      assertNonEmptyString(reason, "reason");
      localYanks.set(key, Object.freeze({
        coordinate: clone(coordinate),
        status: "yanked",
        reason,
        sourceYardId,
      }));
      appendRegistryLog(registryLog, {
        action: "peer-yank.applied",
        coordinate,
        sourceYardId,
        reason,
        at: now(),
      });
      return { ok: true, reasons: Object.freeze([]) };
    },

    getListingState(coordinate) {
      const key = coordinateKey(coordinate);
      const localYank = localYanks.get(key);
      if (localYank) {
        return clone(localYank);
      }
      const listing = listings.get(key);
      if (listing?.status === "yanked") {
        return {
          coordinate: clone(coordinate),
          status: "yanked",
          reason: listing.reason,
          sourceYardId: yardId,
        };
      }
      const imported = mirror.discover(coordinate);
      if (imported) {
        return {
          coordinate: clone(coordinate),
          status: "imported",
          digest: imported.digest,
        };
      }
      return {
        coordinate: clone(coordinate),
        status: "absent",
      };
    },

    registryLog() {
      return registryLog.map(clone);
    },
  });
}

export function createJunctionRegistryFederation({ yards, now = () => new Date().toISOString() } = {}) {
  const yardById = new Map((yards ?? []).map((yard) => [yard.yardId, yard]));
  const events = [];

  return Object.freeze({
    shareArtifact({ sourceYardId, targetYardId, coordinate } = {}) {
      const source = requiredYard(yardById, sourceYardId, "sourceYardId");
      const target = requiredYard(yardById, targetYardId, "targetYardId");
      const exported = source.exportBundle({ coordinate, targetYardId });
      if (!exported.ok) {
        return rejected(exported.reasons);
      }

      const imported = target.importBundle({
        bundle: clone(exported.bundle),
        payloads: clonePayloadMap(exported.payloads),
      });
      if (!imported.ok) {
        return rejected(imported.reasons);
      }

      const event = Object.freeze({
        type: JUNCTION_ARTIFACT_SHARED_EVENT,
        contract: JUNCTION_REGISTRY_FEDERATION_CONTRACT,
        sourceYardId,
        targetYardId,
        coordinate: clone(coordinate),
        bundleDigest: exported.bundle.bundleDigest,
        artifactDigests: Object.freeze(imported.artifacts.map((artifact) => artifact.digest)),
        sourceRegistryLogSeq: exported.sourceRegistryLogSeq,
        targetRegistryLogSeq: imported.targetRegistryLogSeq,
        sharedAt: now(),
      });
      events.push(event);

      return {
        ok: true,
        reasons: Object.freeze([]),
        event: clone(event),
        importResult: clone(imported),
      };
    },

    applyPeerYank({ sourceYardId, targetYardId, coordinate } = {}) {
      const source = requiredYard(yardById, sourceYardId, "sourceYardId");
      const target = requiredYard(yardById, targetYardId, "targetYardId");
      const sourceState = source.getListingState(coordinate);
      if (sourceState.status !== "yanked") {
        return rejected([`source.not_yanked:${coordinateKey(coordinate)}`]);
      }
      return target.applyPeerYank({
        coordinate,
        sourceYardId,
        reason: sourceState.reason,
      });
    },

    events() {
      return events.map(clone);
    },
  });
}

function bundleFor({ sourceYardId, targetYardId, descriptor, descriptorDigest, now }) {
  const logRoot = digest(`${sourceYardId}:${targetYardId}:junction-log-root`);
  const bundle = {
    schema: "registry.bundle/v1",
    bundleId: `junction.${sourceYardId}.to.${targetYardId}.${descriptor.name}.${descriptor.version}`,
    version: "1.0.0",
    createdAt: now,
    curator: {
      id: sourceYardId,
      trustDomain: `spiffe://${sourceYardId}`,
    },
    contents: {
      listings: [
        {
          kind: descriptor.kind,
          name: descriptor.name,
          version: descriptor.version,
          descriptor: artifactRef("descriptor", descriptorDigest),
          buildTimestamp: now,
          provenance: descriptor.evidence.slsaProvenanceRef,
          conformanceReports: descriptor.evidence.conformanceReportRefs.map((report) => report.ref),
          transparency: transparencyProof(logRoot),
        },
      ],
      baseImages: [
        {
          name: "junction-transfer-envelope",
          artifact: artifactRef("base-image", digest("junction-transfer-envelope")),
          buildTimestamp: now,
          provenance: artifactRef("base-provenance", digest("junction-transfer-base-provenance")),
          transparency: transparencyProof(logRoot),
        },
      ],
    },
    trust: {
      revocationList: {
        issuedAt: now,
        expiresAt: "2026-07-26T08:30:00.000Z",
        signingKeyId: `${sourceYardId}-offline-revocation-root`,
        ref: artifactRef("revocation", digest(`${sourceYardId}:revocation:${now}`)),
      },
      transparencyLog: {
        logId: "junction-federation-log",
        pinnedRoot: logRoot,
      },
      antiRollback: {
        yardId: targetYardId,
        stateEpoch: now,
      },
    },
  };
  bundle.bundleDigest = digestText(canonicalJson(withoutKey(bundle, "bundleDigest")));
  return bundle;
}

function appendRegistryLog(registryLog, entry) {
  registryLog.push(Object.freeze({
    seq: registryLog.length + 1,
    ...clone(entry),
  }));
}

function transparencyProof(logRoot) {
  return {
    logId: "junction-federation-log",
    logRoot,
    inclusionProof: artifactRef("inclusion-proof", digest(`inclusion:${logRoot}`)),
  };
}

function artifactRef(name, digestValue) {
  return {
    mediaType: "application/vnd.hobo.registry.descriptor.v1+json",
    uri: `oci://registry.example/hobo/${name}@${digestValue}`,
    digest: digestValue,
  };
}

function requiredYard(yardById, yardId, name) {
  assertNonEmptyString(yardId, name);
  const yard = yardById.get(yardId);
  if (!yard) {
    throw new Error(`${name} ${yardId} is not registered in this Junction`);
  }
  return yard;
}

function coordinateKey(coordinate) {
  if (!coordinate || !isJsonObject(coordinate) || Array.isArray(coordinate)) {
    throw new Error("coordinate must be an object");
  }
  assertNonEmptyString(coordinate.name, "coordinate.name");
  assertNonEmptyString(coordinate.version, "coordinate.version");
  return `${coordinate.name}@${coordinate.version}`;
}

function clonePayloadMap(payloads) {
  return new Map([...payloads.entries()].map(([key, value]) => [key, clone(value)]));
}

function digestDescriptor(value) {
  return `sha256:${createHash("sha256").update(descriptorCanonicalJson(value)).digest("hex")}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function withoutKey(value, keyToRemove) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== keyToRemove));
}

function rejected(reasons) {
  return Object.freeze({
    ok: false,
    reasons: Object.freeze([...reasons]),
    event: null,
  });
}

function assertNonEmptyString(value, name) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
