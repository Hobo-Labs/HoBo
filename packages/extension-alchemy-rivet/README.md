# @hobo/alchemy-rivet

This package composes the Alchemy IaC adapter with the Rivet runtime. It
contains no independent actor implementation or persistent service.

The mapper follows parse, don't validate: `bindRivetDurableTopicSource`
captures a source fence and returns the checked `RivetStandaloneSource` as a
parsed domain type after authenticating the runtime's locally branded actor,
the registry, pool authority and host verifier. The TypeScript type is not a
nominal security proof; the resource constructor rechecks the source before
the provider effect and during deployment. The source-claim protobuf and CUE
model document the portable values passed to the host verifier; the live
function and actor identities are verified separately and are not serialized.

The declaration is a command to construct a single Alchemy resource. Topic
commands and events belong to the Rivet actor's retained log; this composition
owns no event store, materialized view, projection, snapshot, or read store.
The actor's durable storage and its recovery guarantees remain the host's
responsibility, as described in the runtime guide below.


`@hobo/alchemy-rivet` maps the opt-in
`@hobo/runtime-rivet` retained topic-log actor to an Alchemy
`Rivet.DurableObject`. Its explicit
`RIVET_DURABLE_TOPIC_LOG_CAPABILITIES` profile supports topic creation,
publication, retained-log reads, audit and compaction. Consumer groups, leases,
acknowledgements and dead letters are unsupported. This partial asynchronous
profile does not implement the full HoBo Bindle topic or message bus contract;
their capability reporting remains unsupported for the retained-log actor.

Define the actor and its registry in a module that is safe for the IaC planner
to import:

```ts
// events.ts
import { setup } from "rivetkit";
import { createRivetDurableTopicActor } from "@hobo/runtime-rivet";
import { host } from "./host.js";

export const events = createRivetDurableTopicActor({
  actorName: "events",
  semanticDigest: host.topicSourceFence.environmentDigest,
  now: () => host.trustedClock.nowMs(),
  resolveScope: (input) => host.resolveTopicScope(input),
  authorize: (claim) => host.authorizeTopicOperation(claim),
  verifyIngress: (claim) => host.verifyBoundedTopicIngress(claim),
});
export const registry = setup({ use: { events: events.actor } });
```

Alchemy runs the separate, source-fenced pool entrypoint:

```ts
// events-main.ts
import { registry } from "./events.js";
registry.start();
```

The IaC declaration imports the inert definition and specifies the absolute
path to that exact entrypoint:

```ts
import { rivetDurableTopicResource } from "@hobo/alchemy-rivet";
import { events, registry } from "./events.js";

const topicLog = rivetDurableTopicResource({
  main: absoluteEventsMainPath,
  resourceName: "events",
  bindleName: "events-app",
  sourceDigest,
  sourceFence: host.topicSourceFence,
  poolDigest,
  isolationDigest,
  poolHost,
  registry,
  binding: events,
  verifySource: (claim) => host.verifyTopicSourceAndExclusivePool(claim),
});
```

The actor's captured `semanticDigest` must equal the source fence's
`environmentDigest`, which appears in the authorized Alchemy plan. Equality
is only an identity check: the trusted host must independently attest that the
digest covers the complete executable and dependency closure, actor identity,
fixed profile, behavior-affecting configuration and build/upload environment.
The actor brand is local to one `@hobo/runtime-rivet` module instance. In the
IaC process, construct the actor using the same installed runtime instance that
the mapper resolves as its dependency; duplicate runtime copies fail closed as an
unrecognized binding. The separately bundled pool process constructs its own
actor, whose exact source and configuration the host must attest independently.
It must also verify that the main starts this exact registry and authorized
policies on the attested exclusive pool. The plan's complete
`composite.sourceRequirements` must include
`{ resourceId: "events", resourceType: "Rivet.DurableObject", bindleName:
"events-app", applicationName: "events", sourceKind: "rivet-async-topic",
sourcePath: absoluteEventsMainPath }`.

The host must authenticate tenant and instance scope, enforce ingress and
response limits, fence previous owners, and independently provide durable
storage and a monotonic clock. Deleting or recreating the actor can destroy
its retained log and idempotency records; state transfer, draining and verified
destruction authorization are host obligations. See the
[runtime actor guide](../runtimes/runtime-rivet/DURABLE-TOPIC-ACTOR.md)
for exact bounds and failure outcomes. The target is unpriced unless the host
supplies an authorized pricing model; unpriced execution requires its own
explicit policy decision.

## Durable topic bus

