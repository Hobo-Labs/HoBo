import { isJsonString, isJsonObject, type JsonValue, type JsonObject, type JsonBag } from "./json.js";
export const MANIFEST_SCHEMA = "hobo.manifest/v1";
export const PARADIGM_PACKAGE_KIND = "hobo.paradigm-package";

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

export interface LoweringDescriptor {
  readonly lowersTo: "hobo:sdk";
  readonly kind: "data";
  readonly name: string;
  readonly handleStableId: string;
  readonly portRef: readonly ["hobo:data"];
  readonly extensionPortRef: readonly "hobo:search"[];
  readonly verb: DataAllowVerb;
  readonly args?: readonly unknown[];
  readonly raw?: {
    readonly dialect: string;
    readonly operation: JsonValue;
    readonly mode: "read-only";
  };
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
    readonly specializationMarkers?: readonly unknown[];
    readonly lockInMarkers?: readonly unknown[];
  };
}

export interface Manifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly resources: Record<string, DataManifestResource>;
}

interface CanonicalParadigmPackageEntry {
  readonly paradigm: Paradigm;
  readonly equivalenceClass: EquivalenceClass;
  readonly port: "hobo:data";
  readonly extensionPort?: "hobo:search";
}

interface ManifestResourceDraft {
  type: "data.v1";
  port: "hobo:data";
  kind: "data";
  allow: DataAllowVerb[];
  usage: {
    inferred: DataAllowVerb[];
    source: "run-to-collect";
  };
  collection: {
    stableId: string;
  };
  annotations?: {
    with: Record<string, JsonObject>;
  };
  overrides?: {
    resourceDefinitionRefs: string[];
  };
  raw?: {
    dialects: string[];
    mode: "read-only";
  };
  paradigm?: Paradigm;
  specialization?: {
    marker: "surfaced-specialization";
    package: ParadigmPackageName;
    equivalenceClass: EquivalenceClass;
    path: string;
  };
  extensions?: {
    source: "paradigm-package";
    package: ParadigmPackageName;
    port: "hobo:search";
    features: string[];
  }[];
  portability?: {
    specializationMarkers?: readonly unknown[];
    lockInMarkers?: readonly unknown[];
  };
}

const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DATA_ALLOW_VERBS: readonly DataAllowVerb[] = Object.freeze([
  "read",
  "write",
  "query",
  "admin",
]);
const CANONICAL_PARADIGM_PACKAGES: Readonly<Record<ParadigmPackageName, CanonicalParadigmPackageEntry>> =
  Object.freeze({
    "@hobo/sql": Object.freeze({
      paradigm: "relational",
      equivalenceClass: "managed-postgres",
      port: "hobo:data",
    }),
    "@hobo/document": Object.freeze({
      paradigm: "document",
      equivalenceClass: "managed-document",
      port: "hobo:data",
    }),
    "@hobo/vector": Object.freeze({
      paradigm: "vector",
      equivalenceClass: "search-extension",
      port: "hobo:data",
      extensionPort: "hobo:search",
    }),
    "@hobo/graph": Object.freeze({
      paradigm: "graph",
      equivalenceClass: "search-extension",
      port: "hobo:data",
      extensionPort: "hobo:search",
    }),
  });

export class AuthoringSurfaceError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "AuthoringSurfaceError";
    this.path = path;
  }
}

export function importParadigmPackage(input: ImportedParadigmPackageInput): ImportedParadigmPackage {
  if (!isRecord(input)) {
    throw new AuthoringSurfaceError("package", "must be a package descriptor");
  }
  assertNonEmptyString(input.packageName, "package.packageName");
  assertNonEmptyString(input.paradigm, "package.paradigm");
  assertNonEmptyString(input.equivalenceClass, "package.equivalenceClass");

  const canonical = CANONICAL_PARADIGM_PACKAGES[input.packageName];
  if (!canonical) {
    throw new AuthoringSurfaceError("package.packageName", "unknown HoBo paradigm package");
  }

  for (const key of ["paradigm", "equivalenceClass", "port", "extensionPort"] as const) {
    if (input[key] !== canonical[key]) {
      throw new AuthoringSurfaceError(
        `package.${key}`,
        `${input.packageName} must declare ${key}=${canonical[key] ?? "undefined"}`,
      );
    }
  }

  const features = (input.features ?? []).map((feature, index) =>
    normalizeFeature(feature, `package.features[${index}]`),
  );

  return Object.freeze({
    kind: PARADIGM_PACKAGE_KIND,
    packageName: input.packageName,
    paradigm: input.paradigm,
    equivalenceClass: input.equivalenceClass,
    port: input.port,
    extensionPort: input.extensionPort,
    features: Object.freeze(features),
  });
}

