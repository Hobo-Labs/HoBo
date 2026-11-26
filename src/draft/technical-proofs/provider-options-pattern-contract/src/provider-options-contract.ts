import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const MANIFEST_SCHEMA = "hobo.manifest/v1";
export const CONTRACT_VERSION = "hobo.provider-options/v1";

type ResourceKind = "data" | "component";
type RequirementMode = "prefer" | "require";

type RequirementOptions = {
  prefer?: string;
  require?: string;
};

type DatabaseOptions = RequirementOptions & {
  engine?: string;
};

type ServiceOptions = RequirementOptions & {
  workloadProfile?: string;
};

type RdsOptions = JsonObject & {
  multiAz?: boolean;
  backupRetentionDays?: number;
};

type FargateOptions = JsonObject & {
  cpu?: number;
};

type AzureFlexibleServerOptions = JsonObject & {
  haMode?: string;
};

type AzureContainerAppOptions = JsonObject & {
  workloadProfile?: string;
};

type ProviderOption<K extends ResourceKind, V extends JsonObject> = {
  __kind: "hobo.provider-option";
  provider: string;
  optionName: string;
  annotationKey: string;
  resourceKinds: readonly K[];
  value: V;
};

type Requirement = {
  mode: RequirementMode;
  capability: string;
};

type LockInMarker = {
  source: ".with()";
  annotation: string;
  provider: string;
  path: string;
  reason: string;
};

type ManifestResource = {
  type: string;
  port: string;
  className: string;
  requirement?: Requirement;
  annotations?: {
    with: Record<string, JsonValue>;
  };
  portability?: {
    lockInMarkers: LockInMarker[];
  };
};

type Manifest = {
  schema: typeof MANIFEST_SCHEMA;
  contract: typeof CONTRACT_VERSION;
  resources: Record<string, ManifestResource>;
};

type AnyResourceHandle = ResourceHandle<"data"> | ResourceHandle<"component">;

export const aws = {
  rds(options: RdsOptions): ProviderOption<"data", RdsOptions> {
    return providerOption("aws", "rds", ["data"], options);
  },
  fargate(options: FargateOptions): ProviderOption<"component", FargateOptions> {
    return providerOption("aws", "fargate", ["component"], options);
  }
};

export const azure = {
  flexibleServer(options: AzureFlexibleServerOptions): ProviderOption<"data", AzureFlexibleServerOptions> {
    return providerOption("azure", "flexibleServer", ["data"], options);
  },
  containerApp(options: AzureContainerAppOptions): ProviderOption<"component", AzureContainerAppOptions> {
    return providerOption("azure", "containerApp", ["component"], options);
  }
};

export function database(name: string, options: DatabaseOptions = {}): ResourceHandle<"data"> {
  const { engine = "generic", prefer, require } = options;
  return new ResourceHandle({
    id: name,
    kind: "data",
    type: "data.v1",
    port: "hobo:data",
    className: engine,
    requirement: toRequirement({ prefer, require })
  });
}

export function service(name: string, options: ServiceOptions = {}): ResourceHandle<"component"> {
  return new ResourceHandle({
    id: name,
    kind: "component",
    type: "component.v1",
    port: "hobo:component",
    className: options.workloadProfile ?? "wasm-component",
    requirement: toRequirement(options)
  });
}

export function createManifest(resources: readonly AnyResourceHandle[]): Manifest {
  const entries = resources.map((resource) => [resource.id, resource.toManifestResource()]);
  return {
    schema: MANIFEST_SCHEMA,
    contract: CONTRACT_VERSION,
    resources: Object.fromEntries(entries)
  };
}

export function resolvedProviderOptions(resource: ManifestResource | undefined, providerKey: string): Record<string, JsonValue> {
  const annotations = resource?.annotations?.with ?? {};
  return Object.fromEntries(
    Object.entries(annotations).filter(([annotationKey]) => annotationKey.startsWith(`${providerKey}.`))
  );
}

export function projectAgnosticResource(resource: ManifestResource): JsonValue {
  const { annotations: _annotations, portability: _portability, ...agnostic } = resource;
  // SAFETY: `return sortKeys(agnostic as JsonObject);` is required at this I/O or test boundary.
  return sortKeys(agnostic as JsonObject);
}

