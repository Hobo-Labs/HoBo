import {
  assertNonReactiveProjection,
  assertReactiveProjection,
  assessConsistencyTradeoffs,
  declareProjection,
  doctorUseQuery,
  projectionSink,
  type ConsistencyLevel,
} from "@hobo-draft/projection-consistency-reactivity-contract";

const olapSink = projectionSink({
  kind: "warehouse",
  paradigm: "olap",
  capabilities: ["analytics", "batch"],
} as const);

const nonReactiveProjection = declareProjection({
  name: "DailyRevenue",
  readModel: "DailyRevenue",
  eventTypes: ["Invoice.Paid"],
  sink: olapSink,
});

const literalFalse: false = nonReactiveProjection.reactive;
const eventLiteralFalse: false = nonReactiveProjection.projectionDeclared.payload.reactivity.reactive;
assertNonReactiveProjection(nonReactiveProjection);
doctorUseQuery(nonReactiveProjection);

// @ts-expect-error Non-change-feed sinks cannot be passed where a reactive projection is required.
assertReactiveProjection(nonReactiveProjection);

// @ts-expect-error The non-change-feed sink contract must not widen reactive to true.
const cannotClaimReactive: true = nonReactiveProjection.reactive;

const nativeProjection = declareProjection({
  name: "OpenTickets",
  readModel: "TicketList",
  eventTypes: ["Ticket.Opened"],
});

const nativeLiteralTrue: true = nativeProjection.reactive;
assertReactiveProjection(nativeProjection);
doctorUseQuery(nativeProjection);
assessConsistencyTradeoffs(nativeProjection);

const postgresSink = projectionSink({
  kind: "postgres",
  paradigm: "relational",
  capabilities: ["query", "change-feed"],
} as const);

const changeFeedProjection = declareProjection({
  name: "PostgresTickets",
  readModel: "TicketList",
  eventTypes: ["Ticket.Opened"],
  sink: postgresSink,
});

const changeFeedLiteralTrue: true = changeFeedProjection.reactive;
assertReactiveProjection(changeFeedProjection);

// A strong cross-Camp projection's tradeoff warning preserves the declared level
// and surfaces it via the typed `preservedLevel` field (never silently downgraded).
const strongCrossCamp = declareProjection({
  name: "GlobalAccountBalance",
  readModel: "AccountBalance",
  eventTypes: ["Ledger.Posted"],
  consistency: "strong",
  scope: "cross-camp",
});
const tradeoffWarnings = assessConsistencyTradeoffs(strongCrossCamp);
const preserved: ConsistencyLevel | undefined = tradeoffWarnings[0]?.preservedLevel;

void literalFalse;
void eventLiteralFalse;
void cannotClaimReactive;
void nativeLiteralTrue;
void changeFeedLiteralTrue;
void preserved;
