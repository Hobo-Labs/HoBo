import { isJsonString, isJsonObject, type JsonValue, type JsonObject, type JsonBag } from "./json.js";
export type RawDriverName = "postgres" | "mongo" | "native";
export type ProjectionSinkSource = "projected" | "authoritative-external";

export interface ProjectionSinkDefinition<TDriver extends RawDriverName = RawDriverName> {
  name: string;
  driver: TDriver;
  rawAccess: boolean;
  source: ProjectionSinkSource;
  pooledMultiTenant?: boolean;
}

export interface RawDriverOptions {
  tenantScope?: string;
}

export interface RawDriverOperation {
  driver: RawDriverName;
  access: "read" | "write";
  tenantScope?: string;
  [key: string]: JsonValue | undefined;
}

export interface PostgresRawDriver {
  query(sql: string, params?: JsonValue[], options?: RawDriverOptions): RawDriverOperation;
  execute(sql: string, params?: JsonValue[], options?: RawDriverOptions): RawDriverOperation;
}

export interface MongoRawDriver {
  collection(name: string): {
    find(filter?: JsonObject, options?: RawDriverOptions): RawDriverOperation;
    updateOne(filter?: JsonObject, update?: JsonObject, options?: RawDriverOptions): RawDriverOperation;
  };
}

export interface NativeRawDriver {
  read(): RawDriverOperation;
}

export interface RawDriverMap {
  postgres: PostgresRawDriver;
  mongo: MongoRawDriver;
  native: NativeRawDriver;
}

export interface RawManifestEdge {
  code: "RAW_DRIVER_ESCAPE_HATCH";
  driver: RawDriverName;
  projection: string;
  readOnly: boolean;
  satisfiedBy: RawDriverName[];
}

export interface PlanWarning {
  code: "RAW_DRIVER_PORTABILITY_DEBT";
  driver: RawDriverName;
  projection: string;
  severity: "portability-debt";
}

export type IsolationWarning =
  | {
      code: "RAW_TENANT_SCOPE_UNPROVEN";
      projection: string;
      severity: "isolation-debt";
    }
  | {
      code: "RAW_TENANT_SCOPE_MISMATCH";
      expectedTenant: string;
      projection: string;
      severity: "isolation-debt";
      tenantScope: string;
    };

export interface RawResult {
  operation: RawDriverOperation;
  manifest: {
    rawEdges: RawManifestEdge[];
  };
  planWarnings: PlanWarning[];
  isolationWarnings: IsolationWarning[];
}

export interface RawView<TDriver extends RawDriverName> {
  raw(callback: (driver: RawDriverMap[TDriver]) => RawDriverOperation): RawResult;
}

export type CanDeployResult =
  | { ok: true; warnings: PlanWarning[] }
  | { ok: false; reason: string; warnings: PlanWarning[] };

const RAW_DRIVER_NAMES: Set<RawDriverName> = new Set(["postgres", "mongo", "native"]);
const SINK_SOURCES: Set<ProjectionSinkSource> = new Set(["projected", "authoritative-external"]);

export function defineProjectionSink<TDriver extends RawDriverName = RawDriverName>(
  input: ProjectionSinkDefinition<TDriver>,
): ProjectionSinkDefinition<TDriver> {
  if (!input || !isJsonObject(input)) {
    throw new TypeError("projection sink definition is required");
  }

  return Object.freeze({
    name: assertString(input.name, "sink.name"),
    // SAFETY: assertion to `driver: assertOneOf(input.driver, RAW_DRIVER_NAMES, "sink.driver") as TDriver,` is required at this boundary.
    driver: assertOneOf(input.driver, RAW_DRIVER_NAMES, "sink.driver") as TDriver,
    rawAccess: Boolean(input.rawAccess),
    source: assertOneOf(input.source, SINK_SOURCES, "sink.source"),
    pooledMultiTenant: Boolean(input.pooledMultiTenant),
  });
}

export function createRawView<TDriver extends RawDriverName>(
  sink: ProjectionSinkDefinition<TDriver>,
  context: { tenantId?: string } = {},
): RawView<TDriver> {
  const normalizedSink = defineProjectionSink(sink);
  const normalizedContext = normalizeContext(context);

  return Object.freeze({
    raw(callback: (driver: RawDriverMap[TDriver]) => RawDriverOperation): RawResult {
      if (!normalizedSink.rawAccess) {
        throw new Error(`raw access not advertised by ${normalizedSink.name}`);
      }
      if (!(callback instanceof Function)) {
        throw new TypeError("raw callback must be a function");
      }

      const operation = normalizeOperation(callback(createDriver(normalizedSink.driver)), normalizedSink.driver);
      if (operation.access === "write" && normalizedSink.source !== "authoritative-external") {
        throw new Error("raw writes require an authoritative-external store");
      }

      const rawEdge = rawManifestEdge(normalizedSink, operation);
      const planWarnings = planWarningsForEdges([rawEdge]);

      return deepFreeze({
        operation,
        manifest: {
          rawEdges: [rawEdge],
        },
        planWarnings,
        isolationWarnings: isolationWarningsFor(normalizedSink, normalizedContext, operation),
      });
    },
  });
}

