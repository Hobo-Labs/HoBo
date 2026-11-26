import { isJsonString, isJsonNumber, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type ResourceKind = "api" | "cache" | "queue";
export type RelationshipVerb = "dependsOn";

export interface ResourceRelationship {
  readonly from: string;
  readonly to: string;
  readonly verb: RelationshipVerb;
}

export interface ResourceDescriptor {
  readonly generatedId: string;
  readonly kind: ResourceKind;
  readonly ownerBindleId: string;
  readonly workload: WorkloadDescriptor | null;
  readonly annotations: readonly unknown[];
}

export interface WorkloadDescriptor {
  readonly kind: "inert-workload-factory";
  readonly factory: () => JsonValue | void;
}

export interface BindleManifest<TAliases extends Record<string, ResourceHandle>> {
  readonly name: string;
  readonly aliases: TAliases;
  readonly resources: readonly ResourceDescriptor[];
  readonly relationships: readonly ResourceRelationship[];
}

export interface ResourceIdentityLedgerEntry {
  readonly kind: ResourceKind;
  readonly occurrence: number;
  readonly generatedId: string;
  readonly identitySource: "hobo-generated";
  readonly reviewState: "accepted" | "pending-new";
}

export interface ResourceIdentityLedger {
  readonly bindleName: string;
  readonly artifactOwner: "hobo-collector";
  readonly updateFlow: "collector-proposes-review-accepts";
  readonly reviewBoundary: "code-review";
  readonly entries: readonly ResourceIdentityLedgerEntry[];
}

export interface BindleOptions {
  readonly identityLedger?: ResourceIdentityLedger;
}

export interface ResourceIdentityDiagnostic {
  readonly alias: string;
  readonly generatedId: string;
  readonly kind: ResourceKind;
  readonly ownerBindleId: string;
  readonly physicalNameSeed: string;
}

export type DependencyRef = ResourceHandle | ResourceDescriptor | JsonObject;

export interface ResourceHandle<TKind extends ResourceKind = ResourceKind> {
  readonly generatedId: string;
  readonly kind: TKind;
  dependsOn(...dependencies: readonly DependencyRef[]): ResourceHandle<TKind>;
  with(...annotations: readonly JsonValue[]): ResourceHandle<TKind>;
}

export interface ClosureBuilder {
  api(workload: () => JsonValue | void): ResourceHandle<"api">;
  cache(): ResourceHandle<"cache">;
  queue<_TMessage = JsonValue>(): ResourceHandle<"queue">;
}

export class ClosureBuilderResourceError extends Error {
  readonly code: string;
  readonly details: JsonObject;

  constructor(code: string, message: string, details: JsonObject = {}) {
    super(`${code}: ${message}`);
    this.name = "ClosureBuilderResourceError";
    this.code = code;
    this.details = details;
  }
}

export function createResourceIdentityLedger(input: JsonValue): ResourceIdentityLedger {
  if (!isJsonObject(input) || input === null) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_SHAPE",
      "resource identity ledger must be an object",
    );
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const record = input as JsonObject;
  const bindleName = requireNonEmptyString(record.bindleName, "bindleName");
  if (record.artifactOwner !== "hobo-collector") {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_OWNER",
      "resource identity ledger must be owned by the HoBo collector artifact",
      { artifactOwner: record.artifactOwner },
    );
  }
  if (record.updateFlow !== "collector-proposes-review-accepts") {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_UPDATE_FLOW",
      "resource identity ledger updates must be proposed by collection and accepted at review",
      { updateFlow: record.updateFlow },
    );
  }
  if (record.reviewBoundary !== "code-review") {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_REVIEW_BOUNDARY",
      "resource identity ledger changes must cross a code review boundary",
      { reviewBoundary: record.reviewBoundary },
    );
  }
  if (!Array.isArray(record.entries)) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_ENTRIES",
      "resource identity ledger entries must be an array",
    );
  }

  const seenOccurrences = new Set<string>();
  const seenGeneratedIds = new Set<string>();
  const entries = record.entries.map((entry) => {
    const parsed = parseResourceIdentityLedgerEntry(entry);
    const occurrenceKey = `${parsed.kind}:${parsed.occurrence}`;
    if (seenOccurrences.has(occurrenceKey)) {
      throw new ClosureBuilderResourceError(
        "CLOSURE_BUILDER_LEDGER_DUPLICATE_OCCURRENCE",
        "resource identity ledger cannot map one kind occurrence twice",
        { occurrenceKey },
      );
    }
    if (seenGeneratedIds.has(parsed.generatedId)) {
      throw new ClosureBuilderResourceError(
        "CLOSURE_BUILDER_LEDGER_DUPLICATE_ID",
        "resource identity ledger cannot reuse generated IDs",
        { generatedId: parsed.generatedId },
      );
    }
    seenOccurrences.add(occurrenceKey);
    seenGeneratedIds.add(parsed.generatedId);
    return parsed;
  });

  return deepFreeze({
    bindleName,
    artifactOwner: "hobo-collector",
    updateFlow: "collector-proposes-review-accepts",
    reviewBoundary: "code-review",
    entries,
  });
}

