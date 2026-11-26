import { type JsonValue, type JsonObject } from "./json.js";
export declare const AZURE_PROVIDER_ID = "@hobo/provider-azure";
export declare const AZURE_PROVIDER_VERSION = "hobo.provider-azure/v1";
export declare const AZURE_PROVIDER_TARGET = "azure";
export declare const IAC_PULUMI_DRIVER = "@hobo/iac-pulumi";

export type AzureCapability = "database" | "objectStore" | "compute" | "queue" | "cache";

export interface AzureOptionBlock<TPort extends AzureCapability, TOptions extends object> {
  providerId: "azure";
  port: TPort;
  optionName: string;
  negotiation: "prefer" | "require";
  options: TOptions;
}

type NoRaw<T extends object> = T & { rawArmTemplate?: never; rawBicep?: never };

export interface AzureFlexiblePostgresOptions {
  engine?: "postgres";
  version?: "15" | "16";
  sku?: string;
  storageGb?: number;
  zoneRedundantHa?: boolean;
  backupRetentionDays?: number;
}

export interface AzureBlobOptions {
  redundancy?: "LRS" | "ZRS" | "GRS";
  accessTier?: "Hot" | "Cool";
  versioning?: boolean;
  immutableStorage?: boolean;
}

export interface AzureContainerAppOptions {
  cpu?: number;
  memoryGiB?: number;
  ingress?: "internal" | "external";
  daprEnabled?: boolean;
  providerManagedCertificate?: "app-service-managed";
}

export interface AzureServiceBusOptions {
  tier?: "Basic" | "Standard" | "Premium";
  sessions?: boolean;
  duplicateDetection?: boolean;
}

export interface AzureCacheForRedisOptions {
  sku?: "Basic" | "Standard" | "Premium";
  capacity?: number;
  tlsMinimumVersion?: "1.2";
}

export interface AzureWithBuilders {
  blob<T extends AzureBlobOptions = {}>(options?: NoRaw<T>): AzureOptionBlock<"objectStore", Required<Pick<AzureBlobOptions, "redundancy" | "accessTier" | "versioning">> & T>;
  cacheForRedis<T extends AzureCacheForRedisOptions = {}>(options?: NoRaw<T>): AzureOptionBlock<"cache", Required<Pick<AzureCacheForRedisOptions, "sku" | "capacity" | "tlsMinimumVersion">> & T>;
  containerApp<T extends AzureContainerAppOptions = {}>(options?: NoRaw<T>): AzureOptionBlock<"compute", Required<Pick<AzureContainerAppOptions, "cpu" | "memoryGiB" | "ingress">> & T>;
  flexiblePostgres<T extends AzureFlexiblePostgresOptions = {}>(options?: NoRaw<T>): AzureOptionBlock<"database", Required<Pick<AzureFlexiblePostgresOptions, "engine" | "version" | "sku">> & T>;
  serviceBus<T extends AzureServiceBusOptions = {}>(options?: NoRaw<T>): AzureOptionBlock<"queue", Required<Pick<AzureServiceBusOptions, "tier" | "sessions">> & T>;
}

export declare const azure: {
  with: AzureWithBuilders;
};

export interface AzureCapabilityManifestEntry {
  port: AzureCapability;
  service: string;
  resourceClass: string;
  resourceClasses: string[];
  resourceClassesByRegion: Record<string, string[]>;
  features: string[];
  regions: string[];
  conformance: { tags: ["local", "camp"] };
  driver: typeof IAC_PULUMI_DRIVER;
}

export interface AzureProvider {
  id: typeof AZURE_PROVIDER_ID;
  apiVersion: typeof AZURE_PROVIDER_VERSION;
  target: typeof AZURE_PROVIDER_TARGET;
  capabilities: readonly unknown[];
  manifest: { claimedCapabilities: AzureCapability[] };
  with: AzureWithBuilders;
  registerDefaultDefinitions<T extends unknown[]>(registry: T): T;
  realize(plan: JsonObject): JsonObject;
  capabilityManifest(): {
    provider: typeof AZURE_PROVIDER_ID;
    claimedCapabilities: AzureCapability[];
    auth: { mode: "svid-federation" };
    regions: string[];
    capabilities: AzureCapabilityManifestEntry[];
    cost: { facts: Array<{ sku: string }> };
  };
  client(port: "database", outputs: JsonObject): AzureDatabaseClient;
  client(port: "objectStore", outputs: JsonObject): AzureObjectStoreClient;
  client(port: "compute", outputs: JsonObject): AzureComputeClient;
  client(port: "queue", outputs: JsonObject): AzureQueueClient;
  client(port: "cache", outputs: JsonObject): AzureCacheClient;
}

export interface AzureDatabaseClient {
  port: "database";
  providerId: typeof AZURE_PROVIDER_ID;
  connectionString: string;
  ping(): "database:ok";
  describe(): JsonObject;
}

export interface AzureObjectStoreClient {
  port: "objectStore";
  providerId: typeof AZURE_PROVIDER_ID;
  containerName: JsonValue;
  ping(): "objectStore:ok";
  describe(): JsonObject;
}

export interface AzureComputeClient {
  port: "compute";
  providerId: typeof AZURE_PROVIDER_ID;
  url: JsonValue;
  ping(): "compute:ok";
  describe(): JsonObject;
}

export interface AzureQueueClient {
  port: "queue";
  providerId: typeof AZURE_PROVIDER_ID;
  queueName: JsonValue;
  ping(): "queue:ok";
  describe(): JsonObject;
}

export interface AzureCacheClient {
  port: "cache";
  providerId: typeof AZURE_PROVIDER_ID;
  endpoint: JsonValue;
  ping(): "cache:ok";
  describe(): JsonObject;
}

export declare function createAzureProvider(options?: {
  regions?: string[];
  serviceMatrix?: Record<string, string[]>;
  campEvidence?: "pass" | "fail" | Record<string, Partial<Record<"realProviderDrift" | "iam" | "mtls" | "quota", boolean>>>;
}): AzureProvider;

export interface AzureShopPlanInput {
  resourceOptions?: {
    readonly [resourceId: string]: readonly AzureOptionBlock<AzureCapability, object>[];
  };
}

export declare function createAzureMultiCloudShopPlan(options?: AzureShopPlanInput): JsonObject;
export declare function mergeAzureResolvedOptions(provider: AzureProvider, optionBlocks: readonly unknown[]): JsonObject;
export declare function evaluateAzurePlan(provider: AzureProvider, plan: JsonObject): JsonObject;
export declare function realizeAzurePlan(provider: AzureProvider, plan: JsonObject): JsonObject;
export declare function simulateAzureApply(provider: AzureProvider, plan: JsonObject, options?: JsonObject): JsonObject;
