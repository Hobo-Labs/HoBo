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
  | "query"
  | "batch"
  | "analytics"
  | "full-text";

export type ConsistencyLevel =
  | "strong"
  | "bounded-staleness"
  | "session"
  | "consistent-prefix"
  | "eventual";

export type ProjectionSinkInput = Readonly<{
  type?: "projection-sink";
  kind: string;
  paradigm: SinkParadigm;
  capabilities?: readonly SinkCapability[];
}>;

export type ProjectionSink = Readonly<{
  type: "projection-sink";
  kind: string;
  paradigm: SinkParadigm;
  capabilities: readonly SinkCapability[];
}>;

export type NativeLogSink = Readonly<{
  type: "projection-sink";
  kind: "native";
  paradigm: "native";
  capabilities: readonly [];
}>;

export type NormalizedProjectionSink<Sink extends ProjectionSinkInput> = Readonly<
  Omit<Sink, "type" | "capabilities"> & {
    type: "projection-sink";
    capabilities: Sink extends { capabilities: infer Capabilities extends readonly SinkCapability[] }
      ? Capabilities
      : readonly [];
  }
>;

export type CapabilitiesOf<Sink> = Sink extends { capabilities: readonly (infer Capability)[] }
  ? Capability
  : never;

export type ReactivityFor<Sink> = Sink extends { kind: "native" }
  ? true
  : Sink extends { paradigm: "native" }
    ? true
    : Extract<CapabilitiesOf<Sink>, "change-feed"> extends never
      ? false
      : true;

export type ProjectionContract<Sink extends ProjectionSink = NativeLogSink> = Readonly<{
  name: string;
  readModel: string;
  readSet: readonly string[];
  sink: Sink;
  consistency: ConsistencyLevel;
  reactive: ReactivityFor<Sink>;
  reactivityClass: ReactivityFor<Sink> extends true ? "reactive" : "non-reactive";
  projectionDeclared: Readonly<{
    type: "projection.Declared";
    data: Readonly<{
      name: string;
      readModel: string;
      readSet: readonly string[];
      consistency: ConsistencyLevel;
      reactivityClass: ReactivityFor<Sink> extends true ? "reactive" : "non-reactive";
      reactivity: Readonly<{
        reactive: ReactivityFor<Sink>;
        source: "native-log" | "sink-change-feed" | "no-change-feed";
      }>;
      sink: Sink;
      reusedEventFamily: "data.Changed";
    }>;
  }>;
}>;

export type ProjectionInput<Sink extends ProjectionSink> = Readonly<{
  name: string;
  readModel: string;
  readSet: readonly string[];
  sink: Sink;
  consistency?: ConsistencyLevel;
}>;

export type NativeProjectionInput = Readonly<{
  name: string;
  readModel: string;
  readSet: readonly string[];
  sink?: undefined;
  consistency?: ConsistencyLevel;
}>;

export type DoctorWarning = Readonly<{
  code: string;
  severity: "warning";
  projection: string;
  message: string;
}>;

export type DataChangedOp = "insert" | "update" | "delete";

export type DataChangedEvent = Readonly<{
  type: "data.Changed";
  streamId: string;
  seq: number;
  data: Readonly<{
    resource: string;
    key: string;
    op: DataChangedOp;
  }>;
}>;

export type ExpectedChange = Readonly<{
  resource: string;
  key: string;
  op: DataChangedOp;
}>;

export type ConformanceResult = Readonly<{
  ok: boolean;
  suite: typeof CONFORMANCE_SUITE;
  sink: ProjectionSink;
  observed: number;
  expected: number;
  failures: readonly Readonly<{ code: string; message: string; index?: number }>[];
}>;

export declare const CHANGE_FEED_CAPABILITY: "change-feed";
export declare const DATA_CHANGED_EVENT_TYPE: "data.Changed";
export declare const PROJECTION_DECLARED_EVENT_TYPE: "projection.Declared";
export declare const CONFORMANCE_SUITE: "@hobo/conformance/projection-sink-change-feed";
export declare const PROJECTION_SINK_PARADIGMS: readonly SinkParadigm[];

export declare function nativeLogSink(): NativeLogSink;
export declare function projectionSink<const Sink extends ProjectionSinkInput>(
  input: Sink,
): NormalizedProjectionSink<Sink>;
export declare function declareProjectionContract(input: NativeProjectionInput): ProjectionContract<NativeLogSink>;
export declare function declareProjectionContract<const Sink extends ProjectionSink>(
  input: ProjectionInput<Sink>,
): ProjectionContract<Sink>;
export declare function doctorLiveView(projection: { name: string; reactive: boolean }): readonly DoctorWarning[];
export declare function assertLiveView<const Projection extends { reactive: true }>(
  projection: Projection,
): Projection;
export declare function readSnapshot<Projection extends { name: string; reactive: boolean }, Row>(
  projection: Projection,
  rows: readonly Row[],
  options?: { seq?: number },
): Readonly<{
  mode: "snapshot";
  projection: string;
  reactive: Projection["reactive"];
  seq: number;
  rows: readonly Row[];
}>;
export declare function dataChanged(input: {
  streamId?: string;
  seq: number;
  resource: string;
  key: string;
  op: DataChangedOp;
}): DataChangedEvent;
export declare function runOrderedFeedConformance(input: {
  sink: ProjectionSinkInput;
  expectedChanges: readonly ExpectedChange[];
  observedEvents: readonly DataChangedEvent[];
}): ConformanceResult;
