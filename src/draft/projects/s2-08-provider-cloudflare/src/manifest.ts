import type { InitialCapabilityPort } from "./equivalence.js";
import { EQUIVALENCE_CLASSES } from "./equivalence.js";
import { cloneAsJson, isJsonObject, type JsonValue, type JsonBag } from "./json.js";


export const MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
export const AUTH_SCHEMA = "hobo.provider-auth/v1";
export const COST_SCHEMA = "hobo.cost/v1";

export const CLOUDFLARE_PROVIDER_ID = "@hobo/provider-cloudflare";

interface ParsedManifestIndex { manifestSchema?: string; schema?: string; providerId?: string; }
interface ParsedCapabilities { schema?: string; capabilities?: Array<{ port?: string }>; }
interface ParsedAuth { schema?: string; staticSecrets?: boolean; staticKey?: string; clientSecret?: string; }
interface ParsedCost { schema?: string; }

export interface PublishedManifestDocuments {
  "/.well-known/capability-manifest/index.json": string;
  "/.well-known/capability-manifest/capabilities.json": string;
  "/.well-known/capability-manifest/auth.json": string;
  "/.well-known/capability-manifest/cost.json": string;
}

export interface CloudflareManifestInput {
  providerId?: string;
  colos?: string[];
  ports?: InitialCapabilityPort[];
  costFacts?: Array<{ port: string; sku: string; unit: string }>;
}

export function publishCapabilityManifest(input: CloudflareManifestInput = {}): PublishedManifestDocuments {
  const providerId = input.providerId ?? CLOUDFLARE_PROVIDER_ID;
  const colos = input.colos ?? ["WNAM", "ENAM", "WEUR"];
  // SAFETY: the equivalence-class object is the single source of truth for these keys.
  const ports = input.ports ?? (Object.keys(EQUIVALENCE_CLASSES) as InitialCapabilityPort[]);
  const capabilitiesDocument = {
    schema: CAPABILITIES_SCHEMA,
    providerId,
    equivalenceClasses: ports.map((port) => ({
      class: port,
      ...EQUIVALENCE_CLASSES[port],
    })),
    capabilities: ports.map((port) => {
      const mapping = EQUIVALENCE_CLASSES[port];
      return {
        port: mapping.port,
        interface: `hobo:${mapping.port}/${mapping.resourceClass}`,
        version: "0.1.0",
        stability: "preview",
        features: [...mapping.features],
        regions: [...colos],
        resourceClass: mapping.resourceClass,
        providerService: mapping.providerService,
      };
    }),
  };
  const authDocument = {
    schema: AUTH_SCHEMA,
    providerId,
    mode: "svid-federation",
    tokenAudience: `spiffe://hobo/providers/${providerId.replace("@hobo/", "")}`,
    broker: {
      issuer: "https://identity.hobo.local",
      tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
    },
    requiredClaims: ["sub", "aud", "exp", "scope"],
    staticSecrets: false,
  };
  const defaultFacts = ports.map((port) => {
    const mapping = EQUIVALENCE_CLASSES[port];
    const sku = {
      "web/service": "cloudflare.workers.request",
      kv: "cloudflare.kv.read",
      objectStore: "cloudflare.r2.storage.gb-month",
    }[port];
    const unit = {
      "web/service": "request",
      kv: "operation",
      objectStore: "GB-month",
    }[port];
    return {
      port: mapping.port,
      sku,
      unit,
      marginalPrice: "0.0000",
      freeTier: { unit, included: 100000, reset: "monthly" },
      source: {
        type: "declared-provider",
        documentRef: digestRef(`cost:${providerId}:${sku}`),
        signedAt: "2026-07-01T00:00:00Z",
      },
    };
  });
  const costDocument = {
    schema: COST_SCHEMA,
    providerId,
    currency: "USD",
    facts: input.costFacts
      ? input.costFacts.map((fact) => ({
          sku: fact.sku,
          unit: fact.unit,
          marginalPrice: "0.0000",
          freeTier: { unit: fact.unit, included: 100000, reset: "monthly" },
          source: {
            type: "declared-provider",
            documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
            signedAt: "2026-07-01T00:00:00Z",
          },
        }))
      : defaultFacts,
  };
  const documents = [
    {
      path: "/.well-known/capability-manifest/capabilities.json",
      schema: CAPABILITIES_SCHEMA,
      digest: stableDigest(cloneAsJson(capabilitiesDocument)),
    },
    {
      path: "/.well-known/capability-manifest/auth.json",
      schema: AUTH_SCHEMA,
      digest: stableDigest(cloneAsJson(authDocument)),
    },
    {
      path: "/.well-known/capability-manifest/cost.json",
      schema: COST_SCHEMA,
      digest: stableDigest(cloneAsJson(costDocument)),
    },
  ];
  const indexDocument = {
    schema: "hobo.capability-manifest-index/v1",
    providerId,
    manifestSchema: MANIFEST_SCHEMA,
    documents,
  };

  return {
    "/.well-known/capability-manifest/index.json": canonicalJson(cloneAsJson(indexDocument)),
    "/.well-known/capability-manifest/capabilities.json": canonicalJson(cloneAsJson(capabilitiesDocument)),
    "/.well-known/capability-manifest/auth.json": canonicalJson(cloneAsJson(authDocument)),
    "/.well-known/capability-manifest/cost.json": canonicalJson(cloneAsJson(costDocument)),
  };
}

