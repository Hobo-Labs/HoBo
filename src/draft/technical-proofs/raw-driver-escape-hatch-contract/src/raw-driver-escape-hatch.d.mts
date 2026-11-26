import { type JsonValue, type JsonObject } from "./json.js";
export type RawDriverName = "postgres" | "mongo" | "native";
export type ProjectionSinkSource = "projected" | "authoritative-external";

export interface ProjectionSinkDefinition<TDriver extends RawDriverName = RawDriverName> {
  name: string;
  driver: TDriver;
  rawAccess: boolean;
  source: ProjectionSinkSource;
  pooledMultiTenant?: boolean;
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

export interface RawDriverOptions {
  tenantScope?: string;
}

export interface RawDriverMap {
  postgres: PostgresRawDriver;
  mongo: MongoRawDriver;
  native: NativeRawDriver;
}

export interface RawDriverOperation {
  driver: RawDriverName;
  access: "read" | "write";
  tenantScope?: string;
  [key: string]: JsonValue;
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

export function defineProjectionSink<TDriver extends RawDriverName>(
  input: ProjectionSinkDefinition<TDriver>,
): ProjectionSinkDefinition<TDriver>;

export function createRawView<TDriver extends RawDriverName>(
  sink: ProjectionSinkDefinition<TDriver>,
  context?: { tenantId?: string },
): RawView<TDriver>;

export function canDeployWithRawEdges(
  rawEdges: RawManifestEdge[],
  targetDrivers: RawDriverName[],
):
  | {
      ok: true;
      warnings: PlanWarning[];
    }
  | {
      ok: false;
      reason: string;
      warnings: PlanWarning[];
    };
