import { createHash } from "node:crypto";

import {
  parseDescriptor,
  parseInterfaceRef
} from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import { verifyInstallCandidate } from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";

export const REGISTRY_PUBLISH_FLOW_CONTRACT = "hobo.registry-publish-flow/v1";

const DESCRIPTOR_MEDIA_TYPE = "application/vnd.hobo.registry.descriptor.v1+json";
const DEFAULT_OCI_REGISTRY = "registry.example";
const DEFAULT_OCI_NAMESPACE = "hobo";

export function createRegistryPublishFlow({
  ociStore = createInMemoryPublishArtifactStore()
} = {}) {
  const events = [];
  const listingsById = new Map();
  const certifiedByCoordinate = new Map();

  return Object.freeze({
    publish(input = {}) {
      const parsed = parseDescriptor(input.descriptor);
      if (!parsed.ok) {
        return rejected({
          status: "Rejected",
          reasons: parsed.errors.map((error) => `descriptor.invalid: ${error}`)
        });
      }

      const descriptor = parsed.descriptor;
      const preflightReasons = verifyPreflight({
        descriptor,
        signedArtifact: input.signedArtifact,
        trustBoundary: input.trustBoundary
      });
      if (preflightReasons.length > 0) {
        return rejected({ status: "Rejected", reasons: preflightReasons });
      }

      const storage = pushToOciStore({
        ociStore,
        descriptor,
        signedArtifact: input.signedArtifact
      });
      if (!storage.ok) {
        return rejected({ status: "Rejected", reasons: storage.reasons });
      }

      const coordinateKey = `${descriptor.name}@${descriptor.version}`;
      const previousListingId = certifiedByCoordinate.get(coordinateKey)?.at(-1) ?? null;
      const listing = createListing({
        descriptor,
        signedArtifact: input.signedArtifact,
        storageRef: storage.ref,
        occurredAt: input.occurredAt,
        previousListingId
      });
      listingsById.set(listing.listingId, listing);
      appendEvent(events, publishedEvent(listing));

      const certification = certifyDescriptor({
        descriptor,
        conformanceReports: input.conformanceReports
      });
      if (!certification.ok) {
        return rejected({
          status: "Published",
          reasons: certification.reasons,
          listing
        });
      }

      const certified = Object.freeze({
        ...listing,
        status: "Certified",
        certification: Object.freeze({
          status: "passed",
          reportRefs: certification.reportRefs
        })
      });
      listingsById.set(certified.listingId, certified);
      certifiedByCoordinate.set(coordinateKey, [
        ...(certifiedByCoordinate.get(coordinateKey) ?? []),
        certified.listingId
      ]);
      appendEvent(events, certifiedEvent(certified));

      return Object.freeze({
        ok: true,
        contract: REGISTRY_PUBLISH_FLOW_CONTRACT,
        status: "Certified",
        reasons: Object.freeze([]),
        listing: clone(certified)
      });
    },

    events() {
      return events.map(clone);
    },

    catalog() {
      return createCatalog({ listingsById, certifiedByCoordinate });
    },

    ociStore() {
      return ociStore;
    }
  });
}

function verifyPreflight({ descriptor, signedArtifact, trustBoundary }) {
  const reasons = [];
  const install = verifyInstallCandidate({
    candidate: signedArtifact,
    trustBoundary
  });
  reasons.push(...install.reasons.map((reason) => `signedArtifact.${reason}`));

  if (descriptor.artifact.digest !== signedArtifact?.artifact?.digest) {
    reasons.push("descriptor.artifact_digest_mismatch");
  }
  if (descriptor.artifact.mediaType !== signedArtifact?.artifact?.mediaType) {
    reasons.push("descriptor.artifact_media_type_mismatch");
  }

  const publisherDomain = descriptor.publisher?.trustDomain;
  const builderId = signedArtifact?.provenance?.slsa?.builder?.id;
  if (
    isString(publisherDomain) &&
    isString(builderId) &&
    builderId !== publisherDomain &&
    !builderId.startsWith(`${publisherDomain}/`)
  ) {
    reasons.push("publisher.identity_mismatch");
  }

  return unique(reasons);
}

function pushToOciStore({ ociStore, descriptor, signedArtifact }) {
  try {
    const pushed = ociStore.push({ descriptor, signedArtifact });
    return Object.freeze({
      ok: true,
      ref: clone(pushed.descriptorRef)
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reasons: [`oci.push_failed:${error.message}`]
    });
  }
}