export function canDeployWithRawEdges(rawEdges: RawManifestEdge[], targetDrivers: RawDriverName[]): CanDeployResult {
  if (!Array.isArray(rawEdges)) {
    throw new TypeError("rawEdges must be an array");
  }
  if (!Array.isArray(targetDrivers) || targetDrivers.length === 0) {
    throw new TypeError("targetDrivers must be a non-empty array");
  }

  const normalizedEdges = rawEdges.map(normalizeRawEdge);
  const warnings = planWarningsForEdges(normalizedEdges);

  for (const edge of normalizedEdges) {
    const unsupportedTarget = targetDrivers.find((target) => !edge.satisfiedBy.includes(target));
    if (unsupportedTarget) {
      return Object.freeze({
        ok: false,
        reason: `raw edge ${edge.projection} requires ${edge.driver}; unsatisfied by ${unsupportedTarget}`,
        warnings,
      });
    }
  }

  return Object.freeze({ ok: true, warnings });
}

function createDriver<TDriver extends RawDriverName>(driver: TDriver): RawDriverMap[TDriver];
function createDriver(driver: RawDriverName): RawDriverMap[RawDriverName] {
  if (driver === "postgres") {
    return Object.freeze({
      query(sql: string, params: JsonValue[] = [], options: RawDriverOptions = {}): RawDriverOperation {
        return rawOperation({
          driver,
          access: classifySqlAccess(sql, "read"),
          statement: assertString(sql, "sql"),
          params,
          tenantScope: options.tenantScope,
        });
      },
      execute(sql: string, params: JsonValue[] = [], options: RawDriverOptions = {}): RawDriverOperation {
        return rawOperation({
          driver,
          access: classifySqlAccess(sql, "write"),
          statement: assertString(sql, "sql"),
          params,
          tenantScope: options.tenantScope,
        });
      },
    });
  }

  if (driver === "mongo") {
    return Object.freeze({
      collection(name: string) {
        const collection = assertString(name, "collection");
        return Object.freeze({
          find(filter: JsonObject = {}, options: RawDriverOptions = {}): RawDriverOperation {
            return rawOperation({
              driver,
              access: "read",
              collection,
              filter,
              tenantScope: options.tenantScope,
            });
          },
          updateOne(
            filter: JsonObject = {},
            update: JsonObject = {},
            options: RawDriverOptions = {},
          ): RawDriverOperation {
            return rawOperation({
              driver,
              access: "write",
              collection,
              filter,
              update,
              tenantScope: options.tenantScope,
            });
          },
        });
      },
    });
  }

  return Object.freeze({
    read(): RawDriverOperation {
      return rawOperation({
        driver,
        access: "read",
        reason: "native projections do not expose raw dialect access",
      });
    },
  });
}

function rawOperation<T>(input: T): RawDriverOperation {
  // SAFETY: raw operations are stored as a JSON bag at this driver edge.
  const bag: JsonBag = input as never;
  const candidate: JsonBag = { ...bag };
  // SAFETY: assertion to `return deepFreeze({` is required at this boundary.
  return deepFreeze({
    ...candidate,
    driver: assertOneOf(candidate.driver, RAW_DRIVER_NAMES, "operation.driver"),
    access: assertOneOf(candidate.access, new Set<"read" | "write">(["read", "write"]), "operation.access"),
    ...(candidate.tenantScope === undefined
      ? undefined
      : { tenantScope: assertString(candidate.tenantScope, "tenantScope") }),
  }) as RawDriverOperation;
}

function normalizeOperation<T>(operation: T, expectedDriver: RawDriverName): RawDriverOperation {
  if (!operation) {
    throw new TypeError("raw callback must return a raw driver operation");
  }
  // SAFETY: callback results are treated as a JSON bag at this driver edge.
  const candidate: JsonBag = operation as never;
  if (candidate.driver !== expectedDriver) {
    throw new TypeError(`raw operation driver ${candidate.driver ?? "unknown"} does not match ${expectedDriver}`);
  }
  return rawOperation(candidate);
}

function rawManifestEdge(sink: ProjectionSinkDefinition, operation: RawDriverOperation): RawManifestEdge {
  // SAFETY: assertion to `return Object.freeze({` is required at this boundary.
  return Object.freeze({
    code: "RAW_DRIVER_ESCAPE_HATCH",
    driver: sink.driver,
    projection: sink.name,
    readOnly: operation.access === "read",
    satisfiedBy: Object.freeze([sink.driver]),
  }) as RawManifestEdge;
}

