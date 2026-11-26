import { type JsonValue } from "./json.js";
export const CAPABILITY_MANIFEST_SCHEMA: "hobo.capability-manifest/v1";

export interface CapabilityManifest {
  schema: typeof CAPABILITY_MANIFEST_SCHEMA;
  provider: ProviderDescriptor;
  publishedAt: string;
  regions: string[];
  capabilities: ProviderCapability[];
  auth: ProviderAuthDescriptor;
  cost: ProviderCostDescriptor;
}

export interface ProviderDescriptor {
  id: string;
  kind: string;
  package: string;
  version: string;
}

export interface ProviderCapability {
  port: string;
  interface: string;
  version: string;
  stability: "stable" | "preview" | "experimental" | "deprecated";
  features: string[];
  regions: string[];
}

export interface ProviderAuthDescriptor {
  schema: "hobo.provider-auth/v1";
  mode: "brokered-oidc" | "svid-federation";
  tokenAudience: string;
  broker: {
    issuer: string;
    tokenExchange: string;
  };
  requiredClaims: string[];
}

export interface ProviderCostDescriptor {
  schema: "hobo.cost/v1";
  currency: string;
  facts: CostFact[];
}

export interface CostFact {
  sku: string;
  unit: string;
  marginalPrice: string;
  freeTier: {
    unit: string;
    included: number;
    reset: string;
  };
  source: {
    type: "declared-provider";
    documentRef: EvidenceRef;
    signedAt: string;
  };
}

export interface EvidenceRef {
  mediaType: string;
  uri: string;
  digest: string;
}

export interface ProviderWithManifest {
  id: string;
  servedRegions: string[];
  conformanceReport: JsonValue;
  capabilityManifest(): CapabilityManifest;
}

export function createFixtureProvider(options?: {
  id?: string;
  regions?: string[];
  capabilities?: ProviderCapability[];
}): ProviderWithManifest;

export function validateCapabilityManifest(
  manifest: CapabilityManifest,
  options?: { conformance?: JsonValue; servedRegions?: string[] }
): { ok: boolean; errors: string[]; manifest: CapabilityManifest | null };

export function serializeWellKnownManifest(manifest: CapabilityManifest): Record<string, string>;

export function negotiateCapability(options: {
  manifest: CapabilityManifest;
  request: { require: { port: string; features: string[] } };
  registry?: CapabilityManifest[];
}): JsonValue;

export function canonicalJson(value: JsonValue): string;
export function stableDigest(value: JsonValue): string;