function createListing({ descriptor, signedArtifact, storageRef, occurredAt, previousListingId }) {
  const listingId = listingIdFor({ descriptor, signedArtifact });
  return Object.freeze({
    contract: REGISTRY_PUBLISH_FLOW_CONTRACT,
    listingId,
    status: "Published",
    kind: descriptor.kind,
    name: descriptor.name,
    version: descriptor.version,
    artifact: clone(descriptor.artifact),
    descriptor: clone(descriptor),
    publisher: clone(descriptor.publisher),
    storageRef: clone(storageRef),
    signature: Object.freeze({
      alg: signedArtifact.signature.alg,
      keyId: signedArtifact.signature.keyId,
      payloadDigest: signedArtifact.signature.payloadDigest
    }),
    provenanceRef: clone(descriptor.evidence.slsaProvenanceRef),
    builderId: signedArtifact.provenance.slsa.builder.id,
    occurredAt,
    previousListingId,
    certification: null
  });
}

function certifyDescriptor({ descriptor, conformanceReports }) {
  const reports = Array.isArray(conformanceReports) ? conformanceReports : [];
  const reasons = [];
  const reportRefs = [];

  for (const declaration of descriptor.interfaces.exports) {
    const parsedRef = parseInterfaceRef(declaration.ref);
    const report = reports.find((candidate) => sameReportRef(candidate?.ref, declaration.conformanceReportRef));
    if (!report) {
      reasons.push(`conformance.report_missing:${declaration.ref}`);
      continue;
    }
    if (report.status !== "passed" && report.passed !== true) {
      reasons.push(`conformance.report_failed:${declaration.ref}`);
    }
    if (report.suite !== declaration.conformanceSuite) {
      reasons.push(`conformance.suite_mismatch:${declaration.ref}`);
    }
    if (report.suiteVersion !== declaration.conformanceSuiteVersion) {
      reasons.push(`conformance.suite_version_mismatch:${declaration.ref}`);
    }
    if (report.stability && parsedRef?.stability && report.stability !== parsedRef.stability) {
      reasons.push(`conformance.stability_mismatch:${declaration.ref}`);
    }
    reportRefs.push(clone(report.ref));
  }

  return Object.freeze({
    ok: reasons.length === 0,
    reasons: unique(reasons),
    reportRefs: Object.freeze(reportRefs)
  });
}

function publishedEvent(listing) {
  return {
    type: "listing.Published",
    contract: REGISTRY_PUBLISH_FLOW_CONTRACT,
    listingId: listing.listingId,
    name: listing.name,
    version: listing.version,
    kind: listing.kind,
    artifact: clone(listing.artifact),
    publisher: clone(listing.publisher),
    storageRef: clone(listing.storageRef),
    signature: clone(listing.signature),
    provenanceRef: clone(listing.provenanceRef),
    previousListingId: listing.previousListingId,
    occurredAt: listing.occurredAt
  };
}

function certifiedEvent(listing) {
  return {
    type: "listing.Certified",
    contract: REGISTRY_PUBLISH_FLOW_CONTRACT,
    listingId: listing.listingId,
    name: listing.name,
    version: listing.version,
    kind: listing.kind,
    artifact: clone(listing.artifact),
    descriptor: clone(listing.descriptor),
    publisher: clone(listing.publisher),
    storageRef: clone(listing.storageRef),
    certification: clone(listing.certification),
    occurredAt: listing.occurredAt
  };
}

function appendEvent(events, event) {
  events.push(Object.freeze({
    seq: events.length + 1,
    ...event
  }));
}

function createCatalog({ listingsById, certifiedByCoordinate }) {
  return Object.freeze({
    certified() {
      return [...certifiedByCoordinate.values()]
        .flatMap((ids) => ids.map((id) => listingsById.get(id)))
        .filter(Boolean)
        .map(clone);
    },

    publishedOnly() {
      const certifiedIds = new Set([...certifiedByCoordinate.values()].flat());
      return [...listingsById.values()]
        .filter((listing) => listing.status === "Published" && !certifiedIds.has(listing.listingId))
        .map(clone);
    },

    history(coordinate) {
      const key = coordinateKey(coordinate);
      return (certifiedByCoordinate.get(key) ?? [])
        .map((id) => listingsById.get(id))
        .filter(Boolean)
        .map(clone);
    },

    current(coordinate) {
      const ids = certifiedByCoordinate.get(coordinateKey(coordinate)) ?? [];
      const latest = listingsById.get(ids.at(-1));
      return latest ? clone(latest) : null;
    },

    get(listingId) {
      const listing = listingsById.get(listingId);
      return listing ? clone(listing) : null;
    }
  });
}

