import { type JsonObject } from "./json.js";
export const MANIFEST_SCHEMA: "hobo.manifest/v1";
export const CONTRACT_VERSION: "hobo.provider-options/v1";

export type ResourceKind = "data" | "component";

export type ProviderOption<
  Provider extends string,
  Kinds extends ResourceKind,
  Payload extends JsonObject
> = {
  readonly __kind: "hobo.provider-option";
  readonly provider: Provider;
  readonly optionName: string;
  readonly annotationKey: `${Provider}.${string}`;
  readonly resourceKinds: readonly Kinds[];
  readonly value: Payload;
};

export type RequirementMode = "prefer" | "require";

export type ResourceRequirement = {
  readonly mode: RequirementMode;
  readonly capability: string;
};

export type ManifestResource = {
  readonly type: string;
  readonly port: string;
  readonly className: string;
  readonly requirement?: ResourceRequirement;
  readonly annotations?: {
    readonly with: Record<string, JsonObject>;
  };
  readonly portability?: {
    readonly lockInMarkers: readonly LockInMarker[];
  };
};

export type LockInMarker = {
  readonly source: ".with()";
  readonly annotation: string;
  readonly provider: string;
  readonly path: string;
  readonly reason: string;
};

export type Manifest = {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly contract: typeof CONTRACT_VERSION;
  readonly resources: Record<string, ManifestResource>;
};

export type DatabaseOptions = {
  readonly engine?: string;
  readonly prefer?: string;
  readonly require?: string;
};

export type ServiceOptions = {
  readonly workloadProfile?: string;
  readonly prefer?: string;
  readonly require?: string;
};

export type ResourceHandle<Kind extends ResourceKind> = {
  readonly id: string;
  readonly kind: Kind;
  with(...options: ProviderOption<string, Kind, JsonObject>[]): ResourceHandle<Kind>;
  toManifestResource(): ManifestResource;
};

export type AwsRdsOptions = {
  readonly multiAz?: boolean;
  readonly backupRetentionDays?: number;
  readonly storageGb?: number;
};

export type AwsFargateOptions = {
  readonly cpu: number;
  readonly memoryMb?: number;
};

export type AzureFlexibleServerOptions = {
  readonly haMode?: "disabled" | "sameZone" | "zoneRedundant";
  readonly sku?: string;
};

export type AzureContainerAppOptions = {
  readonly minReplicas?: number;
  readonly maxReplicas?: number;
};

export const aws: {
  rds(options: AwsRdsOptions): ProviderOption<"aws", "data", AwsRdsOptions>;
  fargate(options: AwsFargateOptions): ProviderOption<"aws", "component", AwsFargateOptions>;
};

export const azure: {
  flexibleServer(
    options: AzureFlexibleServerOptions
  ): ProviderOption<"azure", "data", AzureFlexibleServerOptions>;
  containerApp(
    options: AzureContainerAppOptions
  ): ProviderOption<"azure", "component", AzureContainerAppOptions>;
};

export function database(name: string, options?: DatabaseOptions): ResourceHandle<"data">;
export function service(name: string, options?: ServiceOptions): ResourceHandle<"component">;
export function createManifest(resources: readonly ResourceHandle<ResourceKind>[]): Manifest;
export function resolvedProviderOptions(
  resource: ManifestResource,
  providerKey: string
): Record<string, JsonObject>;
export function projectAgnosticResource(resource: ManifestResource): Omit<
  ManifestResource,
  "annotations" | "portability"
>;
