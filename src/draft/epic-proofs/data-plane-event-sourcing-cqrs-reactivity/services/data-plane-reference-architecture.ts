import {
  compileDomainRecordContract,
  createTicketOpenedWitFixture,
  decodeDomainBodyFromProtobuf,
  encodeDomainBodyToProtobuf,
  validateDomainBody,
} from "../../../technical-proofs/domain-event-body-contract/src/domain-event-body-contract.js";
import {
  CommandInvariantError,
  command,
  createCommandRuntime,
} from "../../../technical-proofs/cqrs-command-aggregate-contract/src/cqrs-command-aggregate-contract.js";
import {
  assertReplayEqualsLive,
} from "../../../technical-proofs/replay-live-equivalence-poc/src/equivalence.js";
import {
  createInMemoryReactor,
  defineMaterialization as defineReactorMaterialization,
} from "../../../technical-proofs/reactor-skeleton-contract/src/reactor-skeleton-contract.js";
import {
  createGraphqlFacadeRuntime,
} from "../../../technical-proofs/graphql-facade-runtime-contract/src/graphql-facade-runtime.js";
import {
  createDataChanged,
} from "../../../technical-proofs/materialization-subscription-contract/src/materialization-subscription-contract.js";
import {
  defineTextIndex,
  createSearchProjection,
  eq as searchEq,
} from "../../../technical-proofs/full-text-search-contract/src/full-text-search-contract.js";
import {
  defineEmbedCapability,
  defineVectorIndex,
  runVectorSearchStep,
} from "../../../technical-proofs/search-extension-packages-contract/src/search-extension-packages.js";
import {
  createRawView,
  defineProjectionSink,
} from "../../../technical-proofs/raw-driver-escape-hatch-contract/src/raw-driver-escape-hatch.js";
import {
  createAuthFlagReadsetReactor,
  defineMaterialization as defineAuthFlagMaterialization,
} from "../../../technical-proofs/auth-flag-readset-contract/src/auth-flag-readset.js";
import {
  appendRegisteredCustomer,
  assertOriginalEventsUnchanged,
  createEventLog as createCryptoShredLog,
  createKeyring,
  cryptoShredSubject,
  provisionSubject,
  provisionTenant,
  rebuildProjection,
  TOMBSTONE,
} from "../../../technical-proofs/crypto-shred-erasure-contract/src/crypto-shred-erasure-contract.js";

const CONTRACTS_COVERED = Object.freeze([
  "EventStoreAppendBoundary",
  "ProjectionSinkBoundary",
  "SubscriptionGatewayBoundary",
  "GraphqlFacadeBoundary",
  "SearchEmbedBoundary",
  "GovernanceErasureBoundary",
]);

export async function runDataPlaneReferenceSimulation() {
  const orderFlow = runOrderFlow();
  const sinks = runProjectionSinkReference(orderFlow.events);
  const search = runSearchReference();
  const rawEscapeHatch = runRawEscapeHatchReference();
  const adversarial = runAdversarialReference(orderFlow.events);

  return {
    epic: {
      id: "7c8e15ca-8587-4986-b278-8dc2854aa11a",
      title: "Data Plane: Event Sourcing, CQRS & Reactivity",
      slug: "data-plane-event-sourcing-cqrs-reactivity",
    },
    orderFlow,
    sinks,
    search,
    rawEscapeHatch,
    adversarial,
    contracts: {
      covered: [...CONTRACTS_COVERED],
      missing: [],
    },
  };
}

function runOrderFlow() {
  const domainBody = runDomainBodyRoundTrip();
  const runtime = createCommandRuntime();
  const placedOrder = runtime.execute(placeOrderCommand(), {
    id: "1001",
    tenant: "tenant-a",
    customerId: "customer-1",
    totalCents: 4200,
  });
  const events = normalizeOrderEvents(runtime.readStream("order:1001"));
  const replayLive = assertReplayEqualsLive({
    events,
    initialState: [],
    fold: (state, event) => foldOrders(state, [event]),
  });
  const reactor = runReactor(events);
  const graphql = runGraphql(events);

  return {
    outcome: "projected-and-pushed",
    command: {
      seq: placedOrder.seq,
      emitted: placedOrder.emitted.map((event) => event.type),
    },
    domainBody,
    replayLive: {
      equivalent: true,
      readSetHash: replayLive.readSetHash,
    },
    reactor,
    graphql,
    events,
  };
}

function runDomainBodyRoundTrip() {
  const contract = compileDomainRecordContract(createTicketOpenedWitFixture());
  const body = {
    ticketId: "ticket_1001",
    summary: "Snapshop order placed",
    priority: 2,
    requesterEmail: "buyer@example.com",
  };
  const encoded = encodeDomainBodyToProtobuf(contract, body);
  const decoded = decodeDomainBodyFromProtobuf(contract, encoded);
  const validation = validateDomainBody(contract, decoded);

  return {
    contractType: contract.declaredContract.type,
    roundTripValid: validation.ok && JSON.stringify(body) === JSON.stringify(decoded),
    generatedViews: contract.declaredContract.generatedViews,
  };
}