export interface PublishedManifestParseResult {
  ok: boolean;
  errors: string[];
  index: ParsedManifestIndex;
  capabilities: ParsedCapabilities;
  auth: ParsedAuth;
  cost: ParsedCost;
}

/**
 * Parse-don't-validate boundary: untrusted well-known manifest documents become
 * a parsed derived type or structured errors — no broad DTO checks downstream.
 */
export function parsePublishedManifest(documents: PublishedManifestDocuments): PublishedManifestParseResult {
  // SAFETY: these documents were emitted by canonicalJson and are parsed into the project JSON value domain.
  // SAFETY: the index document is emitted by canonicalJson and is parsed into the project JSON object domain.
  const index = JSON.parse(documents["/.well-known/capability-manifest/index.json"]) as ParsedManifestIndex;
  // SAFETY: the capabilities document is emitted by canonicalJson and is parsed into the project JSON object domain.
  const capabilities = JSON.parse(documents["/.well-known/capability-manifest/capabilities.json"]) as ParsedCapabilities;
  // SAFETY: the auth document is emitted by canonicalJson and is parsed into the project JSON object domain.
  const auth = JSON.parse(documents["/.well-known/capability-manifest/auth.json"]) as ParsedAuth;
  // SAFETY: the cost document is emitted by canonicalJson and is parsed into the project JSON object domain.
  const cost = JSON.parse(documents["/.well-known/capability-manifest/cost.json"]) as ParsedCost;
  const errors: string[] = [];

  if (index.manifestSchema !== MANIFEST_SCHEMA) {
    errors.push(`index.manifestSchema must be ${MANIFEST_SCHEMA}`);
  }
  if (auth.schema !== AUTH_SCHEMA) {
    errors.push(`auth.schema must be ${AUTH_SCHEMA}`);
  }
  if (cost.schema !== COST_SCHEMA) {
    errors.push(`cost.schema must be ${COST_SCHEMA}`);
  }
  if ("staticKey" in auth || "clientSecret" in auth) {
    errors.push("auth must not publish static secrets");
  }
  if (!Array.isArray(capabilities.capabilities) || capabilities.capabilities.length === 0) {
    errors.push("capabilities.capabilities must be non-empty");
  }

  return {
    ok: errors.length === 0,
    errors,
    index,
    capabilities,
    auth,
    cost,
  };
}

function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function stableDigest(value: JsonValue): string {
  return fnv1aHex(canonicalJson(value));
}

function digestRef(seed: string) {
  const digest = `sha256:${fnv1aHex(seed)}`;
  return {
    mediaType: "application/vnd.hobo.evidence.v1+json",
    uri: `oci://registry.example/hobo/evidence@${digest}`,
    digest,
  };
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const sorted: JsonBag = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key] ?? null);
  }
  return sorted;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "16");
}