export function bindle<TAliases extends Record<string, ResourceHandle>>(
  name: string,
  builderFn: (builder: ClosureBuilder) => TAliases,
  options: BindleOptions = {},
): BindleManifest<TAliases> {
  if (!name.trim()) {
    throw new ClosureBuilderResourceError("CLOSURE_BUILDER_BINDLE_NAME", "bindle name must be non-empty");
  }
  if (options.identityLedger && options.identityLedger.bindleName !== name) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_BINDLE_MISMATCH",
      "resource identity ledger can only be used with its recorded Bindle",
      { expected: options.identityLedger.bindleName, actual: name },
    );
  }

  const context = new BuilderContext(name, options.identityLedger);
  const builder = context.builder();
  const aliases = builderFn(builder);

  return Object.freeze({
    name,
    aliases,
    resources: deepFreeze(context.resourceSnapshots()),
    relationships: deepFreeze([...context.relationships]),
  });
}

export function resourceIdentityDiagnostics(
  manifest: BindleManifest<Record<string, ResourceHandle>>,
): readonly ResourceIdentityDiagnostic[] {
  const resourcesById = new Map(manifest.resources.map((resource) => [resource.generatedId, resource]));
  return deepFreeze(
    Object.entries(manifest.aliases).map(([alias, handle]) => {
      const resource = resourcesById.get(handle.generatedId);
      if (!resource) {
        throw new ClosureBuilderResourceError(
          "CLOSURE_BUILDER_ALIAS_RESOURCE_MISSING",
          "identity diagnostics can only project aliases for collected resources",
          { alias, generatedId: handle.generatedId },
        );
      }
      return {
        alias,
        generatedId: resource.generatedId,
        kind: resource.kind,
        ownerBindleId: resource.ownerBindleId,
        physicalNameSeed: `${resource.ownerBindleId}:${resource.generatedId}`,
      };
    }),
  );
}

class BuilderContext {
  readonly relationships: ResourceRelationship[] = [];
  private readonly handles: ResourceHandleImpl[] = [];
  private readonly kindCounts = new Map<ResourceKind, number>();
  private readonly allocatedGeneratedIds = new Set<string>();
  private readonly ledgerGeneratedIds: ReadonlySet<string>;

  constructor(
    readonly ownerBindleId: string,
    private readonly identityLedger: ResourceIdentityLedger | undefined,
  ) {
    this.ledgerGeneratedIds = new Set(identityLedger?.entries.map((entry) => entry.generatedId) ?? []);
  }

  builder(): ClosureBuilder {
    return {
      api: (workload: () => JsonValue | void, ...extra: readonly JsonValue[]) => {
        assertWorkloadFactory("api", workload, extra);
        return this.create("api", { kind: "inert-workload-factory", factory: workload });
      },
      cache: (...args: readonly JsonValue[]) => {
        assertNoFactoryArgs("cache", args);
        return this.create("cache", null);
      },
      queue: <_TMessage = JsonValue>(...args: readonly JsonValue[]) => {
        assertNoFactoryArgs("queue", args);
        return this.create("queue", null);
      },
    };
  }

