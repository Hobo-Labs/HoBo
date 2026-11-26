export type ConsistencyLevel =
  | "strong"
  | "bounded-staleness"
  | "session"
  | "consistent-prefix"
  | "eventual";

export type SinkParadigm =
  | "native"
  | "relational"
  | "document"
  | "kv"
  | "wide-column"
  | "graph"
  | "vector"
  | "object-lake"
  | "olap";

export type SinkCapability =
  | "change-feed"
  | "ordered-feed"
  | "query"
  | "batch"
  | "analytics"
  | "full-text";

export type CampScope = "single-camp" | "cross-camp";

export type ProjectionSink = Readonly<{
  kind: string;
  paradigm: SinkParadigm;
  capabilities?: readonly SinkCapability[];
}>;

export type NativeProjectionSink = Readonly<{
  kind: "native";
  paradigm: "native";
  capabilities: readonly [];
}>;

export type CapabilitiesOf<Sink> = Sink extends { capabilities: readonly (infer Capability)[] }
  ? Capability
  : never;

export type ReactivityFor<Sink> = Sink extends { kind: "native" }
  ? true
  : Extract<CapabilitiesOf<Sink>, "change-feed"> extends never
    ? false
    : true;

export type ProjectionDeclaredEvent<Sink extends ProjectionSink> = Readonly<{
  type: "projection.Declared";
  payload: Readonly<{
    projection: string;
    readModel: string;
    readSet: readonly string[];
    consistency: ConsistencyLevel;
    matchDecided: Readonly<{
      outcome: "match.Decided";
      consistencyLevel: ConsistencyLevel;
    }>;
    reactivity: Readonly<{
      class: ReactivityFor<Sink> extends true ? "reactive" : "non-reactive";
      reactive: ReactivityFor<Sink>;
      source: "native-log" | "sink-change-feed" | "no-change-feed";
    }>;
    sink: Sink;
  }>;
}>;

export type ProjectionContract<Sink extends ProjectionSink = NativeProjectionSink> = Readonly<{
  name: string;
  readModel: string;
  eventTypes: readonly string[];
  sink: Sink;
  consistency: ConsistencyLevel;
  scope: CampScope;
  reactive: ReactivityFor<Sink>;
  reactivityClass: ReactivityFor<Sink> extends true ? "reactive" : "non-reactive";
  projectionDeclared: ProjectionDeclaredEvent<Sink>;
}>;

export type ProjectionInput<Sink extends ProjectionSink> = Readonly<{
  name: string;
  readModel: string;
  eventTypes: readonly string[];
  sink: Sink;
  consistency?: ConsistencyLevel;
  scope?: CampScope;
}>;

export type NativeProjectionInput = Omit<ProjectionInput<NativeProjectionSink>, "sink"> &
  Readonly<{ sink?: undefined }>;

export declare const PROJECTION_DECLARED_EVENT_TYPE: "projection.Declared";
export declare const CONSISTENCY_LEVELS: readonly ConsistencyLevel[];

export declare function nativeSink(): NativeProjectionSink;
export declare function projectionSink<const Sink extends ProjectionSink>(sink: Sink): Sink;

export declare function declareProjection(input: NativeProjectionInput): ProjectionContract<NativeProjectionSink>;
export declare function declareProjection<const Sink extends ProjectionSink>(
  input: ProjectionInput<Sink>,
): ProjectionContract<Sink>;

export type DoctorWarning = Readonly<{
  code: string;
  severity: "warning";
  projection: string;
  message: string;
  /** Present on consistency-tradeoff warnings: the level that was preserved (never downgraded). */
  preservedLevel?: ConsistencyLevel;
}>;

export declare function doctorUseQuery(projection: { name: string; reactive: boolean }): readonly DoctorWarning[];
export declare function assessConsistencyTradeoffs(
  projection: { name: string; consistency: ConsistencyLevel; scope: CampScope },
): readonly DoctorWarning[];
export declare function assertReactiveProjection<const Projection extends { reactive: true }>(
  projection: Projection,
): Projection;
export declare function assertNonReactiveProjection<const Projection extends { reactive: false }>(
  projection: Projection,
): Projection;