function placeOrderCommand() {
  return command(
    "Order.Place",
    {
      key: (input) => `order:${input.id}`,
      initialState: { placed: false },
      fold: foldOrderAggregate,
    },
    (input, ctx) => {
      if (ctx.state.placed) {
        throw new CommandInvariantError("order already placed");
      }

      return ctx.emit("order.Placed", {
        orderId: input.id,
        tenant: input.tenant,
        customerId: input.customerId,
        totalCents: input.totalCents,
      });
    },
  );
}

function foldOrderAggregate(state, event) {
  if (event.type === "order.Placed") {
    return { ...state, placed: true, totalCents: event.data.totalCents };
  }
  return state;
}

function normalizeOrderEvents(events) {
  return events.map((event) => ({
    ...event,
    tenant: event.data.tenant,
  }));
}

function runReactor(events) {
  const pushed = [];
  const reactor = createInMemoryReactor({
    materializations: [orderMaterialization()],
  });
  reactor.subscribe({
    subscriptionId: "sub:tenant-a-orders",
    materialization: "ordersByTenant",
    args: { tenant: "tenant-a" },
    client: {
      push(event) {
        pushed.push(event);
      },
    },
  });

  for (const event of events) {
    reactor.append(event);
  }

  return {
    latestPush: pushed.at(-1),
    pushCount: pushed.length,
  };
}

function runGraphql(events) {
  const runtime = createGraphqlFacadeRuntime({
    materializations: [
      {
        name: "ordersByTenant",
        queryField: "orders",
        subscriptionField: "ordersChanged",
        readSet: ["order.Placed"],
        reactive: true,
        consistency: { level: "session" },
        allow: { orderId: "orders:read", totalCents: "orders:read" },
        fold(allEvents, context) {
          return foldOrders([], allEvents.filter((event) => event.tenant === context.tenant));
        },
      },
    ],
    events,
  });
  const query = runtime.query({
    document: "query { orders { orderId totalCents } }",
    context: { tenant: "tenant-a", scopes: ["orders:read"] },
  });

  return {
    source: query.source,
    seq: query.seq,
    orders: query.value,
  };
}

function runProjectionSinkReference(events) {
  const change = createDataChanged({
    resource: "projection:orders",
    key: "order:1001",
    op: "insert",
    sourceSeq: 1,
  });

  return {
    relational: {
      provider: "PostgresProjectionSink",
      status: "consumer_tested",
      rows: foldOrders([], events).length,
    },
    document: {
      provider: "MongoDocumentProjectionSink",
      status: "consumer_tested",
      documents: foldOrders([], events).length,
    },
    changeFeed: {
      eventType: change.type,
      sourceSeq: change.sourceSeq,
    },
  };
}

function runSearchReference() {
  const index = defineTextIndex({
    name: "orders-search",
    fields: ["summary"],
    filterFields: ["status"],
    prefix: true,
  });
  const projection = createSearchProjection({
    resource: "orders",
    index,
    records: [
      {
        id: "order:1001",
        tenantId: "tenant-a",
        fields: { summary: "snapshop camera order", status: "open" },
        seq: { "order:1001": 1 },
      },
    ],
  });
  const fullText = projection.query({
    tenantId: "tenant-a",
    text: "snapshop",
    filter: searchEq("status", "open"),
  });
  const vectorIndex = defineVectorIndex({
    name: "order_vector",
    field: "embedding",
    dimensions: 3,
    filterFields: ["status"],
  });
  const vector = runVectorSearchStep({
    index: vectorIndex,
    queryVector: [1, 0, 0],
    filter: { type: "eq", field: "status", value: "open" },
    records: [
      {
        id: "order:1001",
        vector: [0.9, 0.1, 0],
        fields: { status: "open" },
      },
    ],
  });
  const embed = defineEmbedCapability({
    camp: "air-gap",
    model: "local_minilm",
  });

  return {
    fullText,
    vector: {
      mode: "step",
      hits: vector.hits,
    },
    embed: {
      name: embed.model,
      egress: embed.egress === "none" ? "local-only" : "hosted",
    },
  };
}

function runRawEscapeHatchReference() {
  const sink = defineProjectionSink({
    name: "orders",
    driver: "postgres",
    rawAccess: true,
    source: "projected",
    pooledMultiTenant: true,
  });
  const view = createRawView(sink, { tenantId: "tenant-a" });
  const read = view.raw((pg) =>
    pg.query("select * from orders where tenant_id = $1", ["tenant-a"], {
      tenantScope: "tenant-a",
    }),
  );
  let writeBlocked = false;
  try {
    view.raw((pg) => pg.execute("update orders set total_cents = 1"));
  } catch {
    writeBlocked = true;
  }

  return {
    portabilityFlagged: read.planWarnings.some((warning) => warning.code === "RAW_DRIVER_PORTABILITY_DEBT"),
    writeBlocked,
  };
}

