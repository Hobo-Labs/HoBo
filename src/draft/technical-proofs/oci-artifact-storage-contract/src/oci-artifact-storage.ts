import { createHash } from "node:crypto";

import {
  parseDescriptor,
  serializeDescriptor
} from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import { isJsonString, isJsonObject } from "./json.js";


export const OCI_ARTIFACT_STORAGE_CONTRACT = "hobo.oci-artifact-storage/v1";

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DESCRIPTOR_MEDIA_TYPE = "application/vnd.hobo.registry.descriptor.v1+json";
const DEFAULT_REGISTRY = "registry.example";
const DEFAULT_NAMESPACE = "hobo";

export function createArtifactBytesRef({
  name,
  mediaType = "application/octet-stream",
  bytes,
  registry = DEFAULT_REGISTRY,
  namespace = DEFAULT_NAMESPACE
} = {}) {
  if (!isNonEmptyString(name)) {
    throw new Error("artifact ref name must be a non-empty string");
  }
  if (!isNonEmptyString(mediaType)) {
    throw new Error("artifact ref mediaType must be a non-empty string");
  }

  const body = toBuffer(bytes, "artifact bytes");
  const digest = digestBytes(body);

  return {
    mediaType,
    uri: ociDigestUri({ registry, namespace, path: name, digest }),
    digest
  };
}

export function createOciArtifactStore({
  registry = DEFAULT_REGISTRY,
  namespace = DEFAULT_NAMESPACE
} = {}) {
  if (!isNonEmptyString(registry)) {
    throw new Error("registry must be a non-empty string");
  }
  if (!isNonEmptyString(namespace)) {
    throw new Error("namespace must be a non-empty string");
  }

  const blobs = new Map();
  const listingsByDigest = new Map();
  const digestsByCoordinate = new Map();
  const registryEvents = [];
  const catalogEntries = [];

  return {
    push({ descriptor, artifact } = {}) {
      const parsed = parseDescriptor(descriptor);
      if (!parsed.ok) {
        throw new Error(`descriptor invalid\n${parsed.errors.join("\n")}`);
      }

      const normalizedDescriptor = parsed.descriptor;
      const artifactBytes = toBuffer(artifact?.bytes, "artifact bytes");
      const artifactDigest = digestBytes(artifactBytes);
      if (normalizedDescriptor.artifact.digest !== artifactDigest) {
        throw new Error(
          `descriptor artifact digest ${normalizedDescriptor.artifact.digest} does not match supplied artifact digest ${artifactDigest}`
        );
      }
      if (artifact?.mediaType && artifact.mediaType !== normalizedDescriptor.artifact.mediaType) {
        throw new Error(
          `descriptor artifact mediaType ${normalizedDescriptor.artifact.mediaType} does not match supplied artifact mediaType ${artifact.mediaType}`
        );
      }

      const descriptorBytes = Buffer.from(serializeDescriptor(normalizedDescriptor));
      const listingDigest = digestBytes(descriptorBytes);
      const coordinate = coordinateOf(normalizedDescriptor);
      const existing = listingsByDigest.get(listingDigest);
      if (existing) {
        return pushResult(existing, { idempotent: true });
      }

      const descriptorRef = {
        mediaType: DESCRIPTOR_MEDIA_TYPE,
        uri: ociDigestUri({
          registry,
          namespace,
          path: `descriptors/${safePath(`${normalizedDescriptor.name}-${normalizedDescriptor.version}`)}`,
          digest: listingDigest
        }),
        digest: listingDigest
      };
      const artifactRef = normalizedDescriptor.artifact;
      const priorDigests = digestsByCoordinate.get(coordinate.key) ?? [];
      const listing = Object.freeze({
        digest: listingDigest,
        coordinate,
        descriptor: deepClone(normalizedDescriptor),
        descriptorBytes,
        descriptorRef,
        artifact: {
          ref: deepClone(artifactRef),
          bytes: Buffer.from(artifactBytes)
        },
        previousDigest: priorDigests.at(-1) ?? null
      });

      blobs.set(artifactDigest, {
        digest: artifactDigest,
        mediaType: artifactRef.mediaType,
        bytes: Buffer.from(artifactBytes),
        ref: deepClone(artifactRef),
        role: "artifact"
      });
      blobs.set(listingDigest, {
        digest: listingDigest,
        mediaType: DESCRIPTOR_MEDIA_TYPE,
        bytes: Buffer.from(descriptorBytes),
        ref: deepClone(descriptorRef),
        role: "descriptor"
      });
      listingsByDigest.set(listingDigest, listing);
      digestsByCoordinate.set(coordinate.key, [...priorDigests, listingDigest]);
      projectRegistryEvents({
        listing,
        registryEvents,
        catalogEntries
      });

      return pushResult(listing, { idempotent: false });
    },

    pull(refOrDigest) {
      const digest = digestFrom(refOrDigest, "pull digest");
      const listing = listingsByDigest.get(digest);
      if (!listing) {
        throw new Error(`artifact listing ${digest} not found`);
      }

      return pullResult(listing);
    },

    resolve(coordinate) {
      const normalized = normalizeCoordinate(coordinate);
      const digests = digestsByCoordinate.get(normalized.key);
      if (!digests || digests.length === 0) {
        throw new Error(`artifact listing ${normalized.name}@${normalized.version} not found`);
      }
      return digests.at(-1);
    },

    catalog() {
      return createCatalogReadModel(catalogEntries);
    },

    events() {
      return registryEvents.map(deepClone);
    },

    blobs() {
      return Array.from(blobs.values()).map((blob) => ({
        ...blob,
        ref: deepClone(blob.ref),
        bytes: Buffer.from(blob.bytes)
      }));
    }
  };
}