class ResourceHandle<K extends ResourceKind> {
  readonly id: string;
  readonly kind: K;
  readonly type: string;
  readonly port: string;
  readonly className: string;
  readonly requirement: Requirement | undefined;
  private providerAnnotations: Record<string, JsonValue>;
  private lockInMarkers: LockInMarker[];

  constructor({ id, kind, type, port, className, requirement }: {
    id: string;
    kind: K;
    type: string;
    port: string;
    className: string;
    requirement: Requirement | undefined;
  }) {
    this.id = id;
    this.kind = kind;
    this.type = type;
    this.port = port;
    this.className = className;
    this.requirement = requirement;
    this.providerAnnotations = {};
    this.lockInMarkers = [];
  }

  with(...options: ProviderOption<K, JsonObject>[]): this {
    for (const option of options) {
      this.addProviderOption(option);
    }
    return this;
  }

  addProviderOption(option: ProviderOption<K, JsonObject>): void {
    if (!option || option.__kind !== "hobo.provider-option") {
      throw new TypeError("with(...) accepts provider option builders only");
    }
    if (!option.resourceKinds.includes(this.kind)) {
      throw new TypeError(`${option.annotationKey} cannot annotate ${this.kind} resources`);
    }

    const existing = this.providerAnnotations[option.annotationKey] ?? {};
    this.providerAnnotations[option.annotationKey] = sortKeys(
      mergeOptionValues(existing, option.value, option.annotationKey)
    );
    this.lockInMarkers = buildLockInMarkers(this.id, this.providerAnnotations);
  }

  toManifestResource(): ManifestResource {
    const resource: ManifestResource = {
      type: this.type,
      port: this.port,
      className: this.className
    };

    if (this.requirement) {
      resource.requirement = this.requirement;
    }

    if (Object.keys(this.providerAnnotations).length > 0) {
      resource.annotations = {
        with: sortKeys(this.providerAnnotations)
      };
      resource.portability = {
        lockInMarkers: this.lockInMarkers
      };
    }

    return resource;
  }
}

function providerOption<K extends ResourceKind, V extends JsonObject>(
  provider: string,
  optionName: string,
  resourceKinds: readonly K[],
  value: V
): ProviderOption<K, V> {
  if (!isPlainObject(value)) {
    throw new TypeError(`${provider}.${optionName} options must be an object`);
  }

  return {
    __kind: "hobo.provider-option",
    provider,
    optionName,
    annotationKey: `${provider}.${optionName}`,
    resourceKinds,
    value: sortKeys(value)
  };
}

function toRequirement({ prefer, require: required }: RequirementOptions): Requirement | undefined {
  if (prefer && required) {
    throw new TypeError("prefer and require are mutually exclusive");
  }
  if (prefer) return { mode: "prefer", capability: prefer };
  if (required) return { mode: "require", capability: required };
  return undefined;
}

function mergeOptionValues(left: JsonValue, right: JsonValue, path: string): JsonValue {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    if (Object.is(left, right)) return left;
    throw new TypeError(`conflicting provider option ${path}`);
  }

  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (Object.hasOwn(merged, key)) {
      merged[key] = mergeOptionValues(merged[key], value, `${path}.${key}`);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function buildLockInMarkers(resourceId: string, annotations: Record<string, JsonValue>): LockInMarker[] {
  return Object.keys(annotations)
    .sort()
    .map((annotationKey) => {
      const provider = annotationKey.split(".")[0] ?? annotationKey;
      return {
        source: ".with()",
        annotation: annotationKey,
        provider,
        path: `resources.${resourceId}.annotations.with.${annotationKey}`,
        reason: "provider-specific option is additive but non-portable"
      };
    });
}

function isPlainObject(value: JsonValue): value is JsonObject {
  return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

function sortKeys<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    // SAFETY: `return value.map((item) => sortKeys(item)) as T;` is required at this I/O or test boundary.
    return value.map((item) => sortKeys(item)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  // SAFETY: `return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(` is required at this I/O or test boundary.
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) as T;
}
