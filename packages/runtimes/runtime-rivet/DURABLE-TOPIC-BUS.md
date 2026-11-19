# Rivet durable topic bus

`createRivetDurableTopicBusActor` constructs a separately pinned RivetKit actor
for the asynchronous topic-bus operations: topic and subscription creation,
publication, group consumption, leases, acknowledgement, negative
acknowledgement, dead letters, explicit compaction, and audit reads. Each
mutation and its terminal receipt use the same actor-local SQLite transaction.
This actor is a different branded profile from the retained-log actor; its state
schema and semantic identity are not interchangeable. A component needs an
explicit durable messaging host binding to use it.

The normal actor setup and independent host responsibilities in the
[retained-log guide](./DURABLE-TOPIC-ACTOR.md) also apply here. In addition, the
bus actor requires `authorizeInstanceScope`: a separately held grant covering
**the entire authenticated instance**, including every source topic,
subscription and possible dead-letter destination. The host must authenticate
and hold this authority through transaction completion and response disclosure,
including replay. A grant for one topic or action is insufficient. The actor
itself does not enforce per-Bindle topic grants; use it only behind a trusted
boundary that enforces any narrower application permissions independently.

```ts
import { createRivetDurableTopicBusActor } from "@hobo/runtime-rivet";
import { setup } from "rivetkit";
import { trustedHost } from "./trusted-host.js";

const orders = createRivetDurableTopicBusActor({
  actorName: "orders",
  semanticDigest: trustedHost.ordersBusSemanticDigest,
  now: () => trustedHost.nondecreasingTimeMs(),
  resolveScope: (identity) => trustedHost.resolveOrdersScope(identity),
  authorize: (claim) => trustedHost.verifyHeldOrdersGrant(claim),
  authorizeInstanceScope: (claim) => trustedHost.verifyHeldBusInstanceGrant(claim),
  declaredTopics: ["orders", "orders-dead-letter"],
  authorizeDeclaredTopics: (claim) => trustedHost.verifyDeclaredTopics(claim),
  verifyIngress: (claim) => trustedHost.verifyOrdersIngressFence(claim),
});

export const registry = setup({ use: { orders: orders.actor } });
await registry.start();
```

The example depends on an independently implemented trusted host; it does not
provide a deployment or an authorization service. The host's semantic digest
must attest the bus reducer, profile, full executable and dependencies,
identity and configuration. It must differ from a digest describing the partial
log profile. The journal rejects a mismatched pin or state schema; this package
currently provides no automatic migration between the profiles.

`declaredTopics` is optional and is limited to 32 unique names. When supplied,
the host must authorize the complete frozen list through
`authorizeDeclaredTopics` as well as authorize the individual request and
instance. The actor creates the declared topics atomically with the first
successful mutation; rejected requests and rolled-back transactions do not
create them. A lost reply can be retried with the same operation ID. Read-only
audit requests before that first mutation do not create topics.

For a nonempty declaration, `orders.semanticDigest` is derived from the host's
supplied semantic digest and the sorted topic names. Use this returned digest in
the client binding and source fence. A changed declaration has a different
identity and cannot open the existing state without an independently managed
transfer. The host must attest the full executable and the declaration; the
digest does not establish that attestation by itself.

The frozen `orders.limits` contains the actual profile, including 64 retained
messages, 16 subscriptions, 32 topics, 8,192-byte payloads, 2,048 attribute
bytes, batches of four and 128 retained audit events. Each externally admitted
publication or subscription obligation reserves a message slot for its possible dead letter;
a publication or subscription can therefore receive a durable
`capacity-exceeded` result before there are 64 physical messages. The reservation
is held across a lease and its retries, released by acknowledgement, and
converted atomically into a dead-letter message on a final nack or final lease
expiry. Newly generated DLQ obligations acquire reservations before they are
leased. A full instance can require compaction of already settled source
messages before further DLQ deliveries can be leased. Compaction never removes
an unsettled obligation, and later earliest subscriptions report the retained
floor and history gap.

There is no unconditional progress guarantee at the hard limit: cyclic DLQ
fanout or unprocessed obligations can fill all available space. The actor
returns explicit capacity outcomes and does not silently discard messages. A
non-destructive increase or move then requires independently authenticated
host ownership transfer and preservation of the complete journal and state;
this package does not yet implement that transfer or a larger-profile migration.
A terminal rejection is replayed for its operation ID even after capacity
changes. An unknown or expired outcome requires independent reconciliation
before a replacement is considered.

Topic sequences, audit sequences and lease identities never wrap or reset.
Exhausting their safe integer space returns `capacity-exceeded` instead of
reusing an identity. Any externally managed transfer must preserve those
counters and all live leases and receipts; resetting them could let an old
consumer settle a new delivery.

The repository's bounded transition explorers and SQLite actor fixtures check
specific state and receipt scenarios, including initialization, authorization,
rollback and replay. The declared-topic model assumes atomic transactions,
collision-resistant digests and a trusted authority; it is not a proof of the
implementation. They do not prove the Rivet engine's
process isolation, trusted host authorization, ownership fencing or liveness;
those remain independent deployment obligations.
