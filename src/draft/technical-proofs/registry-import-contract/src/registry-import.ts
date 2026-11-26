import { createHash } from "node:crypto";

import {
  canonicalJson as descriptorCanonicalJson,
  parseDescriptor,
} from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import { hoboAdd } from "../../hobo-add-install-verification-contract/src/hobo-add-install-verification.js";
import { parseBundleManifest } from "../../signed-offline-bundle-contract/src/bundle-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const REGISTRY_IMPORT_CONTRACT = "hobo.registry-import/v1";

const MISSING_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export function createRegistryImporter({
  mirror = createInBoundaryRegistryMirror(),
  now = () => new Date().toISOString(),
} = {}) {
  return Object.freeze({
    importBundle({ bundle, payloads, trustBoundary } = {}) {
      const parsed = parseBundleManifest(bundle);
      if (!parsed.ok) {
        return rejected(parsed.errors.map((error) => `bundle.invalid: ${error}`));
      }

      const artifacts = [];
      const reasons = [];

      for (const listing of parsed.manifest.contents.listings) {
        const payload = payloadFor(payloads, listing.descriptor.digest);
        if (!payload) {
          const reason = `payload.missing:${listing.descriptor.digest}`;
          reasons.push(`artifact ${listing.name}@${listing.version} refused: ${reason}`);
          artifacts.push(refusedArtifact({ listing, reasons: [reason] }));
          continue;
        }

        const descriptorCheck = verifyDescriptorDigest({
          descriptor: payload.descriptor,
          expectedDigest: listing.descriptor.digest,
        });
        if (!descriptorCheck.ok) {
          reasons.push(`artifact ${listing.name}@${listing.version} refused: ${descriptorCheck.reasons.join(",")}`);
          artifacts.push(refusedArtifact({ listing, reasons: descriptorCheck.reasons }));
          continue;
        }

        const checked = hoboAdd({
          catalog: mirror.installCatalog,
          listing: payload.descriptor,
          candidate: payload.candidate,
          trustBoundary,
        });

        if (!checked.ok) {
          const artifactReasons = [...checked.reasons];
          reasons.push(`artifact ${listing.name}@${listing.version} refused: ${artifactReasons.join(",")}`);
          artifacts.push(refusedArtifact({ listing, reasons: artifactReasons }));
          continue;
        }

        const imported = mirror.importListing({
          bundleDigest: parsed.manifest.bundleDigest,
          descriptor: payload.descriptor,
          candidate: payload.candidate,
          installEntry: checked.entry,
        });
        artifacts.push(imported);
      }

      const event = {
        type: "registry.BundleImported",
        contract: REGISTRY_IMPORT_CONTRACT,
        bundleDigest: parsed.manifest.bundleDigest,
        importedAt: now(),
        status: reasons.length === 0 ? "Imported" : "Partial",
        verification: Object.freeze({
          signature: "checked",
          provenance: "checked",
          conformance: "checked",
        }),
        deferredAirGapGates: Object.freeze(["revocation", "antiRollback", "transparency"]),
        artifacts: Object.freeze(artifacts.map((artifact) => ({
          name: artifact.name,
          version: artifact.version,
          kind: artifact.kind,
          digest: artifact.digest,
          status: artifact.status,
          reasons: artifact.reasons,
        }))),
      };
      mirror.recordImportEvent(event);

      return Object.freeze({
        ok: reasons.length === 0,
        contract: REGISTRY_IMPORT_CONTRACT,
        reasons: Object.freeze(reasons),
        artifacts: Object.freeze(artifacts.map(clone)),
        event: clone(event),
      });
    },
    mirror,
  });
}

