import { type JsonValue, type JsonObject } from "./json.js";
export const MANIFEST_SCHEMA: "hobo.manifest/v1";
export const PARADIGM_PACKAGE_KIND: "hobo.paradigm-package";

export type DataAllowVerb = "read" | "write" | "query" | "admin";
export type ParadigmPackageName = "@hobo/sql" | "@hobo/document" | "@hobo/vector" | "@hobo/graph";
export type Paradigm = "relational" | "document" | "vector" | "graph";
export type EquivalenceClass = "managed-postgres" | "managed-document" | "search-extension";

export type ProviderOption<
  Provider extends string,
  Kinds extends "data",
  Payload extends JsonObject,
> = {
  readonly __kind: "hobo.provider-option";
  readonly provider: Provider;
  readonly optionName: string;
  readonly annotationKey: `${Provider}.${string}`;
  readonly resourceKinds: readonly Kinds[];
  readonly value: Payload;
};

export interface ParadigmPackageFeature {
  readonly name: string;
  readonly crossParadigmEquivalent?: boolean;
}

export type ImportedParadigmPackageInput =
  | {
      readonly packageName: "@hobo/sql";
      readonly paradigm: "relational";
      readonly equivalenceClass: "managed-postgres";
      readonly port: "hobo:data";
      readonly extensionPort?: undefined;
      readonly features?: readonly ParadigmPackageFeature[];
    }
  | {
      readonly packageName: "@hobo/document";
      readonly paradigm: "document";
      readonly equivalenceClass: "managed-document";
      readonly port: "hobo:data";
      readonly extensionPort?: undefined;
      readonly features?: readonly ParadigmPackageFeature[];
    }
  | {
      readonly packageName: "@hobo/vector";
      readonly paradigm: "vector";
      readonly equivalenceClass: "search-extension";
      readonly port: "hobo:data";
      readonly extensionPort: "hobo:search";
      readonly features?: readonly ParadigmPackageFeature[];
    }
  | {
      readonly packageName: "@hobo/graph";
      readonly paradigm: "graph";
      readonly equivalenceClass: "search-extension";
      readonly port: "hobo:data";
      readonly extensionPort: "hobo:search";
      readonly features?: readonly ParadigmPackageFeature[];
    };

export interface ImportedParadigmPackage {
  readonly kind: typeof PARADIGM_PACKAGE_KIND;
  readonly packageName: ParadigmPackageName;
  readonly paradigm: Paradigm;
  readonly equivalenceClass: EquivalenceClass;
  readonly port: "hobo:data";
  readonly extensionPort?: "hobo:search";
  readonly features: readonly Required<ParadigmPackageFeature>[];
}

export interface DataHandle {
  readonly kind: "data";
  readonly name: string;
  readonly port: "hobo:data";
  readonly stableId: string;
  use(packageDescriptor: ImportedParadigmPackage): this;
  with(...options: readonly ProviderOption<string, "data", JsonObject>[]): this;
  resourceDefinition(reference: string): this;
  raw(dialect: string, operation: JsonValue): LoweringDescriptor;
  allow(...verbs: readonly DataAllowVerb[]): this;
  read(...args: readonly unknown[]): LoweringDescriptor;
  write(...args: readonly unknown[]): LoweringDescriptor;
  query(...args: readonly unknown[]): LoweringDescriptor;
  admin(...args: readonly unknown[]): LoweringDescriptor;
  toManifestResource(): DataManifestResource;
}

export interface LoweringDescriptor {
  readonly lowersTo: "hobo:sdk";
  readonly kind: "data";
  readonly name: string;
  readonly handleStableId: string;
  readonly portRef: readonly ["hobo:data"];
  readonly extensionPortRef: readonly "hobo:search"[];
  readonly verb: DataAllowVerb;
  readonly args: readonly unknown[];
  readonly raw?: {
    readonly dialect: string;
    readonly operation: JsonValue;
    readonly mode: "read-only";
  };
}

export interface DataManifestResource {
  readonly type: "data.v1";
  readonly port: "hobo:data";
  readonly kind: "data";
  readonly allow: readonly DataAllowVerb[];
  readonly usage: {
    readonly inferred: readonly DataAllowVerb[];
    readonly source: "run-to-collect";
  };
  readonly collection: {
    readonly stableId: string;
  };
  readonly annotations?: {
    readonly with: Record<string, JsonObject>;
  };
  readonly overrides?: {
    readonly resourceDefinitionRefs: readonly string[];
  };
  readonly raw?: {
    readonly dialects: readonly string[];
    readonly mode: "read-only";
  };
  readonly paradigm?: Paradigm;
  readonly specialization?: {
    readonly marker: "surfaced-specialization";
    readonly package: ParadigmPackageName;
    readonly equivalenceClass: EquivalenceClass;
    readonly path: string;
  };
  readonly extensions?: readonly {
    readonly source: "paradigm-package";
    readonly package: ParadigmPackageName;
    readonly port: "hobo:search";
    readonly features: readonly string[];
  }[];
  readonly portability?: {
    readonly specializationMarkers: readonly unknown[];
    readonly lockInMarkers?: readonly unknown[];
  };
}

export interface Manifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly resources: Record<string, DataManifestResource>;
}

export class AuthoringSurfaceError extends Error {
  readonly path: string;
  constructor(path: string, message: string);
}

export function importParadigmPackage(input: ImportedParadigmPackageInput): ImportedParadigmPackage;
export function data(name: string): DataHandle;
export function createManifest(handles: readonly DataHandle[]): Manifest;
