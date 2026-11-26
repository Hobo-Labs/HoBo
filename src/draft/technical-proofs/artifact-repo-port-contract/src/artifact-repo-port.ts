import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const OCI_DIGEST_URI_RE = /^oci:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/;
const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export const ARTIFACT_REPO_WIT_PACKAGE = "hobo:artifact-repo@0.1.0";
export const ADAPTER_KINDS = Object.freeze([
  "npm",
  "nuget",
  "pypi",
  "oci",
  "maven",
  "cargo",
  "rubygems"
]);

export function createDigestArtifactRef(seed, { mediaType = "application/vnd.hobo.artifact.v1+json" } = {}) {
  if (!isNonEmptyString(seed)) {
    throw new Error("artifact seed must be a non-empty string");
  }
  if (!isNonEmptyString(mediaType)) {
    throw new Error("artifact mediaType must be a non-empty string");
  }

  const digest = `sha256:${createHash("sha256").update(seed).digest("hex")}`;
  const safePath = seed.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || "artifact";

  return {
    mediaType,
    uri: `oci://registry.example/hobo/${safePath}@${digest}`,
    digest
  };
}

export function createArtifactRepoRegistry() {
  const adapters = new Map();

  return {
    registerAdapter(adapter) {
      validateAdapterContract(adapter);
      if (adapters.has(adapter.id)) {
        throw new Error(`adapter ${adapter.id} is already registered`);
      }
      adapters.set(adapter.id, adapter);
      return adapter;
    },
    getAdapter(id) {
      return adapters.get(id);
    },
    hasAdapter(adapter) {
      return adapters.get(adapter?.id) === adapter;
    },
    listAdapters() {
      return Array.from(adapters.values());
    }
  };
}

export function createInMemoryArtifactRepoAdapter({ id, kind, artifacts = {} }) {
  validateAdapterIdentity({ id, kind });
  const store = new Map(Object.entries(artifacts));
  const published = [];

  return {
    id,
    kind,
    published,
    async pull(coordinate) {
      const key = coordinateKey(coordinate);
      const artifact = store.get(key);
      if (!artifact) {
        throw new Error(`artifact ${key} not found`);
      }
      assertDigestPinnedArtifactRef(artifact, "pull result");
      return artifact;
    },
    async publish({ artifact, provenance } = {}) {
      assertDigestPinnedArtifactRef(artifact, "publish artifact");
      assertProvenanceRef(provenance, "publish provenance");
      const ref = createDigestArtifactRef(`${id}:${artifact.digest}:${provenance.digest}`, {
        mediaType: artifact.mediaType
      });
      published.push({ artifact, provenance, ref });
      return ref;
    }
  };
}

export function defineMirrorSet(registry, { name, adapters }) {
  if (!registry || !(registry.getAdapter instanceof Function) || !(registry.hasAdapter instanceof Function)) {
    throw new Error("registry must be created with createArtifactRepoRegistry()");
  }
  if (!isNonEmptyString(name)) {
    throw new Error("mirror set name must be a non-empty string");
  }
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error("mirror set must include at least one adapter");
  }

  const resolved = adapters.map((entry) => {
    if (isJsonString(entry)) {
      const adapter = registry.getAdapter(entry);
      if (!adapter) {
        throw new Error(`unregistered adapter ${entry}`);
      }
      return adapter;
    }

    validateAdapterContract(entry);
    if (!registry.hasAdapter(entry)) {
      throw new Error(`unregistered adapter ${entry.id}`);
    }
    return entry;
  });

  return Object.freeze({
    name,
    adapters: Object.freeze(resolved)
  });
}

export async function pullArtifact(mirrorSet, coordinate) {
  if (!mirrorSet || !Array.isArray(mirrorSet.adapters) || mirrorSet.adapters.length === 0) {
    throw new Error("mirror set must contain registered adapters");
  }

  const failures = [];
  for (const adapter of mirrorSet.adapters) {
    try {
      const result = await adapter.pull(coordinate);
      const artifact = result?.artifact ?? result;
      assertDigestPinnedArtifactRef(artifact, "pull result");
      return {
        adapterId: adapter.id,
        coordinate: normalizeCoordinate(coordinate),
        artifact,
        verification: {
          digestPinned: true
        }
      };
    } catch (error) {
      failures.push(`${adapter.id}: ${error.message}`);
    }
  }

  throw new Error(`no mirror could pull ${coordinateKey(coordinate)} as a digest-pinned artifact\n${failures.join("\n")}`);
}

