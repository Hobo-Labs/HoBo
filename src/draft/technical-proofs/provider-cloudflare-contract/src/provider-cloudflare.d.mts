import { type JsonValue, type JsonObject } from "./json.js";
export declare const CLOUDFLARE_PROVIDER_ID = "@hobo/provider-cloudflare";
export declare const CLOUDFLARE_PROVIDER_VERSION = "hobo.provider-cloudflare/v1";
export declare const CLOUDFLARE_PROVIDER_TARGET = "cloudflare";
export declare const CLOUDFLARE_TERRAFORM_DRIVER = "terraform:cloudflare";
export declare const CLOUDFLARE_WRANGLER_DRIVER = "wrangler";

export type CloudflareCapability = "compute" | "objectStore" | "database" | "kv" | "queue" | "dns";

export interface CloudflareOptionBlock<TPort extends CloudflareCapability, TOptions extends object> {
  providerId: "cloudflare";
  port: TPort;
  optionName: string;
  negotiation: "prefer" | "require";
  options: TOptions;
}

export interface WorkerOptions {
  compatibilityDate?: string;
  cpuMs?: number;
  memoryMb?: number;
  scriptSizeMb?: number;
  smartPlacement?: boolean;
}

export interface R2Options {
  jurisdiction?: "auto" | "eu" | "fedramp";
  s3Compatibility?: "aws-sdk-v3-basic" | "strict-s3-rejected";
  publicAccess?: boolean;
}

export interface D1Options {
  migrationsTable?: string;
  readReplication?: boolean;
}

export interface HyperdrivePostgresOptions {
  backingProvider?: "neon";
  pooledConnections?: boolean;
}

export interface KvOptions {
  ttlSeconds?: number;
  eventualConsistency?: boolean;
}

export interface QueuesOptions {
  delivery?: "at-least-once";
  retentionDays?: number;
}

export interface DnsOptions {
  proxied?: boolean;
  ttl?: number;
}

export interface CloudflareWithBuilders {
  worker<T extends WorkerOptions = {}>(options?: T): CloudflareOptionBlock<"compute", Required<Pick<WorkerOptions, "compatibilityDate" | "cpuMs" | "memoryMb" | "scriptSizeMb">> & T>;
  r2<T extends R2Options = {}>(options?: T): CloudflareOptionBlock<"objectStore", Required<Pick<R2Options, "jurisdiction" | "s3Compatibility" | "publicAccess">> & T>;
  d1<T extends D1Options = {}>(options?: T): CloudflareOptionBlock<"database", Required<Pick<D1Options, "migrationsTable" | "readReplication">> & T>;
  hyperdrivePostgres<T extends HyperdrivePostgresOptions = {}>(options?: T): CloudflareOptionBlock<"database", Required<Pick<HyperdrivePostgresOptions, "backingProvider" | "pooledConnections">> & T>;
  kv<T extends KvOptions = {}>(options?: T): CloudflareOptionBlock<"kv", Required<Pick<KvOptions, "ttlSeconds" | "eventualConsistency">> & T>;
  queues<T extends QueuesOptions = {}>(options?: T): CloudflareOptionBlock<"queue", Required<Pick<QueuesOptions, "delivery" | "retentionDays">> & T>;
  dns<T extends DnsOptions = {}>(options?: T): CloudflareOptionBlock<"dns", Required<Pick<DnsOptions, "proxied" | "ttl">> & T>;
}

export declare const cloudflare: {
  with: CloudflareWithBuilders;
};

export interface CloudflareProvider {
  id: typeof CLOUDFLARE_PROVIDER_ID;
  apiVersion: typeof CLOUDFLARE_PROVIDER_VERSION;
  target: typeof CLOUDFLARE_PROVIDER_TARGET;
  capabilities: readonly JsonObject[];
  manifest: { claimedCapabilities: CloudflareCapability[] };
  with: CloudflareWithBuilders;
  registerDefaultDefinitions<T>(registry: T): T;
  realize(plan: JsonObject): JsonObject;
  capabilityManifest(): {
    provider: typeof CLOUDFLARE_PROVIDER_ID;
    claimedCapabilities: CloudflareCapability[];
    auth: { mode: "svid-federation" };
    hostRuntime: { providerNativeWasm: "opt-in" };
    colos: string[];
    capabilities: readonly JsonObject[];
    cost: { facts: Array<{ sku: string }> };
  };
  client(port: "compute", outputs: JsonObject): CloudflareComputeClient;
  client(port: "objectStore", outputs: JsonObject): CloudflareObjectStoreClient;
  client(port: "database", outputs: JsonObject): CloudflareDatabaseClient;
  client(port: "kv", outputs: JsonObject): CloudflareKvClient;
  client(port: "queue", outputs: JsonObject): CloudflareQueueClient;
  client(port: "dns", outputs: JsonObject): CloudflareDnsClient;
  verifyKvEvidence(options?: { tags?: Array<"local" | "camp"> }): JsonObject;
}

export interface CloudflareComputeClient {
  port: "compute";
  providerId: typeof CLOUDFLARE_PROVIDER_ID;
  url: JsonValue;
  ping(): "compute:ok";
  describe(): JsonObject;
}

export interface CloudflareObjectStoreClient {
  port: "objectStore";
  providerId: typeof CLOUDFLARE_PROVIDER_ID;
  bucketName: JsonValue;
  ping(): "objectStore:ok";
  describe(): JsonObject;
}

export interface CloudflareDatabaseClient {
  port: "database";
  providerId: typeof CLOUDFLARE_PROVIDER_ID;
  connectionString: JsonValue;
  ping(): "database:ok";
  describe(): JsonObject;
}

export interface CloudflareKvClient {
  port: "kv";
  providerId: typeof CLOUDFLARE_PROVIDER_ID;
  namespaceId: JsonValue;
  ping(): "kv:ok";
  describe(): JsonObject;
}

export interface CloudflareQueueClient {
  port: "queue";
  providerId: typeof CLOUDFLARE_PROVIDER_ID;
  queueName: JsonValue;
  ping(): "queue:ok";
  describe(): JsonObject;
}

export interface CloudflareDnsClient {
  port: "dns";
  providerId: typeof CLOUDFLARE_PROVIDER_ID;
  zoneId: JsonValue;
  ping(): "dns:ok";
  describe(): JsonObject;
}

export interface CloudflareServiceMatrix {
  readonly [colo: string]: readonly string[];
}

export interface CampEvidenceFlags {
  realProviderDrift?: boolean;
  iam?: boolean;
  mtls?: boolean;
  quota?: boolean;
}

export interface CampEvidenceByCapability {
  readonly [capability: string]: CampEvidenceFlags;
}

export declare function createCloudflareProvider(options?: {
  colos?: string[];
  serviceMatrix?: CloudflareServiceMatrix;
  campEvidence?: "pass" | "fail" | CampEvidenceByCapability;
}): CloudflareProvider;

export declare function createCloudflareEdgeShopPlan(options?: JsonObject): JsonObject;
export declare function mergeCloudflareResolvedOptions(provider: CloudflareProvider, optionBlocks: readonly JsonObject[]): JsonObject;
export declare function evaluateCloudflarePlan(provider: CloudflareProvider, plan: JsonObject): JsonObject;
export declare function realizeCloudflarePlan(provider: CloudflareProvider, plan: JsonObject): JsonObject;
export declare function simulateCloudflareApply(provider: CloudflareProvider, plan: JsonObject, options?: JsonObject): JsonObject;
