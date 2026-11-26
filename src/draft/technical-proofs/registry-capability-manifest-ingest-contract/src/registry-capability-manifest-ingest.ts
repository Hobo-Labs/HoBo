import { createHash } from "node:crypto";

import {
  CAPABILITY_MANIFEST_SCHEMA,
  canonicalJson,
  createFixtureProvider,
  serializeWellKnownManifest,
  stableDigest,
  validateCapabilityManifest,
} from "../../provider-capability-manifest-contract/src/provider-capability-manifest.js";
import { isJsonString, isJsonObject } from "./json.js";


export const REGISTRY_INGEST_CONTRACT = "hobo.registry-capability-manifest-ingest/v1";
export const WELL_KNOWN_PREFIX = "/.well-known/capability-manifest/";
export const FIXTURE_SIGNATURE_ALG = "HOBO-FIXTURE-SHA256";

export function createFixtureSigningKey({
  keyId = "registry-fixture-key",
  issuer = "https://identity.hobo.local",
} = {}) {
  return Object.freeze({ keyId, issuer });
}

export function signWellKnownBundle(documents, signingKey = createFixtureSigningKey()) {
  const indexPath = `${WELL_KNOWN_PREFIX}index.json`;
  const capabilitiesPath = `${WELL_KNOWN_PREFIX}capabilities.json`;
  const authPath = `${WELL_KNOWN_PREFIX}auth.json`;
  const costPath = `${WELL_KNOWN_PREFIX}cost.json`;

  const capabilitiesDoc = JSON.parse(documents[capabilitiesPath]);
  const authDoc = JSON.parse(documents[authPath]);
  const costDoc = JSON.parse(documents[costPath]);
  const existingIndex = JSON.parse(documents[indexPath]);

  const indexBody = {
    schema: existingIndex.schema ?? "hobo.capability-manifest-index/v1",
    providerId: existingIndex.providerId ?? capabilitiesDoc.providerId,
    manifestSchema: existingIndex.manifestSchema ?? CAPABILITY_MANIFEST_SCHEMA,
    documents: [
      {
        path: capabilitiesPath,
        schema: capabilitiesDoc.schema ?? "hobo.capabilities/v1",
        digest: stableDigest(capabilitiesDoc),
      },
      {
        path: authPath,
        schema: authDoc.schema ?? "hobo.provider-auth/v1",
        digest: stableDigest(authDoc),
      },
      {
        path: costPath,
        schema: costDoc.schema ?? "hobo.cost/v1",
        digest: stableDigest(costDoc),
      },
    ],
  };

  const signedIndex = {
    ...indexBody,
    signature: {
      alg: FIXTURE_SIGNATURE_ALG,
      issuer: signingKey.issuer,
      keyId: signingKey.keyId,
      digest: indexDigest(indexBody, signingKey),
    },
  };

  return {
    ...documents,
    [indexPath]: canonicalJson(signedIndex),
  };
}

