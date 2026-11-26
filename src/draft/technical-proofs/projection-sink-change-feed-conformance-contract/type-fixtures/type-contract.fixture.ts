import {
  assertLiveView,
  dataChanged,
  declareProjectionContract,
  doctorLiveView,
  projectionSink,
  readSnapshot,
  runOrderedFeedConformance,
} from "@hobo-draft/projection-sink-change-feed-conformance-contract";

const batchWarehouse = projectionSink({
  kind: "warehouse-batch",
  paradigm: "olap",
  capabilities: ["analytics", "batch"],
} as const);

const nonReactiveProjection = declareProjectionContract({
  name: "DailyRevenue",
  readModel: "finance:revenue/daily@1.0.0",
  readSet: ["invoice.Paid"],
  sink: batchWarehouse,
});

const literalFalse: false = nonReactiveProjection.reactive;
doctorLiveView(nonReactiveProjection);
readSnapshot(nonReactiveProjection, [{ day: "2026-06-26", revenue: 42 }]);

// @ts-expect-error Non-change-feed sinks cannot back live views.
assertLiveView(nonReactiveProjection);

const kvChangeFeed = projectionSink({
  kind: "dynamodb-streams",
  paradigm: "kv",
  capabilities: ["query", "change-feed"],
} as const);

const reactiveKvProjection = declareProjectionContract({
  name: "SessionIndex",
  readModel: "identity:sessions/session-index@1.0.0",
  readSet: ["session.Started", "session.Revoked"],
  sink: kvChangeFeed,
});

const literalTrue: true = reactiveKvProjection.reactive;
assertLiveView(reactiveKvProjection);

runOrderedFeedConformance({
  sink: kvChangeFeed,
  expectedChanges: [{ resource: "sessions", key: "session-1", op: "insert" }],
  observedEvents: [dataChanged({ resource: "sessions", key: "session-1", op: "insert", seq: 1 })],
});

void literalFalse;
void literalTrue;