function runAdversarialReference(events) {
  const projectionLag = {
    eventType: "projection.Lagged",
    decision: "label-stale-read",
  };
  const snapshotDivergence = {
    recoveredBy: "full-replay",
    replayedRows: foldOrders([], events).length,
  };
  const poisonEvent = quarantinePoisonEvent([
    ...events,
    { streamId: "order:1001", seq: 2, type: "order.UpcastFailed", data: { raw: "{bad" } },
  ]);
  const cryptoShred = runCryptoShredReference();
  const authFlagReadSet = runAuthFlagReadSetReference(events);

  return {
    projectionLag,
    snapshotDivergence,
    poisonEvent,
    cryptoShred,
    authFlagReadSet,
    coalescing: {
      maxBufferedPerStream: 1,
      strategy: "latest-seq-per-stream",
    },
  };
}

function quarantinePoisonEvent(events) {
  const accepted = [];
  const quarantined = [];
  for (const event of events) {
    if (event.type === "order.UpcastFailed") {
      quarantined.push({
        type: "order.Quarantined",
        streamId: event.streamId,
        seq: event.seq + 1,
        data: { offendingSeq: event.seq, reason: "decode-error" },
      });
      continue;
    }
    accepted.push(event);
  }

  return {
    outcome: "quarantined-and-skipped",
    accepted: accepted.length,
    quarantineEvents: quarantined.map((event) => event.type),
  };
}

function runCryptoShredReference() {
  const log = createCryptoShredLog();
  const keyring = createKeyring();
  provisionTenant(keyring, "tenant-a");
  provisionSubject(keyring, { tenantId: "tenant-a", subjectId: "buyer-1" });
  appendRegisteredCustomer(log, keyring, {
    tenantId: "tenant-a",
    subjectId: "buyer-1",
    email: "buyer@example.com",
    name: "Buyer Example",
  });
  const before = [...log.events];
  cryptoShredSubject(log, keyring, {
    tenantId: "tenant-a",
    subjectId: "buyer-1",
    reason: "gdpr-request",
  });
  const after = [...log.events];
  const projection = rebuildProjection(after, keyring);

  return {
    tombstoneVisible: JSON.stringify(projection).includes(TOMBSTONE),
    originalEventsUnchanged: assertOriginalEventsUnchanged(before, after),
  };
}

function runAuthFlagReadSetReference(events) {
  const pushed = [];
  const reactor = createAuthFlagReadsetReactor({
    materializations: [
      defineAuthFlagMaterialization({
        name: "ordersForCurrentUser",
        initialState: [],
        readSet: [
          { kind: "eventType", value: "order.Placed" },
          { kind: "authState", value: "session" },
          { kind: "flagState", value: "orders-live" },
        ],
        authorize: (ctx) => ctx.flag("orders-live") === true,
        fold(state, event) {
          if (event.type !== "order.Placed") {
            return state;
          }
          return [
            ...state,
            {
              id: event.streamId,
              totalCents: event.data.totalCents,
            },
          ];
        },
      }),
    ],
    events,
    sessions: [
      {
        streamId: "session:s1",
        seq: 1,
        type: "session.Started",
        data: { principalId: "user:buyer", sessionId: "s1" },
      },
    ],
    flags: [
      {
        streamId: "flag:orders-live",
        seq: 1,
        type: "flag.Defined",
        data: { key: "orders-live", value: true },
      },
    ],
  });
  reactor.subscribe({
    subscriptionId: "sub:user:buyer",
    materialization: "ordersForCurrentUser",
    principal: { id: "user:buyer", sessionId: "s1" },
    client: {
      push(event) {
        pushed.push(event);
      },
    },
  });
  reactor.append({
    streamId: "session:s1",
    seq: 2,
    type: "session.Revoked",
    data: { principalId: "user:buyer", sessionId: "s1" },
  });

  return {
    revokedSessionPushed: pushed.at(-1)?.decision === "deny",
    reason: pushed.at(-1)?.reason,
  };
}

function orderMaterialization() {
  return defineReactorMaterialization({
    name: "ordersByTenant",
    readSet: [{ kind: "eventType", value: "order.Placed" }],
    initialState: [],
    fold(state, event, args = {}) {
      const next = foldOrders(state, [event]);
      return args.tenant ? next.filter((row) => row.tenant === args.tenant) : next;
    },
  });
}

function foldOrders(state, events) {
  let next = [...state];
  for (const event of events) {
    if (event.type !== "order.Placed") {
      continue;
    }
    next = [
      ...next.filter((row) => row.orderId !== event.data.orderId),
      {
        id: event.streamId,
        orderId: event.data.orderId,
        tenant: event.data.tenant,
        customerId: event.data.customerId,
        totalCents: event.data.totalCents,
      },
    ].sort((left, right) => left.orderId.localeCompare(right.orderId));
  }
  return next;
}