Use `createRivetDurableTopicBusActor` with an independently verified `authorizeInstanceScope` callback, then pass its branded binding to `rivetDurableTopicBusResource`. The bus profile supports subscriptions, consumer groups, delivery leases, acknowledgement, dead letters, compaction, and audit within its advertised limits. Its host must fence the complete instance, including all dead-letter destinations, and authenticate the same source and pool evidence as the retained log.

## HTTP application with a topic bus

`@hobo/alchemy-rivet/http-topic-bus` composes one HTTP actor with a separately authorized durable bus actor in the same verified Rivet registry. The application factory receives the bound bus client:

```ts
import { setup } from "rivetkit";
import {
  createRivetHttpTopicBusApplication,
  createRivetHttpTopicBusMappers,
} from "@hobo/alchemy-rivet/http-topic-bus";

// bus is a branded createRivetDurableTopicBusActor result.
// host supplies authenticated clientOptions and verifies the exact binding.
const app = createRivetHttpTopicBusApplication({
  actorName: "web",
  bus,
  clientOptions: host.busClientOptions,
  verifyScope: (claim) => host.verifyBusScope(claim),
  authorize: (claim) => host.authorizeHttp(claim),
  application: (messages) => async (request) => {
    const result = await messages.publish(host.messageFor(request));
    return Response.json({ status: result.status });
  },
});
const registry = setup({ use: { web: app.http.actor, events: bus.actor } });
const mappers = createRivetHttpTopicBusMappers({
  application: app,
  source: { ...host.httpSource, registry, binding: app.http },
  poolDigest: host.poolDigest,
  isolationDigest: host.isolationDigest,
  poolHost: host.poolHost,
  verifyPool: (claim) => host.verifyExclusivePool(claim),
});
```

The host must fence the complete source, registry, transport and pool through each request and response. An unknown publish result can have committed and must be reconciled. The raw bus composition above does not map a Bindle topic dependency. The finite model in `model/RivetHttpTopicBus.tla` checks a bounded authority and timeout abstraction; it does not prove the implementation or host.

For a Bindle that declares named topics, use the scoped composition instead:

```ts
import { bindle, sessionReplay } from "@hobo/bindles";
import { mapBindleToAlchemy } from "@hobo/iac-alchemy";
import {
  bindRivetBindleTopicEntrypoint,
  createRivetBindleTopicBusApplication,
  createRivetBindleTopicBusMappers,
} from "@hobo/alchemy-rivet/http-topic-bus";
import { setup } from "rivetkit";

const shop = bindle("shop", (b) => {
  const orders = b.topic().allow("publish");
  return {
    orders,
    web: b.web().with(sessionReplay({ enabled: false })).dependsOn(orders),
  };
});

// The host supplies the branded bus, credentials, authorities and durable IDs.
const app = createRivetBindleTopicBusApplication({
  actorName: "web",
  bus,
  clientOptions: host.busClientOptions,
  verifyScope: (claim) => host.verifyBusScope(claim),
  authorize: (claim) => host.authorizeHttp(claim),
  bindle: {
    bindleName: shop.name,
    applicationName: "web",
    resources: shop.resources,
    edges: shop.edges,
    bindings: [{ resourceName: "orders", topic: "orders", subscriptions: [] }],
  },
  operations: host.persistedTopicOperations,
  hostOptions: (client) => host.topicHostOptions(client),
  application: (topics) => async (request) => {
    const outcome = await topics.topic("orders").publish(host.messageFor(request));
    return Response.json({ status: outcome.tag });
  },
});
const registry = setup({ use: { web: app.http.actor, [bus.actorName]: bus.actor } });
const mappers = createRivetBindleTopicBusMappers({
  application: app,
  source: { ...host.httpSource, registry, binding: app.http },
  poolDigest: host.poolDigest,
  isolationDigest: host.isolationDigest,
  poolHost: host.poolHost,
  verifyPool: (claim) => host.verifyExclusivePool(claim),
});
const program = mapBindleToAlchemy(
  bindRivetBindleTopicEntrypoint(shop, app),
  mappers,
  { assessRequirements: (requirements) => host.assessRequirements(requirements) },
);
```

The host must persist each provisioning operation ID across process restarts and reuse it when an outcome is unknown. The current mapping supports one captured HTTP application and its named topics; other application dependencies and topic dependents are rejected. It provisions journals before starting the handler and reports an unavailable response if provisioning is not confirmed.
The mapper validates the complete graph and counts the shared
`Rivet.DurableObject` once in the financial inventory. The host must attest the
exact binding, source and exclusive pool before application startup.
The bounded `BindleTopicMapping` model assumes authoritative verifier claims,
sequential provisioning and stable retry identities. It does not prove the
TypeScript implementation or the external provider.