  resourceSnapshots(): ResourceDescriptor[] {
    return this.handles.map((handle) => handle.snapshot());
  }

  private create<TKind extends ResourceKind>(
    kind: TKind,
    workload: WorkloadDescriptor | null,
  ): ResourceHandle<TKind> {
    const kindOrdinal = (this.kindCounts.get(kind) ?? 0) + 1;
    this.kindCounts.set(kind, kindOrdinal);
    const handle = new ResourceHandleImpl<TKind>(
      this,
      this.allocateGeneratedId(kind, kindOrdinal),
      kind,
      workload,
    );
    this.handles.push(handle);
    return handle;
  }

  private allocateGeneratedId(kind: ResourceKind, occurrence: number): string {
    const ledgerEntry = this.identityLedger?.entries.find(
      (entry) => entry.kind === kind && entry.occurrence === occurrence,
    );
    const generatedId = ledgerEntry?.generatedId ?? this.nextGeneratedId(kind, occurrence);
    if (this.allocatedGeneratedIds.has(generatedId)) {
      throw new ClosureBuilderResourceError(
        "CLOSURE_BUILDER_LEDGER_DUPLICATE_ALLOCATION",
        "resource identity ledger allocated a generated ID more than once",
        { generatedId },
      );
    }
    this.allocatedGeneratedIds.add(generatedId);
    return generatedId;
  }

  private nextGeneratedId(kind: ResourceKind, startingOrdinal: number): string {
    let ordinal = startingOrdinal;
    let generatedId = generatedResourceId(kind, ordinal);
    while (this.allocatedGeneratedIds.has(generatedId) || this.ledgerGeneratedIds.has(generatedId)) {
      ordinal += 1;
      generatedId = generatedResourceId(kind, ordinal);
    }
    return generatedId;
  }
}

function generatedResourceId(kind: ResourceKind, ordinal: number): string {
  return `res_${kind}_${String(ordinal).padStart(4, "0")}`;
}

class ResourceHandleImpl<TKind extends ResourceKind = ResourceKind> implements ResourceHandle<TKind> {
  private readonly annotations: JsonValue[] = [];

  constructor(
    private readonly context: BuilderContext,
    readonly generatedId: string,
    readonly kind: TKind,
    private readonly workload: WorkloadDescriptor | null,
  ) {}

  dependsOn(...dependencies: readonly DependencyRef[]): ResourceHandle<TKind> {
    for (const dependency of dependencies) {
      const target = parseDependency(this.context, dependency);
      this.context.relationships.push({
        from: this.generatedId,
        to: target.generatedId,
        verb: "dependsOn",
      });
    }
    return this;
  }

  with(...annotations: readonly JsonValue[]): ResourceHandle<TKind> {
    this.annotations.push(...annotations);
    return this;
  }

  snapshot(): ResourceDescriptor {
    return {
      generatedId: this.generatedId,
      kind: this.kind,
      ownerBindleId: this.context.ownerBindleId,
      workload: this.workload,
      annotations: [...this.annotations],
    };
  }

  ownerBindleId(): string {
    return this.context.ownerBindleId;
  }
}

function parseDependency(context: BuilderContext, value: DependencyRef): ResourceHandleImpl {
  if (value instanceof ResourceHandleImpl) {
    if (value.ownerBindleId() !== context.ownerBindleId) {
      throw new ClosureBuilderResourceError(
        "CLOSURE_BUILDER_CROSS_BINDLE_DEPENDENCY",
        "dependsOn() can only reference handles created inside the same bindle builder closure",
        { from: context.ownerBindleId, to: value.ownerBindleId() },
      );
    }
    return value;
  }

  // SAFETY: descriptors and foreign bags are inspected for ownerBindleId only.
  const bag: { ownerBindleId?: JsonValue } = value as never;
  if (isResourceDescriptor(value) && bag.ownerBindleId !== context.ownerBindleId) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_CROSS_BINDLE_DEPENDENCY",
      "dependsOn() cannot reference resource snapshots from another bindle",
      { from: context.ownerBindleId, to: bag.ownerBindleId ?? null },
    );
  }

  throw new ClosureBuilderResourceError(
    "CLOSURE_BUILDER_INVALID_DEPENDENCY",
    "dependsOn() expects a resource handle returned by the same closure builder",
    { from: context.ownerBindleId },
  );
}

