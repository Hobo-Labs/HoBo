# Rivet retained topic-log actor

`createRivetDurableTopicActor` constructs a RivetKit actor definition with an
actor-local SQLite receipt journal. This is an explicitly partial, asynchronous
retained log: it supports topic creation, publication, checkpoint-based log
reads, explicit compaction, and audit reads. It does **not** implement consumer
groups, leases, acknowledgements, dead-letter delivery, the complete HoBo
`DurableMessaging` contract, or the legacy topic WIT/Bindle contract. Group
operations receive a durable `unsupported` receipt. A log reader owns its own
checkpoint and effects; compaction can make its next read return a retention
gap. Consult the frozen `binding.capabilities` instead of inferring support
from a successful actor deployment.

The actor publishes its actual limits on `binding.limits`. They include 128-byte
names, 8,192-byte payloads, 2,048 bytes of attributes, batches of four, 32 topics,
128 retained messages, and 128 retained audit events per authenticated tenant
and instance. The journal retains at most 10,000 unexpired operation receipts;
it will not evict one to admit work. Internal serialized request, receipt and
state ceilings are 131,072, 262,144 and 4,194,304 bytes respectively. The
profile's combination of limits is bounded for base64 and JSON expansion.
The Alchemy adapter's branded binding check must resolve the same
`@hobo/runtime-rivet` module instance as the application; duplicate copies
fail closed instead of accepting an unverifiable actor definition.

A deployment must provide a separately trusted host. For example, with
`trustedHost` implemented by the embedding environment:

```ts
import { createRivetDurableTopicActor } from "@hobo/runtime-rivet";
import { setup } from "rivetkit";
import { trustedHost } from "./trusted-host.js";

const orders = createRivetDurableTopicActor({
  actorName: "orders",
  semanticDigest: trustedHost.ordersSemanticDigest,
  now: () => trustedHost.nondecreasingTimeMs(),
  resolveScope: (identity) => trustedHost.resolveOrdersScope(identity),
  authorize: (claim) => trustedHost.verifyHeldOrdersGrant(claim),
  verifyIngress: (claim) => trustedHost.verifyOrdersIngressFence(claim),
});

export const registry = setup({ use: { orders: orders.actor } });
await registry.start();
```

The example supplies integration points, not a host or a deployed service.
The host must independently enforce the following obligations:

- Authenticate the actor name and key and resolve them to the exact tenant and
  durable instance. `resolveScope` must return a plain own-data
  `{ tenant, instance }` object. Application body fields do not select scope.
- Authorize the current principal for the exact actor, scope, method, operation
  and detached canonical request bytes in each claim. Keep that authorization
  fenced through the SQLite transaction and response disclosure; a verifier
  callback alone cannot hold a distributed grant. Recheck credentials on replay.
- Attest `semanticDigest` against the complete executable and dependency
  closure, fixed reducer and behavior-affecting configuration, actor identity,
  scope and advertised profile. A digest supplied by an application is not an
  attestation. The binding exposes the digest captured at construction so a
  deployment mapper can compare it to the independently verified source fence.
  The journal pins it to the instance. A changed environment, missing pin with
  existing state, or unverified migration fails closed; migration requires a
  separately authenticated transfer and fencing of the previous owner.
- Fence old writers on actor restart, failover and ownership transfer. Use an
  exclusive, trusted, size-limited database and serializable SQLite transactions;
  the journal detects many malformed rows but is not a tamper-proof ledger.
  The synchronous reducer and callbacks are trusted actor code and must be
  isolated from ambient external effects. Supply a trusted nondecreasing clock
  across owner generations.
- Enforce per-request and actor-wide connection, concurrency, memory and ingress
  quotas before buffering or allocating inbound chunks. `verifyIngress` must
  attest those controls and the supplied byte, chunk and header ceilings, and
  maintain the fence while the request is in flight. Protect the response path
  as well. Independently supervise or terminate a blocked actor process; a
  timer in the actor cannot preempt a synchronous verifier, reducer or database
  call.

The actor uses canonical, recursively key-sorted JSON and canonical padded
base64 for message payloads. Mutations use `/ensure-topic`, `/publish` and
`/compact`; `/read-log` provides non-leased retained-log pages and `/events`
provides audit pages. The other mutation endpoints are present only to return
fenced `unsupported` outcomes. A response loss, malformed response, revoked
binding, or unavailable authorization must be treated as an unknown operation
outcome. Reconcile uncertain work against independently authenticated durable
host evidence before considering a replacement operation.
