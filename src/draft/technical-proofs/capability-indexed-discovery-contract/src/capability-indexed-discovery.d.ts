import { type JsonValue } from "./json.js";
export type StabilityTier = "stable" | "preview" | "experimental" | "deprecated";

export interface CapabilityDeclaration {
  interface: string;
  semver: string;
  stability: StabilityTier;
  conformanceSuiteVersion?: string;
}

export interface DiscoveryCriteria {
  region?: string;
  classification?: string;
  kind?: string;
}

export interface CapabilityDiscoveryQuery {
  port: string;
  criteria?: DiscoveryCriteria;
}

export interface CapabilityDiscoveryResult {
  rank: number;
  listingId: string;
  kind: string;
  name: string;
  version: string;
  digest: `sha256:${string}`;
  providerId: string;
  providerName: string;
  providerVersion: string;
  capability: CapabilityDeclaration;
  matching: {
    regions: string[];
    classifications: string[];
  };
  certifiedAt: string | null;
}

export interface IndexedCapabilityListing {
  listingId: string;
  kind: string;
  name: string;
  version: string;
  digest: `sha256:${string}`;
  providerId: string;
  providerName: string;
  providerVersion: string;
  capabilities: CapabilityDeclaration[];
  matching: {
    regions: string[];
    classifications: string[];
  };
  certifiedAt: string | null;
}

export interface CapabilityDiscoveryResponse {
  ok: true;
  contract: typeof CAPABILITY_DISCOVERY_CONTRACT;
  query: {
    port: string;
    criteria: DiscoveryCriteria;
  };
  results: CapabilityDiscoveryResult[];
  remediation?: string;
}

export interface CertifiedListingDescriptor {
  schema: typeof CAPABILITY_DISCOVERY_CONTRACT;
  listingId: string;
  kind: string;
  name: string;
  version: string;
  artifact: {
    mediaType: string;
    uri: `oci://${string}@${string}`;
    digest: `sha256:${string}`;
  };
  provider: {
    id: string;
    name: string;
    version: string;
  };
  capabilitySpec: JsonValue;
  matching: {
    regions: string[];
    classifications: string[];
  };
}

export interface ListingCertifiedEvent {
  type: "listing.Certified";
  listingId: string;
  descriptor: CertifiedListingDescriptor;
  certification: {
    status: "passed" | "failed";
    reportRef?: string;
  };
  occurredAt?: string;
}

export interface ListingYankedEvent {
  type: "listing.Yanked";
  listingId: string;
  reason?: string;
  occurredAt?: string;
}

export interface CapabilityDiscoveryIndex {
  apply(event: ListingCertifiedEvent | ListingYankedEvent | { type: string; [key: string]: JsonValue }): {
    applied: boolean;
    listingId?: string;
    reason?: string;
  };
  find(query: CapabilityDiscoveryQuery): CapabilityDiscoveryResponse;
  entries(): IndexedCapabilityListing[];
}

export interface DiscoveryMcpTool {
  name: typeof DISCOVERY_MCP_TOOL_NAME;
  invoke(input: CapabilityDiscoveryQuery): Promise<CapabilityDiscoveryResponse>;
}

export const CAPABILITY_DISCOVERY_CONTRACT: "hobo.capability-discovery/v1";
export const DISCOVERY_MCP_TOOL_NAME: "hobo_find_capability_listings";

export function createCapabilityDiscoveryIndex(): CapabilityDiscoveryIndex;
export function createDiscoveryMcpTool(index: CapabilityDiscoveryIndex): DiscoveryMcpTool;
export function createFixtureCertifiedListing(input?: {
  listingId?: string;
  kind?: string;
  name?: string;
  version?: string;
  providerId?: string;
  providerName?: string;
  providerVersion?: string;
  interfaces?: Array<{
    interface: string;
    semver: string;
    stability: StabilityTier;
    suite?: string;
    suiteVersion?: string;
  }>;
  matching?: {
    regions?: string[];
    classifications?: string[];
  };
}): CertifiedListingDescriptor;