function projectRegistryEvents({ listing, registryEvents, catalogEntries }) {
  const providerEvent = {
    type: listing.descriptor.kind === "provider" ? "ProviderRegistered" : "RegistryListingPublished",
    contract: OCI_ARTIFACT_STORAGE_CONTRACT,
    seq: registryEvents.length + 1,
    name: listing.coordinate.name,
    version: listing.coordinate.version,
    kind: listing.descriptor.kind,
    digest: listing.digest,
    descriptorRef: deepClone(listing.descriptorRef),
    artifactRef: deepClone(listing.artifact.ref),
    previousDigest: listing.previousDigest
  };
  const capabilityEvent = {
    type: "CapabilityManifestUpdated",
    contract: OCI_ARTIFACT_STORAGE_CONTRACT,
    seq: registryEvents.length + 2,
    name: listing.coordinate.name,
    version: listing.coordinate.version,
    kind: listing.descriptor.kind,
    digest: listing.digest,
    exportedInterfaces: listing.descriptor.interfaces.exports.map((entry) => entry.ref),
    importedInterfaces: listing.descriptor.interfaces.imports.map((entry) => entry.ref)
  };

  registryEvents.push(providerEvent, capabilityEvent);
  catalogEntries.push(entryFromEvent(providerEvent));
}

function createCatalogReadModel(entries) {
  const projected = entries.map(deepClone);

  return Object.freeze({
    all() {
      return projected.map(deepClone);
    },
    entriesFor(coordinate) {
      const normalized = normalizeCoordinate(coordinate);
      return projected.filter((entry) => entry.coordinateKey === normalized.key).map(deepClone);
    },
    resolve(coordinate) {
      const matches = this.entriesFor(coordinate);
      if (matches.length === 0) {
        return null;
      }
      return matches.at(-1).digest;
    }
  });
}

function entryFromEvent(event) {
  return {
    coordinateKey: coordinateKey({ name: event.name, version: event.version }),
    name: event.name,
    version: event.version,
    kind: event.kind,
    digest: event.digest,
    descriptorRef: deepClone(event.descriptorRef),
    artifactRef: deepClone(event.artifactRef),
    previousDigest: event.previousDigest,
    eventSeq: event.seq
  };
}

function pushResult(listing, { idempotent }) {
  return {
    digest: listing.digest,
    descriptorRef: deepClone(listing.descriptorRef),
    artifactRef: deepClone(listing.artifact.ref),
    name: listing.coordinate.name,
    version: listing.coordinate.version,
    idempotent
  };
}

function pullResult(listing) {
  return {
    digest: listing.digest,
    descriptor: deepClone(listing.descriptor),
    descriptorRef: deepClone(listing.descriptorRef),
    descriptorBytes: Buffer.from(listing.descriptorBytes),
    artifact: {
      ref: deepClone(listing.artifact.ref),
      bytes: Buffer.from(listing.artifact.bytes)
    }
  };
}

function coordinateOf(descriptor) {
  return normalizeCoordinate({
    name: descriptor.name,
    version: descriptor.version
  });
}

function normalizeCoordinate(coordinate) {
  if (!coordinate || !isJsonObject(coordinate) || Array.isArray(coordinate)) {
    throw new Error("artifact listing coordinate must be an object");
  }
  if (!isNonEmptyString(coordinate.name)) {
    throw new Error("artifact listing coordinate name must be a non-empty string");
  }
  if (!isNonEmptyString(coordinate.version)) {
    throw new Error("artifact listing coordinate version must be a non-empty string");
  }

  const normalized = {
    name: coordinate.name,
    version: coordinate.version
  };

  return {
    ...normalized,
    key: coordinateKey(normalized)
  };
}

function coordinateKey({ name, version }) {
  return `${name}@${version}`;
}

function digestFrom(refOrDigest, path) {
  const digest = isJsonString(refOrDigest) ? refOrDigest : refOrDigest?.digest;
  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new Error(`${path} must be sha256:<64 hex chars>`);
  }
  return digest;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function ociDigestUri({ registry, namespace, path, digest }) {
  return `oci://${registry}/${safePath(namespace)}/${safePath(path)}@${digest}`;
}

function safePath(value) {
  return String(value)
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_.\-/]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-|-$/g, "") || "artifact";
}

function toBuffer(value, path) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (isJsonString(value)) {
    return Buffer.from(value);
  }
  throw new Error(`${path} must be bytes`);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
