import type {
  CapabilityManifest,
} from "../../provider-capability-manifest-contract/src/provider-capability-manifest.d.ts";
import { type JsonValue, type JsonObject } from "./json.js";


export const REGISTRY_INGEST_CONTRACT: "hobo.registry-capability-manifest-ingest/v1";
export const WELL_KNOWN_PREFIX: "/.well-known/capability-manifest/";
export const FIXTURE_SIGNATURE_ALG: "HOBO-FIXTURE-SHA256";

export interface FixtureSigningKey {
  keyId: string;
  issuer: string;
}

export interface RegistryIngestTrust {
  trustedIssuer?: string;
  now?: string;
}

export interface RegistryProviderRecord {
  providerId: string;
  manifest: CapabilityManifest;
  auth: CapabilityManifest["auth"];
  cost: CapabilityManifest["cost"];
  provenance: JsonObject;
  conformance: JsonObject | null;
  ingestedAt: string;
}

export interface RegistryEvent {
  type: "ProviderRegistered" | "CapabilityManifestUpdated";
  contract: typeof REGISTRY_INGEST_CONTRACT;
  seq: number;
  providerId: string;
  manifestSchema: string;
  provenance: JsonObject;
  conformanceReport: JsonObject | null;
  name?: string;
  version?: string;
  regions?: string[];
  capabilities?: string[];
  authMode?: string;
  costCurrency?: string;
  previousProviderId?: string | null;
}

export interface CapabilitySearchResult {
  rank: number;
  providerId: string;
  port: string;
  interface: string;
  version: string;
  stability: string;
  features: string[];
  regions: string[];
  authMode: string;
  costSkus: string[];
}

export interface CapabilityRegistry {
  ingestWellKnown(input: {
    documents: Record<string, string>;
    conformance?: JsonObject | null;
    servedRegions?: string[];
    provenance?: JsonObject | null;
    trust?: RegistryIngestTrust;
  }): {
    ok: boolean;
    providerId?: string;
    manifest?: CapabilityManifest;
    events: RegistryEvent[];
    errors: string[];
  };
  getProvider(providerId: string): RegistryProviderRecord | null;
  searchCapabilities(query?: JsonObject): {
    ok: boolean;
    contract?: typeof REGISTRY_INGEST_CONTRACT;
    query?: JsonObject;
    results: CapabilitySearchResult[];
    remediation?: JsonObject;
    reason?: string;
  };
  createPlannerCapabilitySource(): {
    contract: typeof REGISTRY_INGEST_CONTRACT;
    listCapabilities(port: string): CapabilitySearchResult[];
    search(query: JsonObject): ReturnType<CapabilityRegistry["searchCapabilities"]>;
    providers(): string[];
  };
  events(): RegistryEvent[];
  providers(): RegistryProviderRecord[];
}

export function createFixtureSigningKey(
  input?: Partial<FixtureSigningKey>,
): FixtureSigningKey;

export function signWellKnownBundle(
  documents: Record<string, string>,
  signingKey?: FixtureSigningKey,
): Record<string, string>;

export function createCapabilityRegistry(): CapabilityRegistry;

export function buildFixtureWellKnownBundle(
  provider?: ReturnType<typeof import("../../provider-capability-manifest-contract/src/provider-capability-manifest.js").createFixtureProvider>,
): Record<string, string>;

export function buildCloudflareWellKnownBundle(input?: {
  provider?: { capabilityManifest(): JsonValue; id?: string; conformanceReport?(): JsonValue };
  signingKey?: FixtureSigningKey;
}): {
  documents: Record<string, string>;
  conformance: JsonObject;
  servedRegions: string[];
  provenance: JsonObject;
};