export function createCapabilityRegistry() {
  const providers = new Map();
  const capabilityIndex = new Map();
  const registryEvents = [];

  const registry = {
    ingestWellKnown({
      documents,
      conformance = null,
      servedRegions = [],
      provenance = null,
      trust = {},
    } = {}) {
      const parsed = parseWellKnownDocuments(documents);
      verifySignedIndex(parsed.index, parsed.documentsByPath, trust);
      const manifest = reassembleManifest(parsed);
      const validation = validateCapabilityManifest(manifest, {
        conformance: conformance ?? provenance?.conformance,
        servedRegions: servedRegions.length > 0 ? servedRegions : manifest.regions,
      });
      if (!validation.ok) {
        return {
          ok: false,
          errors: validation.errors,
          events: [],
        };
      }

      const providerId = manifest.provider.id;
      const prior = providers.get(providerId);
      const record = Object.freeze({
        providerId,
        manifest: validation.manifest,
        auth: deepClone(manifest.auth),
        cost: deepClone(manifest.cost),
        provenance: provenance ?? {
          source: "well-known",
          basePath: WELL_KNOWN_PREFIX,
          indexDigest: stableDigest(parsed.index),
        },
        conformance: deepClone(conformance ?? provenance?.conformance ?? null),
        ingestedAt: trust.now ?? "2026-07-01T00:00:00.000Z",
      });

      providers.set(providerId, record);
      indexCapabilities(providerId, record.manifest, capabilityIndex);

      const events = projectRegistryEvents({
        record,
        prior,
        registryEvents,
      });

      return {
        ok: true,
        providerId,
        manifest: record.manifest,
        events: events.map(deepClone),
        errors: [],
      };
    },

    getProvider(providerId) {
      const record = providers.get(providerId);
      return record ? deepClone(record) : null;
    },

    searchCapabilities(query = {}) {
      const port = query.port ?? query.capability;
      if (!isNonEmptyString(port)) {
        return {
          ok: false,
          reason: "search requires port or capability",
          results: [],
        };
      }

      const regions = normalizeStringSet(query.regions ?? query.region);
      const features = normalizeStringSet(query.features ?? query.require?.features);
      const matches = (capabilityIndex.get(port) ?? [])
        .filter((entry) => regionMatches(entry, regions))
        .filter((entry) => featureMatches(entry, features))
        .sort(compareSearchResults)
        .map((entry, index) => ({
          rank: index + 1,
          providerId: entry.providerId,
          port: entry.port,
          interface: entry.interface,
          version: entry.version,
          stability: entry.stability,
          features: [...entry.features],
          regions: [...entry.regions],
          authMode: entry.authMode,
          costSkus: [...entry.costSkus],
        }));

      return {
        ok: true,
        contract: REGISTRY_INGEST_CONTRACT,
        query: {
          port,
          ...(regions.size > 0 ? { regions: [...regions] } : undefined),
          ...(features.size > 0 ? { features: [...features] } : undefined),
        },
        results: matches,
        remediation:
          matches.length === 0
            ? { action: "broaden-query", port, satisfies: [] }
            : undefined,
      };
    },

    createPlannerCapabilitySource() {
      return Object.freeze({
        contract: REGISTRY_INGEST_CONTRACT,
        listCapabilities(port) {
          return registry.searchCapabilities({ port }).results;
        },
        search(query) {
          return registry.searchCapabilities(query);
        },
        providers() {
          return [...providers.keys()];
        },
      });
    },

    events() {
      return registryEvents.map(deepClone);
    },

    providers() {
      return [...providers.values()].map(deepClone);
    },
  };

  return Object.freeze(registry);
}

export function buildFixtureWellKnownBundle(provider = createFixtureProvider()) {
  const manifest = provider.capabilityManifest();
  const documents = serializeWellKnownManifest(manifest);
  return signWellKnownBundle(documents);
}

export function buildCloudflareWellKnownBundle({
  provider,
  signingKey = createFixtureSigningKey({
    keyId: "cloudflare-provider-key",
    issuer: "https://providers.cloudflare.hobo.local",
  }),
} = {}) {
  if (!provider || !(provider.capabilityManifest instanceof Function)) {
    throw new Error("cloudflare well-known bundle requires a provider with capabilityManifest()");
  }

  const native = provider.capabilityManifest();
  const manifest = normalizeCloudflareManifest(native, provider);
  const documents = serializeWellKnownManifest(manifest);
  return {
    documents: signWellKnownBundle(documents, signingKey),
    conformance: provider.conformanceReport?.() ?? buildCloudflareConformance(native),
    servedRegions: collectRegions(native),
    provenance: {
      source: "well-known",
      provider: native.provider,
      publishedAt: "2026-07-01T00:00:00.000Z",
      conformance: buildCloudflareConformance(native),
    },
  };
}

function parseWellKnownDocuments(documents) {
  if (!documents || !isJsonObject(documents) || Array.isArray(documents)) {
    throw new Error("well-known documents must be an object");
  }

  const indexPath = `${WELL_KNOWN_PREFIX}index.json`;
  const capabilitiesPath = `${WELL_KNOWN_PREFIX}capabilities.json`;
  const authPath = `${WELL_KNOWN_PREFIX}auth.json`;
  const costPath = `${WELL_KNOWN_PREFIX}cost.json`;

  for (const path of [indexPath, capabilitiesPath, authPath, costPath]) {
    if (!(path in documents)) {
      throw new Error(`missing required well-known document ${path}`);
    }
  }

  const index = JSON.parse(documents[indexPath]);
  const capabilitiesDoc = JSON.parse(documents[capabilitiesPath]);
  const authDoc = JSON.parse(documents[authPath]);
  const costDoc = JSON.parse(documents[costPath]);

  return {
    index,
    capabilitiesDoc,
    authDoc,
    costDoc,
    documentsByPath: {
      [capabilitiesPath]: capabilitiesDoc,
      [authPath]: authDoc,
      [costPath]: costDoc,
    },
  };
}

