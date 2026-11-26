import { type JsonValue, type JsonObject } from "./json.js";
export const AWS_PROVIDER_ID: "@hobo/provider-aws";
export const AWS_PROVIDER_VERSION: "hobo.provider-aws/v1";
export const AWS_PROVIDER_TARGET: "aws";
export const IAC_PULUMI_DRIVER: "@hobo/iac-pulumi";
export const AWS_FULL_CATALOG_PORTS: readonly string[];

export const awsFull: {
  with: Record<string, (options?: JsonObject) => JsonObject>;
};

export function createAwsFullCatalogProvider(options?: JsonObject): any;
export function createAwsFullCatalogShopPlan(options?: JsonObject): any;
export function mergeAwsFullResolvedOptions(provider: JsonValue, optionBlocks?: JsonValue[]): any;
export function evaluateAwsFullCatalogPlan(provider: JsonValue, plan: JsonValue): any;
export function realizeAwsFullCatalogPlan(provider: JsonValue, plan: JsonValue): any;
export function publishAwsManifestBundle(provider: JsonValue): any;
export function ingestAwsCapabilityManifest(registry: JsonValue, bundle: JsonValue): any;
export function simulateBrokeredKeylessApply(provider: JsonValue, plan: JsonValue, options?: JsonObject): any;
export function conformanceAdapter(provider: JsonValue): any;
export function runAwsFullCatalogConformance(provider: JsonValue, options?: JsonObject): any;
export function verifyAwsFullCatalog(provider: JsonValue, options?: JsonObject): any;