export async function publishArtifact(adapter, { artifact, provenance } = {}) {
  validateAdapterContract(adapter);
  assertDigestPinnedArtifactRef(artifact, "publish artifact");
  assertProvenanceRef(provenance, "publish provenance");

  const result = await adapter.publish({ artifact, provenance });
  const ref = result?.artifact ?? result;
  assertDigestPinnedArtifactRef(ref, "publish result");
  return ref;
}

export async function runArtifactRepoConformance(adapter, { coordinate }) {
  const failures = [];

  try {
    await pullArtifact({ name: `${adapter.id}-conformance`, adapters: [adapter] }, coordinate);
  } catch (error) {
    failures.push(error.message);
  }

  try {
    await adapter.publish({ artifact: createDigestArtifactRef("conformance-missing-provenance") });
    failures.push("publish without provenance must fail");
  } catch {
    // Expected: an adapter must not accept a publish without provenance.
  }

  try {
    await publishArtifact(adapter, {
      artifact: createDigestArtifactRef("conformance-artifact"),
      provenance: createDigestArtifactRef("conformance-provenance", {
        mediaType: "application/vnd.in-toto+json"
      })
    });
  } catch (error) {
    failures.push(`publish with provenance failed: ${error.message}`);
  }

  return {
    adapterId: adapter.id,
    ok: failures.length === 0,
    failures
  };
}

function validateAdapterContract(adapter) {
  validateAdapterIdentity(adapter);
  if (!(adapter.pull instanceof Function)) {
    throw new Error(`adapter ${adapter.id} must implement pull()`);
  }
  if (!(adapter.publish instanceof Function)) {
    throw new Error(`adapter ${adapter.id} must implement publish()`);
  }
}

function validateAdapterIdentity(adapter) {
  if (!adapter || !isJsonObject(adapter) || Array.isArray(adapter)) {
    throw new Error("adapter must be an object");
  }
  if (!isNonEmptyString(adapter.id)) {
    throw new Error("adapter id must be a non-empty string");
  }
  if (!ADAPTER_KINDS.includes(adapter.kind)) {
    throw new Error(`adapter ${adapter.id} has unsupported kind ${String(adapter.kind)}`);
  }
}

function assertDigestPinnedArtifactRef(ref, path) {
  const errors = [];
  if (!ref || !isJsonObject(ref) || Array.isArray(ref)) {
    throw new Error(`${path} must be a digest-pinned artifact reference object`);
  }
  if (!isNonEmptyString(ref.mediaType)) {
    errors.push(`${path}.mediaType must be a non-empty string`);
  }
  if (!isNonEmptyString(ref.uri) || !OCI_DIGEST_URI_RE.test(ref.uri)) {
    errors.push(`${path}.uri must be an OCI digest reference`);
  }
  if (!isSha256Digest(ref.digest)) {
    errors.push(`${path}.digest must be sha256:<64 hex chars>`);
  }
  if ("tag" in ref) {
    errors.push(`${path}.tag is not allowed; artifact references must be digest-pinned`);
  }
  if (isSha256Digest(ref.digest) && isNonEmptyString(ref.uri) && OCI_DIGEST_URI_RE.test(ref.uri)) {
    const uriDigest = ref.uri.slice(ref.uri.lastIndexOf("@") + 1);
    if (uriDigest !== ref.digest) {
      errors.push(`${path}.uri digest must match ${path}.digest`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${path} must be a digest-pinned artifact reference\n${errors.join("\n")}`);
  }
}

function assertProvenanceRef(ref, path) {
  try {
    assertDigestPinnedArtifactRef(ref, path);
  } catch (error) {
    throw new Error(`${path} is required and must be digest-pinned provenance\n${error.message}`);
  }
}

function normalizeCoordinate(coordinate) {
  if (!coordinate || !isJsonObject(coordinate) || Array.isArray(coordinate)) {
    throw new Error("artifact coordinate must be an object");
  }
  const normalized = {
    ecosystem: coordinate.ecosystem,
    name: coordinate.name,
    version: coordinate.version
  };
  if (!ADAPTER_KINDS.includes(normalized.ecosystem)) {
    throw new Error(`unsupported artifact coordinate ecosystem ${String(normalized.ecosystem)}`);
  }
  if (!isNonEmptyString(normalized.name)) {
    throw new Error("artifact coordinate name must be a non-empty string");
  }
  if (!isNonEmptyString(normalized.version)) {
    throw new Error("artifact coordinate version must be a non-empty string");
  }
  return normalized;
}

function coordinateKey(coordinate) {
  const normalized = normalizeCoordinate(coordinate);
  return `${normalized.name}@${normalized.version}`;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isSha256Digest(value) {
  return isJsonString(value) && SHA256_DIGEST_RE.test(value);
}