export function data(name: string): DataHandle {
  assertResourceName(name, "data.name");
  return new DataHandleImpl(name);
}

export function createManifest(handles: readonly DataHandle[]): Manifest {
  const resources: Record<string, DataManifestResource> = {};

  for (const handle of handles) {
    assertDataHandle(handle);
    if (Object.hasOwn(resources, handle.name)) {
      throw new AuthoringSurfaceError(`resources.${handle.name}`, "duplicate resource id");
    }
    resources[handle.name] = handle.toManifestResource();
  }

  return {
    schema: MANIFEST_SCHEMA,
    resources,
  };
}

class DataHandleImpl implements DataHandle {
  readonly kind: "data";
  readonly name: string;
  readonly port: "hobo:data";
  readonly stableId: string;
  private readonly usedVerbs: Set<DataAllowVerb>;
  private paradigmPackage: ImportedParadigmPackage | null;
  private readonly providerAnnotations: Record<string, JsonObject>;
  private readonly resourceDefinitionRefs: Set<string>;
  private readonly rawDialects: Set<string>;

  constructor(name: string) {
    this.kind = "data";
    this.name = name;
    this.port = "hobo:data";
    this.stableId = `data:${name}`;
    this.usedVerbs = new Set();
    this.paradigmPackage = null;
    this.providerAnnotations = {};
    this.resourceDefinitionRefs = new Set();
    this.rawDialects = new Set();
  }

  use(packageDescriptor: ImportedParadigmPackage): this {
    assertParadigmPackage(packageDescriptor, `resources.${this.name}.paradigm`);
    if (
      this.paradigmPackage &&
      this.paradigmPackage.packageName !== packageDescriptor.packageName
    ) {
      throw new AuthoringSurfaceError(
        `resources.${this.name}.paradigm`,
        `already bound to ${this.paradigmPackage.packageName}`,
      );
    }

    this.paradigmPackage = packageDescriptor;
    return this;
  }

  with(...options: readonly ProviderOption<string, "data", JsonObject>[]): this {
    for (const option of options) {
      this.addProviderOption(option);
    }
    return this;
  }

  resourceDefinition(reference: string): this {
    assertNonEmptyString(reference, `resources.${this.name}.resourceDefinition`);
    this.resourceDefinitionRefs.add(reference);
    return this;
  }

  raw(dialect: string, operation: JsonValue): LoweringDescriptor {
    assertNonEmptyString(dialect, `resources.${this.name}.raw.dialect`);
    this.recordVerb("query", `resources.${this.name}.raw`);
    this.rawDialects.add(dialect);
    return Object.freeze({
      lowersTo: "hobo:sdk",
      kind: "data",
      name: this.name,
      handleStableId: this.stableId,
      portRef: Object.freeze(["hobo:data"] as const),
      extensionPortRef: extensionPortRefFor(this.paradigmPackage),
      verb: "query",
      raw: Object.freeze({
        dialect,
        operation,
        mode: "read-only" as const,
      }),
    });
  }

  allow(...verbs: readonly DataAllowVerb[]): this {
    for (const verb of verbs) {
      this.recordVerb(verb, `resources.${this.name}.allow`);
    }
    return this;
  }

  read(...args: readonly unknown[]): LoweringDescriptor {
    return this.lower("read", args);
  }

  write(...args: readonly unknown[]): LoweringDescriptor {
    return this.lower("write", args);
  }

  query(...args: readonly unknown[]): LoweringDescriptor {
    return this.lower("query", args);
  }

  admin(...args: readonly unknown[]): LoweringDescriptor {
    return this.lower("admin", args);
  }

  private lower(verb: DataAllowVerb, args: readonly unknown[]): LoweringDescriptor {
    this.recordVerb(verb, `resources.${this.name}.${verb}`);
    return Object.freeze({
      lowersTo: "hobo:sdk",
      kind: "data",
      name: this.name,
      handleStableId: this.stableId,
      portRef: Object.freeze(["hobo:data"] as const),
      extensionPortRef: extensionPortRefFor(this.paradigmPackage),
      verb,
      args: Object.freeze([...args]),
    });
  }