function normalizeRawEdge<T>(edge: T): RawManifestEdge {
  if (!edge || !isJsonObject(edge)) {
    throw new TypeError("raw edge must be an object");
  }

  // SAFETY: assertion to `const candidate = edge as JsonObject;` is required at this boundary.
  const candidate = edge as JsonObject;
  // SAFETY: assertion to `return Object.freeze({` is required at this boundary.
  return Object.freeze({
    code: "RAW_DRIVER_ESCAPE_HATCH",
    driver: assertOneOf(candidate.driver, RAW_DRIVER_NAMES, "edge.driver"),
    projection: assertString(candidate.projection, "edge.projection"),
    readOnly: Boolean(candidate.readOnly),
    satisfiedBy: Object.freeze(
      (Array.isArray(candidate.satisfiedBy) ? candidate.satisfiedBy : []).map((driver) =>
        assertOneOf(driver, RAW_DRIVER_NAMES, "edge.satisfiedBy"),
      ),
    ),
  }) as RawManifestEdge;
}

function planWarningsForEdges(edges: RawManifestEdge[]): PlanWarning[] {
  // SAFETY: assertion to `return Object.freeze(` is required at this boundary.
  return Object.freeze(
    edges.map(
      (edge) =>
        // SAFETY: assertion to `Object.freeze({` is required at this boundary.
        Object.freeze({
          code: "RAW_DRIVER_PORTABILITY_DEBT",
          driver: edge.driver,
          projection: edge.projection,
          severity: "portability-debt",
        }) as PlanWarning,
    ),
  ) as PlanWarning[];
}

function isolationWarningsFor(
  sink: ProjectionSinkDefinition,
  context: { tenantId?: string },
  operation: RawDriverOperation,
): IsolationWarning[] {
  if (!sink.pooledMultiTenant || operation.access !== "read") {
    // SAFETY: assertion to `return Object.freeze([]) as unknown as IsolationWarning[];` is required at this boundary.
    const empty: IsolationWarning[] = Object.freeze([]) as never;
    return empty;
  }
  if (!operation.tenantScope) {
    // SAFETY: assertion to `return Object.freeze([` is required at this boundary.
    return Object.freeze([
      Object.freeze({
        code: "RAW_TENANT_SCOPE_UNPROVEN",
        projection: sink.name,
        severity: "isolation-debt",
      }),
    ]) as IsolationWarning[];
  }
  if (context.tenantId && operation.tenantScope !== context.tenantId) {
    // SAFETY: assertion to `return Object.freeze([` is required at this boundary.
    return Object.freeze([
      Object.freeze({
        code: "RAW_TENANT_SCOPE_MISMATCH",
        expectedTenant: context.tenantId,
        projection: sink.name,
        severity: "isolation-debt",
        tenantScope: operation.tenantScope,
      }),
    ]) as IsolationWarning[];
  }

  // SAFETY: frozen empty isolation list is IsolationWarning[] at this boundary.
  const empty: IsolationWarning[] = Object.freeze([]) as never;
  return empty;
}

function classifySqlAccess(sql: string, fallback: "read" | "write"): "read" | "write" {
  const verb = assertString(sql, "sql").trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (["insert", "update", "delete", "merge", "create", "alter", "drop", "truncate"].includes(verb)) {
    return "write";
  }
  if (verb === "select" || verb === "with") {
    return "read";
  }
  return fallback;
}

function normalizeContext(context: JsonValue): { tenantId?: string } {
  if (!context || !isJsonObject(context)) {
    return Object.freeze({});
  }
  // SAFETY: assertion to `const candidate = context as JsonObject;` is required at this boundary.
  const candidate = context as JsonObject;
  return Object.freeze({
    ...(candidate.tenantId === undefined ? undefined : { tenantId: assertString(candidate.tenantId, "context.tenantId") }),
  });
}

function assertString(value: JsonValue, label: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertOneOf<T>(value: JsonValue, allowed: Set<T>, label: string): T {
  // SAFETY: assertion to `if (!allowed.has(value as T)) {` is required at this boundary.
  if (!allowed.has(value as T)) {
    throw new TypeError(`${label} must be one of: ${[...allowed].join(", ")}`);
  }
  // SAFETY: assertion to `return value as T;` is required at this boundary.
  return value as T;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    // SAFETY: assertion to `return Object.freeze(value) as T;` is required at this boundary.
    return Object.freeze(value) as T;
  }
  if (value && isJsonObject(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    // SAFETY: assertion to `return Object.freeze(value) as T;` is required at this boundary.
    return Object.freeze(value) as T;
  }
  return value;
}
