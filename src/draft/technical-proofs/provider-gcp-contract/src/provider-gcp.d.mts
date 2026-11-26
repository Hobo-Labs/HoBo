import { type JsonValue, type JsonObject } from "./json.js";
export declare const GCP_PROVIDER_ID = "@hobo/provider-gcp";
export declare const GCP_PROVIDER_VERSION = "hobo.provider-gcp/v1";
export declare const GCP_PROVIDER_TARGET = "gcp";
export declare const IAC_PULUMI_DRIVER = "@hobo/iac-pulumi";

export type GcpCapability = "database" | "objectStore" | "compute" | "queue" | "cache";

export interface GcpOptionBlock<TPort extends GcpCapability, TOptions extends object> {
  providerId: "gcp";
  port: TPort;
  optionName: string;
  negotiation: "prefer" | "require";
  options: TOptions;
}

export interface GcpCloudSqlOptions {
  databaseVersion?: "POSTGRES_15" | "POSTGRES_16";
  tier?: string;
  storageGb?: number;
  highAvailability?: boolean;
  deletionProtection?: boolean;
}

export interface GcpCloudRunOptions {
  cpu?: number;
  memoryMb?: number;
  minInstances?: number;
  maxInstances?: number;
  ingress?: "all" | "internal" | "internal-and-cloud-load-balancing";
  cpuAlwaysAllocated?: boolean;
  serviceAccountEmail?: string;
}

export interface GcpGcsOptions {
  location?: string;
  uniformBucketLevelAccess?: boolean;
  versioning?: boolean;
  lifecycleDays?: number;
}

export interface GcpPubSubOptions {
  ordering?: boolean;
  retentionDays?: number;
  deadLetterTopic?: string;
}

export interface GcpMemorystoreOptions {
  tier?: "BASIC" | "STANDARD_HA";
  memoryGb?: number;
  redisVersion?: string;
}

export interface GcpWithBuilders {
  cloudRun<T extends GcpCloudRunOptions = {}>(options?: T): GcpOptionBlock<"compute", Required<Pick<GcpCloudRunOptions, "cpu" | "memoryMb" | "ingress">> & T>;
  cloudSql<T extends GcpCloudSqlOptions = {}>(options?: T): GcpOptionBlock<"database", Required<Pick<GcpCloudSqlOptions, "databaseVersion" | "tier">> & T>;
  gcs<T extends GcpGcsOptions = {}>(options?: T): GcpOptionBlock<"objectStore", Required<Pick<GcpGcsOptions, "location" | "uniformBucketLevelAccess" | "versioning">> & T>;
  memorystore<T extends GcpMemorystoreOptions = {}>(options?: T): GcpOptionBlock<"cache", Required<Pick<GcpMemorystoreOptions, "tier" | "memoryGb">> & T>;
  pubSub<T extends GcpPubSubOptions = {}>(options?: T): GcpOptionBlock<"queue", Required<Pick<GcpPubSubOptions, "ordering" | "retentionDays">> & T>;
}

export declare const gcp: {
  with: GcpWithBuilders;
};

export interface GcpCapabilityManifestEntry {
  port: GcpCapability;
  service: string;
  resourceClass: string;
  resourceClasses: string[];
  resourceClassesByRegion: Record<string, string[]>;
  features: string[];
  regions: string[];
  conformance: { tags: ["local", "camp"] };
  driver: typeof IAC_PULUMI_DRIVER;
}

export interface GcpProvider {
  id: typeof GCP_PROVIDER_ID;
  apiVersion: typeof GCP_PROVIDER_VERSION;
  target: typeof GCP_PROVIDER_TARGET;
  capabilities: readonly unknown[];
  manifest: { claimedCapabilities: GcpCapability[] };
  with: GcpWithBuilders;
  registerDefaultDefinitions<T extends unknown[]>(registry: T): T;
  realize(plan: JsonObject): JsonObject;
  capabilityManifest(): {
    provider: typeof GCP_PROVIDER_ID;
    claimedCapabilities: GcpCapability[];
    auth: { mode: "svid-federation" };
    regions: string[];
    capabilities: GcpCapabilityManifestEntry[];
    cost: { facts: Array<{ sku: string }> };
  };
  client(port: "database", outputs: JsonObject): GcpDatabaseClient;
  client(port: "objectStore", outputs: JsonObject): GcpObjectStoreClient;
  client(port: "compute", outputs: JsonObject): GcpComputeClient;
  client(port: "queue", outputs: JsonObject): GcpQueueClient;
  client(port: "cache", outputs: JsonObject): GcpCacheClient;
}

export interface GcpDatabaseClient {
  port: "database";
  providerId: typeof GCP_PROVIDER_ID;
  connectionString: string;
  ping(): "database:ok";
  describe(): JsonObject;
}

export interface GcpObjectStoreClient {
  port: "objectStore";
  providerId: typeof GCP_PROVIDER_ID;
  bucketName: JsonValue;
  ping(): "objectStore:ok";
  describe(): JsonObject;
}

export interface GcpComputeClient {
  port: "compute";
  providerId: typeof GCP_PROVIDER_ID;
  url: JsonValue;
  ping(): "compute:ok";
  describe(): JsonObject;
}

export interface GcpQueueClient {
  port: "queue";
  providerId: typeof GCP_PROVIDER_ID;
  topicName: JsonValue;
  ping(): "queue:ok";
  describe(): JsonObject;
}

export interface GcpCacheClient {
  port: "cache";
  providerId: typeof GCP_PROVIDER_ID;
  endpoint: JsonValue;
  ping(): "cache:ok";
  describe(): JsonObject;
}

export declare function createGcpProvider(options?: {
  regions?: string[];
  serviceMatrix?: Record<string, string[]>;
  campEvidence?: "pass" | "fail" | Record<string, Partial<Record<"realProviderDrift" | "iam" | "mtls" | "quota", boolean>>>;
}): GcpProvider;

export declare function createGcpMultiCloudShopPlan(options?: JsonObject): JsonObject;
export declare function mergeGcpResolvedOptions(provider: GcpProvider, optionBlocks: readonly unknown[]): JsonObject;
export declare function evaluateGcpPlan(provider: GcpProvider, plan: JsonObject): JsonObject;
export declare function realizeGcpPlan(provider: GcpProvider, plan: JsonObject): JsonObject;
export declare function simulateGcpApply(provider: GcpProvider, plan: JsonObject, options?: JsonObject): JsonObject;