function verifySignedIndex(index, documentsByPath, trust) {
  if (!index || !isJsonObject(index) || Array.isArray(index)) {
    throw new Error("index.json must be an object");
  }
  if (!index.signature) {
    throw new Error("unsigned capability manifest index is rejected");
  }

  const signature = index.signature;
  if (signature.alg !== FIXTURE_SIGNATURE_ALG) {
    throw new Error(`index.signature.alg must be ${FIXTURE_SIGNATURE_ALG}`);
  }
  if (trust.trustedIssuer) {
    if (signature.issuer !== trust.trustedIssuer) {
      throw new Error("index signature issuer does not match trusted issuer");
    }
  }

  const { signature: _ignored, ...indexBody } = index;
  const expectedDigest = indexDigest(indexBody, {
    keyId: signature.keyId,
    issuer: signature.issuer,
  });
  if (signature.digest !== expectedDigest) {
    throw new Error("capability manifest index signature digest mismatch");
  }

  for (const document of indexBody.documents ?? []) {
    const content = documentsByPath[document.path];
    if (!content) {
      throw new Error(`index references missing document ${document.path}`);
    }
    const actualDigest = stableDigest(content);
    if (document.digest !== actualDigest) {
      throw new Error(`document digest mismatch for ${document.path}`);
    }
  }
}

function reassembleManifest(parsed) {
  const providerId = parsed.index.providerId;
  return sortKeys({
    schema: parsed.index.manifestSchema ?? CAPABILITY_MANIFEST_SCHEMA,
    provider: {
      id: providerId,
      kind: "cloud-provider",
      package: `@hobo/${providerId.replace(/^@hobo\//, "")}`,
      version: "0.1.0",
    },
    publishedAt: "2026-07-01T00:00:00.000Z",
    regions: collectCapabilityRegions(parsed.capabilitiesDoc.capabilities),
    capabilities: parsed.capabilitiesDoc.capabilities,
    auth: {
      ...parsed.authDoc,
      schema: parsed.authDoc.schema,
    },
    cost: {
      ...parsed.costDoc,
      schema: parsed.costDoc.schema,
    },
  });
}

function projectRegistryEvents({ record, prior, registryEvents }) {
  const events = [];
  const base = {
    contract: REGISTRY_INGEST_CONTRACT,
    providerId: record.providerId,
    manifestSchema: record.manifest.schema,
    provenance: deepClone(record.provenance),
    conformanceReport: record.conformance ? deepClone(record.conformance) : null,
  };

  if (!prior) {
    events.push({
      type: "ProviderRegistered",
      seq: registryEvents.length + 1,
      ...base,
      name: record.manifest.provider.package,
      version: record.manifest.provider.version,
      regions: [...record.manifest.regions],
    });
  }

  events.push({
    type: "CapabilityManifestUpdated",
    seq: registryEvents.length + events.length + 1,
    ...base,
    capabilities: record.manifest.capabilities.map((capability) => capability.port),
    authMode: record.auth.mode,
    costCurrency: record.cost.currency,
    previousProviderId: prior?.providerId ?? null,
  });

  for (const event of events) {
    registryEvents.push(event);
  }

  return events;
}

function indexCapabilities(providerId, manifest, capabilityIndex) {
  const authMode = manifest.auth?.mode ?? "unknown";
  const costSkus = (manifest.cost?.facts ?? []).map((fact) => fact.sku);

  for (const capability of manifest.capabilities ?? []) {
    const port = capability.port;
    const entries = capabilityIndex.get(port) ?? [];
    const next = entries.filter((entry) => entry.providerId !== providerId);
    next.push({
      providerId,
      port,
      interface: capability.interface,
      version: capability.version,
      stability: capability.stability,
      features: [...(capability.features ?? [])],
      regions: [...(capability.regions ?? manifest.regions ?? [])],
      authMode,
      costSkus: [...costSkus],
    });
    capabilityIndex.set(port, next);
  }
}