function assertNoFactoryArgs(kind: ResourceKind, args: readonly JsonValue[]): void {
  if (args.length === 0) return;
  throw new ClosureBuilderResourceError(
    "CLOSURE_BUILDER_NAMED_RESOURCE_ARG",
    `b.${kind}() does not accept resource name arguments in the v1 closure builder`,
    { kind, args: [...args] },
  );
}

function parseResourceIdentityLedgerEntry(input: JsonValue): ResourceIdentityLedgerEntry {
  if (!isJsonObject(input) || input === null) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_ENTRY_SHAPE",
      "resource identity ledger entry must be an object",
    );
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const record = input as JsonObject;
  if (
    record.identitySource !== "hobo-generated" ||
    "alias" in record ||
    "returnedKey" in record ||
    "physicalNameSeed" in record
  ) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_ALIAS_IDENTITY",
      "resource identity ledger entries cannot derive identity from aliases, returned keys, or physical names",
      { identitySource: record.identitySource },
    );
  }
  const kind = requireResourceKind(record.kind);
  const occurrence = requirePositiveInteger(record.occurrence, "occurrence");
  const generatedId = requireNonEmptyString(record.generatedId, "generatedId");
  const expectedPrefix = `res_${kind}_`;
  if (!new RegExp(`^${expectedPrefix}\\d{4}$`).test(generatedId)) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_GENERATED_ID",
      "resource identity ledger generated ID must match its resource kind",
      { kind, generatedId },
    );
  }
  if (record.reviewState !== "accepted" && record.reviewState !== "pending-new") {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_LEDGER_REVIEW_STATE",
      "resource identity ledger entry must be accepted or pending-new",
      { reviewState: record.reviewState },
    );
  }

  return {
    kind,
    occurrence,
    generatedId,
    identitySource: "hobo-generated",
    reviewState: record.reviewState,
  };
}

function requireResourceKind(value: JsonValue): ResourceKind {
  if (value === "api" || value === "cache" || value === "queue") {
    return value;
  }
  throw new ClosureBuilderResourceError(
    "CLOSURE_BUILDER_LEDGER_KIND",
    "resource identity ledger kind must be a supported closure-builder resource kind",
    { kind: value },
  );
}

function requirePositiveInteger(value: JsonValue, field: string): number {
  if (Number.isSafeInteger(value) && isJsonNumber(value) && value > 0) {
    return value;
  }
  throw new ClosureBuilderResourceError(
    "CLOSURE_BUILDER_LEDGER_POSITIVE_INTEGER",
    `${field} must be a positive integer`,
    { [field]: value },
  );
}

function requireNonEmptyString(value: JsonValue, field: string): string {
  if (isJsonString(value) && value.trim()) {
    return value;
  }
  throw new ClosureBuilderResourceError(
    "CLOSURE_BUILDER_LEDGER_STRING",
    `${field} must be a non-empty string`,
    { [field]: value },
  );
}

function assertWorkloadFactory<T>(
  kind: ResourceKind,
  workload: T,
  extra: readonly JsonValue[],
): asserts workload is T & ((...args: never[]) => JsonValue | void) {
  if (!(workload instanceof Function)) {
    throw new ClosureBuilderResourceError(
      "CLOSURE_BUILDER_WORKLOAD_FACTORY",
      `b.${kind}(...) expects an inert workload factory function`,
      { kind },
    );
  }
  assertNoFactoryArgs(kind, extra);
}

function isResourceDescriptor<T>(value: T): boolean {
  return (
    isJsonObject(value) &&
    value !== null &&
    "generatedId" in value &&
    "ownerBindleId" in value &&
    "kind" in value
  );
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return Object.freeze(value) as T;
  }
  if (isJsonObject(value) && value !== null) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}