  private recordVerb(verb: DataAllowVerb, path: string): void {
    if (!DATA_ALLOW_VERBS.includes(verb)) {
      throw new AuthoringSurfaceError(path, `data does not allow verb ${verb}`);
    }
    this.usedVerbs.add(verb);
  }

  private addProviderOption(option: ProviderOption<string, "data", JsonObject>): void {
    if (!isRecord(option) || option.__kind !== "hobo.provider-option") {
      throw new AuthoringSurfaceError(
        `resources.${this.name}.with`,
        "with(...) accepts provider option builders",
      );
    }
    if (!Array.isArray(option.resourceKinds) || !option.resourceKinds.includes("data")) {
      throw new AuthoringSurfaceError(
        `resources.${this.name}.with`,
        `${option.annotationKey ?? "provider option"} cannot annotate data resources`,
      );
    }
    assertNonEmptyString(option.annotationKey, `resources.${this.name}.with.annotationKey`);
    if (!isRecord(option.value)) {
      throw new AuthoringSurfaceError(
        `resources.${this.name}.with.${option.annotationKey}`,
        "provider option value must be an object",
      );
    }

    const existing = this.providerAnnotations[option.annotationKey] ?? {};
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    this.providerAnnotations[option.annotationKey] = sortKeys(
      mergeOptionValues(existing, option.value, option.annotationKey),
    ) as JsonObject;
  }

  toManifestResource(): DataManifestResource {
    const resource: ManifestResourceDraft = {
      type: "data.v1",
      port: "hobo:data",
      kind: "data",
      allow: [...this.usedVerbs].sort(),
      usage: {
        inferred: [...this.usedVerbs].sort(),
        source: "run-to-collect",
      },
      collection: {
        stableId: this.stableId,
      },
    };

    const specializationMarkers: JsonValue[] = [];
    const lockInMarkers: JsonValue[] = [];

    if (Object.keys(this.providerAnnotations).length > 0) {
      resource.annotations = {
        // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
        with: sortKeys(this.providerAnnotations) as Record<string, JsonObject>,
      };
      lockInMarkers.push(...buildProviderLockInMarkers(this.name, this.providerAnnotations));
    }

    if (this.resourceDefinitionRefs.size > 0) {
      resource.overrides = {
        resourceDefinitionRefs: [...this.resourceDefinitionRefs].sort(),
      };
      lockInMarkers.push(...buildResourceDefinitionLockInMarkers(this.name, this.resourceDefinitionRefs));
    }

    if (this.rawDialects.size > 0) {
      resource.raw = {
        dialects: [...this.rawDialects].sort(),
        mode: "read-only",
      };
      lockInMarkers.push(...buildRawLockInMarkers(this.name, this.rawDialects));
    }

    if (this.paradigmPackage) {
      specializationMarkers.push({
        source: "paradigm-package",
        package: this.paradigmPackage.packageName,
        marker: "surfaced-specialization",
        equivalenceClass: this.paradigmPackage.equivalenceClass,
        path: `resources.${this.name}.paradigm`,
        reason: `developer opted into ${this.paradigmPackage.packageName} over portable data() default`,
      });
      lockInMarkers.push(...buildParadigmLockInMarkers(this.name, this.paradigmPackage));

      resource.paradigm = this.paradigmPackage.paradigm;
      resource.specialization = {
        marker: "surfaced-specialization",
        package: this.paradigmPackage.packageName,
        equivalenceClass: this.paradigmPackage.equivalenceClass,
        path: `resources.${this.name}.paradigm`,
      };
      if (this.paradigmPackage.extensionPort) {
        resource.extensions = [
          {
            source: "paradigm-package",
            package: this.paradigmPackage.packageName,
            port: this.paradigmPackage.extensionPort,
            features: this.paradigmPackage.features.map((feature) => feature.name).sort(),
          },
        ];
      }
    }

    if (specializationMarkers.length > 0 || lockInMarkers.length > 0) {
      resource.portability = {
        ...(specializationMarkers.length > 0 ? { specializationMarkers } : undefined),
        ...(lockInMarkers.length > 0 ? { lockInMarkers } : undefined),
      };
    }

    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return sortKeys(resource) as DataManifestResource;
  }
}

function extensionPortRefFor(
  packageDescriptor: ImportedParadigmPackage | null,
): readonly "hobo:search"[] {
  return Object.freeze(packageDescriptor?.extensionPort ? [packageDescriptor.extensionPort] : []);
}