function normalizeCloudflareManifest(native, provider) {
  const providerId = String(native.provider ?? provider.id ?? "cloudflare").replace(
    /^@hobo\//,
    "",
  );
  const regions = collectRegions(native);
  const capabilities = (native.capabilities ?? []).map((capability) => ({
    port: mapCloudflarePort(capability.port),
    interface: `hobo:${capability.port}/${capability.className ?? capability.port}`,
    version: "0.1.0",
    stability: "preview",
    features: [...(capability.features ?? [])],
    regions: [...(capability.regions ?? regions)],
  }));

  return sortKeys({
    schema: CAPABILITY_MANIFEST_SCHEMA,
    provider: {
      id: providerId,
      kind: "cloud-provider",
      package: provider.id ?? `@hobo/provider-${providerId}`,
      version: "0.1.0",
    },
    publishedAt: "2026-07-01T00:00:00.000Z",
    regions,
    capabilities,
    auth: {
      schema: "hobo.provider-auth/v1",
      mode: native.auth?.mode === "svid-federation" ? "svid-federation" : "brokered-oidc",
      tokenAudience: `spiffe://hobo/providers/${providerId}`,
      broker: {
        issuer: "https://identity.hobo.local",
        tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
      },
      requiredClaims: ["sub", "aud", "exp", "scope"],
    },
    cost: {
      schema: "hobo.cost/v1",
      currency: native.cost?.currency ?? "USD",
      facts: (native.cost?.facts ?? []).map((fact) => ({
        sku: fact.sku,
        unit: fact.unit,
        marginalPrice: "0.0001",
        freeTier: {
          unit: fact.unit,
          included: 1000,
          reset: "monthly",
        },
        source: {
          type: "declared-provider",
          documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
          signedAt: "2026-07-01T00:00:00.000Z",
        },
      })),
    },
  });
}

function buildCloudflareConformance(native) {
  return {
    schema: "hobo.conformance-summary/v1",
    providerId: String(native.provider ?? "cloudflare").replace(/^@hobo\//, ""),
    suite: "@hobo/conformance/provider-capability-manifest",
    suiteVersion: "0.1.0",
    capabilities: (native.capabilities ?? []).map((capability) => ({
      port: mapCloudflarePort(capability.port),
      features: [...(capability.features ?? [])],
      reportRef: digestRef(
        `conformance:cloudflare:${capability.port}:${(capability.features ?? []).join(",")}`,
      ),
    })),
  };
}

function mapCloudflarePort(port) {
  const mapping = {
    compute: "hobo:runner",
    objectStore: "hobo:artifact-repo",
    database: "hobo:database",
    kv: "hobo:kv",
    queue: "hobo:queue",
    dns: "hobo:dns",
  };
  return mapping[port] ?? `hobo:${port}`;
}

function collectRegions(native) {
  const regions = new Set(native.colos ?? []);
  for (const capability of native.capabilities ?? []) {
    for (const region of capability.regions ?? []) {
      regions.add(region);
    }
  }
  return regions.size > 0 ? [...regions] : ["global"];
}

function collectCapabilityRegions(capabilities) {
  const regions = new Set();
  for (const capability of capabilities ?? []) {
    for (const region of capability.regions ?? []) {
      regions.add(region);
    }
  }
  return regions.size > 0 ? [...regions] : ["global"];
}

function indexDigest(indexBody, signingKey) {
  return stableDigest({
    alg: FIXTURE_SIGNATURE_ALG,
    issuer: signingKey.issuer,
    keyId: signingKey.keyId,
    index: sortKeys(indexBody),
  });
}

function digestRef(seed) {
  const digest = `sha256:${createHash("sha256").update(seed).digest("hex")}`;
  return {
    mediaType: "application/vnd.hobo.evidence.v1+json",
    uri: `oci://registry.example/hobo/evidence@${digest}`,
    digest,
  };
}

function regionMatches(entry, regions) {
  if (regions.size === 0) return true;
  return entry.regions.some((region) => regions.has(region));
}

function featureMatches(entry, features) {
  if (features.size === 0) return true;
  const advertised = new Set(entry.features);
  return [...features].every((feature) => advertised.has(feature));
}

function compareSearchResults(left, right) {
  const stabilityDelta =
    stabilityRank(right.stability) - stabilityRank(left.stability);
  if (stabilityDelta !== 0) return stabilityDelta;
  return left.providerId.localeCompare(right.providerId);
}

function stabilityRank(stability) {
  return (
    {
      stable: 4,
      preview: 3,
      experimental: 2,
      deprecated: 1,
    }[stability] ?? 0
  );
}

function normalizeStringSet(value) {
  if (value === undefined || value === null) return new Set();
  const items = Array.isArray(value) ? value : [value];
  return new Set(items.filter(isNonEmptyString));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
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
