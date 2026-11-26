import { type JsonValue, type JsonObject } from "./json.js";
export const MANIFEST_SCHEMA: "hobo.manifest/v1";
export const CURRENT_MANIFEST_SCHEMA: "hobo.manifest/v1.1";

export interface HoboManifestV1 {
  schema: "hobo.manifest/v1";
  componentHost: ComponentHostPin;
  resources: Record<string, ManifestResource>;
}

export interface HoboManifestV1_1 extends Omit<HoboManifestV1, "schema"> {
  schema: "hobo.manifest/v1.1";
  manifestVersion: {
    upcastedFrom?: string;
  };
}

export interface ComponentHostPin {
  kind: string;
  version: string;
}

export type ManifestResource =
  | DataResource
  | ComponentResource
  | WebsiteResource;

export interface DataResource extends BaseResource {
  type: "data.v1";
  port: string;
  paradigm?: string;
  allow?: string[];
  connectionString?: string;
}

export interface ComponentResource extends BaseResource {
  type: "component.v1";
  image?: string;
  runtime?: "wasm" | "container";
  exports?: string[];
  links?: ManifestLink[];
  endpoints?: Record<string, ManifestEndpoint>;
  env?: Record<string, string>;
  annotations?: JsonObject;
}

export interface WebsiteResource extends BaseResource {
  type: "website.v1";
  bind?: string[];
}

export interface BaseResource {
  type: string;
  port?: string;
}

export interface ManifestLink {
  import: string;
  to: string;
}

export interface ManifestEndpoint {
  scheme: string;
  targetPort: number;
  external?: boolean;
}

export interface ManifestValidationResult {
  valid: true;
  schema: "hobo.manifest/v1" | "hobo.manifest/v1.1";
  aspireEnv: Record<string, string[]>;
  hash: string;
}

export interface ManifestReference {
  resourceId: string;
  output: string;
}

export interface ResourceOutputPlaceholder {
  type: string;
  className: string;
  resourceId: string;
  output: string;
}

export interface ContextPlaceholder {
  contextPath: string;
}

export class ManifestValidationError extends Error {
  path: string;
}

export class ManifestUpcastError extends Error {
  path: string;
}

export interface ManifestUpcaster {
  from: string;
  to: string;
  upcast(manifest: JsonObject): JsonObject | {
    manifest: JsonObject;
    losses?: ManifestUpcastLoss[];
  };
}

export interface ManifestUpcastLoss {
  path: string;
  reason: string;
}

export interface UpcastManifestOptions {
  targetSchema?: string;
  schemaOrder?: string[];
  upcasters?: ManifestUpcaster[];
}

export interface ManifestUpcastResult {
  manifest: HoboManifestV1 | HoboManifestV1_1 | JsonObject;
  hash: string;
  fromSchema: string;
  toSchema: string;
  appliedUpcasters: string[];
  losses: ManifestUpcastLoss[];
}

export function validateManifest(input: JsonValue): ManifestValidationResult;
export function upcastManifest(
  input: JsonValue,
  options?: UpcastManifestOptions,
): ManifestUpcastResult;
export function parseManifestReference(value: string): ManifestReference;
export function parseOutputPlaceholder(
  value: string,
): ResourceOutputPlaceholder | ContextPlaceholder;
export function canonicalManifestHash(manifest: JsonValue): string;