function buildParadigmLockInMarkers(resourceName: string, packageDescriptor: ImportedParadigmPackage) {
  return packageDescriptor.features
    .filter((feature) => feature.crossParadigmEquivalent === false)
    .map((feature) => ({
      category: "paradigm-mismatch",
      source: "paradigm-package-feature",
      package: packageDescriptor.packageName,
      feature: feature.name,
      path: `resources.${resourceName}.features.${feature.name}`,
      reason: "feature has no cross-paradigm equivalent",
      severity: "blocking",
    }));
}

function buildProviderLockInMarkers(
  resourceName: string,
  annotations: Record<string, JsonObject>,
) {
  return Object.keys(annotations)
    .sort()
    .map((annotationKey) => {
      const [provider] = annotationKey.split(".");
      return {
        source: ".with()",
        annotation: annotationKey,
        provider,
        path: `resources.${resourceName}.annotations.with.${annotationKey}`,
        reason: "provider-specific option is additive but non-portable",
      };
    });
}

function buildResourceDefinitionLockInMarkers(resourceName: string, references: Set<string>) {
  return [...references].sort().map((reference) => ({
    source: "Resource Definition",
    reference,
    path: `resources.${resourceName}.overrides.resourceDefinitionRefs`,
    reason: "resource mapping override is explicit and must be surfaced",
  }));
}

function buildRawLockInMarkers(resourceName: string, dialects: Set<string>) {
  return [...dialects].sort().map((dialect) => ({
    source: ".raw()",
    dialect,
    path: `resources.${resourceName}.raw.${dialect}`,
    reason: "raw dialect access is non-portable and read-only on projected data",
  }));
}

function normalizeFeature(feature: ParadigmPackageFeature, path: string): Required<ParadigmPackageFeature> {
  if (!isRecord(feature)) {
    throw new AuthoringSurfaceError(path, "feature must be a descriptor");
  }
  assertNonEmptyString(feature.name, `${path}.name`);
  return Object.freeze({
    name: feature.name,
    crossParadigmEquivalent: feature.crossParadigmEquivalent !== false,
  });
}

function assertParadigmPackage<T>(packageDescriptor: T, path: string): void {
  if (!isRecord(packageDescriptor) || packageDescriptor.kind !== PARADIGM_PACKAGE_KIND) {
    throw new AuthoringSurfaceError(path, "use(...) accepts imported Data Plane package descriptors");
  }
  if (packageDescriptor.port !== "hobo:data") {
    throw new AuthoringSurfaceError(path, "paradigm package must bind to hobo:data");
  }
}

function assertDataHandle<T>(handle: T): void {
  // SAFETY: data handles are host objects with kind and toManifestResource.
  const candidate = handle as { kind?: JsonValue; toManifestResource?: JsonValue };
  if (!isRecord(handle) || candidate.kind !== "data" || !(candidate.toManifestResource instanceof Function)) {
    throw new AuthoringSurfaceError("handles", "must contain data() handles");
  }
}

function assertResourceName(name: JsonValue, path: string): void {
  if (!isJsonString(name) || !RESOURCE_ID.test(name)) {
    throw new AuthoringSurfaceError(path, "invalid resource id");
  }
}

function assertNonEmptyString(value: JsonValue, path: string): void {
  if (!isJsonString(value) || value.length === 0) {
    throw new AuthoringSurfaceError(path, "must be a non-empty string");
  }
}

function isRecord<T>(value: T): value is T & JsonObject {
  return isJsonObject(value);
}

function mergeOptionValues(left: JsonValue, right: JsonValue, path: string): JsonValue {
  if (!isJsonObject(left) || !isJsonObject(right)) {
    if (Object.is(left, right)) return left;
    throw new AuthoringSurfaceError(path, `conflicting provider option ${path}`);
  }

  const merged: JsonBag = Object.assign({}, left);
  for (const [key, value] of Object.entries(right)) {
    if (Object.hasOwn(merged, key)) {
      merged[key] = mergeOptionValues(merged[key], value, `${path}.${key}`);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    const sorted: T =
      // SAFETY: array entries are recursively sorted with the same T contract.
      value.map((entry) => sortKeys(entry)) as never;
    return sorted;
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const bag: JsonBag = {};
  for (const key of Object.keys(value).sort()) {
    bag[key] = sortKeys(value[key] ?? null);
  }
  const sorted: T =
    // SAFETY: sorted bag preserves the caller's JSON-compatible object contract.
    bag as never;
  return sorted;
}
