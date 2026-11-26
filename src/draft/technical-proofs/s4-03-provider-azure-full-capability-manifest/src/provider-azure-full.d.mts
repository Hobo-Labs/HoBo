import { type JsonValue, type JsonObject } from "./json.js";
export declare const AZURE_PROVIDER_ID = "@hobo/provider-azure";
export declare const AZURE_PROVIDER_VERSION = "hobo.provider-azure/v1";
export declare const AZURE_PROVIDER_TARGET = "azure";
export declare const IAC_PULUMI_DRIVER = "@hobo/iac-pulumi";
export declare const FULL_CAPABILITY_PORTS: readonly ["web", "service", "kv", "bucket", "queue", "topic", "sql", "secret"];

export declare const azureFull: {
  with: {
    blob(options?: JsonObject): JsonValue;
    containerApp(options?: JsonObject): JsonValue;
    flexiblePostgres(options?: JsonObject): JsonValue;
    keyVault(options?: JsonObject): JsonValue;
    serviceBusQueue(options?: JsonObject): JsonValue;
    serviceBusTopic(options?: JsonObject): JsonValue;
    staticWebApp(options?: JsonObject): JsonValue;
    tableStorage(options?: JsonObject): JsonValue;
  };
};

export declare function createAzureFullProvider(options?: JsonObject): JsonObject;
export declare function createAzureFullMultiCloudShopPlan(options?: JsonObject): JsonObject;
export declare function mergeAzureFullResolvedOptions(provider: JsonObject, optionBlocks: readonly JsonObject[]): JsonObject;
export declare function evaluateAzureFullPlan(provider: JsonObject, plan: JsonObject): JsonObject;
export declare function realizeAzureFullPlan(provider: JsonObject, plan: JsonObject): JsonObject;
export declare function simulateAzureFullApply(provider: JsonObject, plan: JsonObject, options?: JsonObject): JsonObject;
export interface AzureServiceMatrix {
  readonly [region: string]: readonly string[];
}

export declare function createManifestBundle(regions: string[], serviceMatrix: AzureServiceMatrix): JsonObject;
export declare function ingestAzureCapabilityManifest(registry: Map<string, JsonValue>, bundle: JsonObject): JsonObject;
export declare function createConformanceAdapter(provider: JsonObject): JsonObject;
export declare function runExtendedPortConformance(provider: JsonObject, ports?: string[]): JsonObject;