export function createInBoundaryRegistryMirror() {
  const entriesByDigest = new Map();
  const digestsByCoordinate = new Map();
  const importEvents = [];
  const installEntries = [];
  const installCatalog = {
    register(entry) {
      const existingIndex = installEntries.findIndex((candidate) => candidate.digest === entry.digest);
      if (existingIndex === -1) {
        installEntries.push(clone(entry));
        return entry;
      }
      installEntries[existingIndex] = clone(entry);
      return installEntries[existingIndex];
    },
    entries() {
      return Object.freeze(installEntries.map(clone));
    },
    selectedEntries() {
      return Object.freeze(installEntries.filter((entry) => entry.selectedByMatching).map(clone));
    },
    findByDigest(digest) {
      return installEntries.find((entry) => entry.digest === digest) ?? null;
    },
  };

  const mirror = {
    installCatalog,

    importListing({ bundleDigest, descriptor, candidate, installEntry }) {
      const parsed = parseDescriptor(descriptor);
      if (!parsed.ok) {
        throw new Error(`descriptor invalid\n${parsed.errors.join("\n")}`);
      }

      const coordinate = {
        name: parsed.descriptor.name,
        version: parsed.descriptor.version,
      };
      const digest = installEntry.digest;
      const existing = entriesByDigest.get(digest);
      if (existing) {
        return importSnapshot(existing, "already-imported");
      }

      const entry = Object.freeze({
        contract: REGISTRY_IMPORT_CONTRACT,
        bundleDigest,
        kind: parsed.descriptor.kind,
        name: coordinate.name,
        version: coordinate.version,
        coordinateKey: coordinateKey(coordinate),
        digest,
        descriptor: clone(parsed.descriptor),
        artifact: clone(candidate.artifact),
        assurance: installEntry.assurance,
        availableOffline: true,
      });
      entriesByDigest.set(digest, entry);
      digestsByCoordinate.set(entry.coordinateKey, [
        ...(digestsByCoordinate.get(entry.coordinateKey) ?? []),
        digest,
      ]);

      return importSnapshot(entry, "imported");
    },

    discover(coordinate) {
      const digests = digestsByCoordinate.get(coordinateKey(coordinate)) ?? [];
      const entry = entriesByDigest.get(digests.at(-1));
      return entry ? clone(entry) : null;
    },

    install(coordinate) {
      const entry = this.discover(coordinate);
      if (!entry) {
        throw new Error(`mirror listing ${coordinate.name}@${coordinate.version} not found; live crawl disabled`);
      }
      return entry;
    },

    serve(digest, _options = {}) {
      if (!MISSING_DIGEST_RE.test(String(digest))) {
        throw new Error("mirror artifact digest must be sha256:<64 hex chars>");
      }
      const entry = entriesByDigest.get(digest);
      if (!entry) {
        throw new Error(`mirror artifact ${digest} not found; live crawl disabled`);
      }
      return {
        digest: entry.digest,
        descriptor: clone(entry.descriptor),
        artifact: clone(entry.artifact),
      };
    },

    entries() {
      return [...entriesByDigest.values()].map(clone);
    },

    history(coordinate) {
      return (digestsByCoordinate.get(coordinateKey(coordinate)) ?? [])
        .map((digest) => entriesByDigest.get(digest))
        .filter(Boolean)
        .map(clone);
    },

    recordImportEvent(event) {
      importEvents.push(Object.freeze({
        seq: importEvents.length + 1,
        ...clone(event),
      }));
    },

    events() {
      return importEvents.map(clone);
    },
  };

  return Object.freeze(mirror);
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

function verifyDescriptorDigest({ descriptor, expectedDigest }) {
  const parsed = parseDescriptor(descriptor);
  if (!parsed.ok) {
    return {
      ok: false,
      reasons: Object.freeze(parsed.errors.map((error) => `descriptor.invalid: ${error}`)),
    };
  }

  const actualDigest = `sha256:${createHash("sha256").update(descriptorCanonicalJson(parsed.descriptor)).digest("hex")}`;
  if (actualDigest !== expectedDigest) {
    return {
      ok: false,
      reasons: Object.freeze([`descriptor.digest_mismatch:${expectedDigest}`]),
    };
  }

  return { ok: true, reasons: Object.freeze([]) };
}

function refusedArtifact({ listing, reasons }) {
  return Object.freeze({
    kind: listing.kind,
    name: listing.name,
    version: listing.version,
    digest: listing.descriptor.digest,
    status: "refused",
    reasons: Object.freeze([...reasons]),
  });
}

function importSnapshot(entry, status) {
  return Object.freeze({
    kind: entry.kind,
    name: entry.name,
    version: entry.version,
    digest: entry.digest,
    status,
    reasons: Object.freeze([]),
    availableOffline: true,
  });
}

function rejected(reasons) {
  return Object.freeze({
    ok: false,
    contract: REGISTRY_IMPORT_CONTRACT,
    reasons: Object.freeze(reasons),
    artifacts: Object.freeze([]),
    event: null,
  });
}

function coordinateKey(coordinate) {
  if (!coordinate || !isJsonObject(coordinate) || Array.isArray(coordinate)) {
    throw new Error("mirror coordinate must be an object");
  }
  if (!isJsonString(coordinate.name) || coordinate.name.length === 0) {
    throw new Error("mirror coordinate name must be a non-empty string");
  }
  if (!isJsonString(coordinate.version) || coordinate.version.length === 0) {
    throw new Error("mirror coordinate version must be a non-empty string");
  }
  return `${coordinate.name}@${coordinate.version}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