export function createInMemoryPublishArtifactStore({
  registry = DEFAULT_OCI_REGISTRY,
  namespace = DEFAULT_OCI_NAMESPACE
} = {}) {
  const entriesByDigest = new Map();
  const digestsByCoordinate = new Map();

  return Object.freeze({
    push({ descriptor, signedArtifact } = {}) {
      const coordinate = {
        name: descriptor.name,
        version: descriptor.version
      };
      const coordinateKeyValue = coordinateKey(coordinate);
      const descriptorDigest = `sha256:${createHash("sha256")
        .update(stableStringify(descriptor))
        .digest("hex")}`;
      const existing = entriesByDigest.get(descriptorDigest);
      if (existing) {
        return storePushResult(existing, { idempotent: true });
      }

      const priorDigests = digestsByCoordinate.get(coordinateKeyValue) ?? [];
      const descriptorRef = Object.freeze({
        mediaType: DESCRIPTOR_MEDIA_TYPE,
        uri: `oci://${safePath(registry)}/${safePath(namespace)}/descriptors/${safePath(`${descriptor.name}-${descriptor.version}`)}@${descriptorDigest}`,
        digest: descriptorDigest
      });
      const entry = Object.freeze({
        digest: descriptorDigest,
        coordinate: Object.freeze(coordinate),
        descriptorRef,
        artifactRef: clone(signedArtifact.artifact),
        signature: clone(signedArtifact.signature),
        previousDigest: priorDigests.at(-1) ?? null
      });

      entriesByDigest.set(descriptorDigest, entry);
      digestsByCoordinate.set(coordinateKeyValue, [...priorDigests, descriptorDigest]);

      return storePushResult(entry, { idempotent: false });
    },

    resolve(coordinate) {
      const ids = digestsByCoordinate.get(coordinateKey(coordinate)) ?? [];
      return ids.at(-1) ?? null;
    },

    entriesFor(coordinate) {
      return (digestsByCoordinate.get(coordinateKey(coordinate)) ?? [])
        .map((digest) => entriesByDigest.get(digest))
        .filter(Boolean)
        .map(storeEntrySnapshot);
    },

    get(digest) {
      const entry = entriesByDigest.get(digest);
      return entry ? storeEntrySnapshot(entry) : null;
    }
  });
}

function storePushResult(entry, { idempotent }) {
  return Object.freeze({
    digest: entry.digest,
    descriptorRef: clone(entry.descriptorRef),
    artifactRef: clone(entry.artifactRef),
    name: entry.coordinate.name,
    version: entry.coordinate.version,
    previousDigest: entry.previousDigest,
    idempotent
  });
}

function storeEntrySnapshot(entry) {
  return Object.freeze({
    digest: entry.digest,
    coordinate: clone(entry.coordinate),
    descriptorRef: clone(entry.descriptorRef),
    artifactRef: clone(entry.artifactRef),
    signature: clone(entry.signature),
    previousDigest: entry.previousDigest
  });
}

function coordinateKey(coordinate) {
  if (!isRecord(coordinate)) {
    throw new Error("catalog coordinate must be an object");
  }
  if (!isString(coordinate.name) || coordinate.name.length === 0) {
    throw new Error("catalog coordinate name must be a non-empty string");
  }
  if (!isString(coordinate.version) || coordinate.version.length === 0) {
    throw new Error("catalog coordinate version must be a non-empty string");
  }
  return `${coordinate.name}@${coordinate.version}`;
}

function listingIdFor({ descriptor, signedArtifact }) {
  return `listing-${createHash("sha256")
    .update(stableStringify({
      name: descriptor.name,
      version: descriptor.version,
      digest: descriptor.artifact.digest,
      signature: signedArtifact.signature.value
    }))
    .digest("hex")
    .slice(0, 24)}`;
}

function safePath(value) {
  return String(value)
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_.\-/]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-|-$/g, "") || "artifact";
}

function sameReportRef(left, right) {
  return Boolean(left?.digest && right?.digest && left.digest === right.digest);
}

function rejected({ status, reasons, listing = null }) {
  return Object.freeze({
    ok: false,
    contract: REGISTRY_PUBLISH_FLOW_CONTRACT,
    status,
    reasons: unique(reasons),
    listing: listing ? clone(listing) : null
  });
}

function unique(values) {
  return Object.freeze([...new Set(values)]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (!isRecord(value) && !Array.isArray(value)) {
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

function isRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
