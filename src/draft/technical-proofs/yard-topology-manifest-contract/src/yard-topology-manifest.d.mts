import type { ConnectivityTierValue } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.d.mts";
import { type JsonValue } from "./json.js";


export declare const YARD_MANIFEST_SCHEMA_VERSION: "hobo.yard-manifest/v1";

export interface YardManifest {
  schemaVersion: typeof YARD_MANIFEST_SCHEMA_VERSION;
  yard: YardRef;
  providerZones: ProviderZone[];
  exposedEndpoints: ExposedEndpoint[];
  crossYardLinks: CrossYardLink[];
  topologyOverrides: TopologyOverride[];
  contentHash: string;
}

export interface YardRef {
  id: string;
  provider: string;
  regions: string[];
  junctionId?: string;
}

export interface ProviderZone {
  id: string;
  domain: string;
  regions: string[];
}

export interface ExposedEndpoint {
  logicalName: string;
  resourceId: string;
  campId: string;
  provider: string;
  region: string;
  dnsName: string;
  residencyTag: string;
}

export interface CrossYardLink {
  id: string;
  bindleId: string;
  source: CrossYardLinkEndpoint;
  target: CrossYardLinkEndpoint;
  requiredTier: ConnectivityTierValue;
  dnsRules: DnsRule[];
}

export interface CrossYardLinkEndpoint {
  yardId: string;
  resourceId: string;
  endpoint: string;
  residencyTag: string;
}

export interface DnsRule {
  recordName: string;
  type: "A" | "AAAA" | "CNAME";
  targets: string[];
}

export type TopologyOverride = DnsRecordOverride | ConnectivityTierOverride;

export interface DnsRecordOverride extends DnsRule {
  id: string;
  kind: "dns-record";
  reason: string;
}

export interface ConnectivityTierOverride {
  id: string;
  kind: "connectivity-tier";
  linkId: string;
  requiredTier: ConnectivityTierValue;
  reason: string;
}

export interface DeclaredYardTopology {
  yard: YardRef;
  providerZones?: ProviderZone[];
  exposedEndpoints?: ExposedEndpoint[];
  crossYardLinks?: CrossYardLink[];
  topologyOverrides?: TopologyOverride[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export declare function projectYardManifest(topology: DeclaredYardTopology): YardManifest;
export declare function validateYardManifest(manifest: YardManifest | JsonValue): ValidationResult;
