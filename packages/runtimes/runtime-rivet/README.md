# `@hobo/runtime-rivet`

Optional **Camp runtime** with a HoBo-owned local journal and Rivet-compatible
actor keys. The local host remains an oracle. The separate distributed journal
uses a real RivetKit actor and an asynchronous lease host.

| HoBo contract | Realization |
|---|---|
| `ActorHost` / `defineActor` | Local host + Rivet-compatible compound key |
| Event facts | `hobo_events` + stream-head CAS in local SQLite |
| Durable mailbox | action-first `hobo_inbox` (not raw Rivet queue) |
| Effects | `hobo_outbox` staged with facts; dispatch after commit |

RivetKit, its WASM package, and the Rivet Engine image are pinned to 3.0.0.
`loadRivetkit()` uses dynamic import for ESM and CommonJS hosts. The live tests
exercise the distributed journal against the pinned upstream engine, including
lease contention, durable appends, replay, actor sleep and wake.

Register `createRivetDistributedJournalActor(verifier)` in a RivetKit registry,
and pass its client namespace, tenant, Camp and capability issuer to
`createRivetDistributedJournal`. Each operation needs a short-lived signed
capability bound to the actor key, action and exact arguments; the actor checks
it against a host-owned authorization policy before accessing its journal.
Keep the signing key and authority outside the deployed actor.

Lease grants, fences, deduplication identities and facts share one actor-local
SQLite transaction. Pages contain at most 16 events of at most 32 KiB each;
use the first page's `revision` as `throughRevision` for subsequent pages. If
a grant or append returns `OUTCOME_UNKNOWN`, reconcile with the same request
or event ID. The asynchronous lease port fences appends in this journal only:
it cannot fence a separate event store or external effects. The asynchronous
journal does not yet implement the local host's durable inbox and outbox.
The actor rejects a clock earlier than any time it has persisted; lease expiry
also relies on the host's clock not moving backward between observations.

## Fidelity

- `local-sqlite` uses `node:sqlite` for the local HoBo journal.
- `runner`, `serverless`, and `managed` modes are rejected until a Rivet-backed
  implementation of the synchronous `ActorHost` contract exists. Use the
  separate asynchronous Rivet journal for distributed leases and facts; a
  local journal cannot be labeled `rivetkit`.
- The 3.0.0 pin does not migrate data from an existing Rivet 2 engine. An
  operator must establish and verify an upstream migration before upgrading
  an existing deployment.
- Raw Rivet queue **receive-loss** is not HoBo at-least-once. Inbox rows are authority.

```ts
import { createRivetRuntimeHost } from "@hobo/runtime-rivet";

const bundle = createRivetRuntimeHost({ tenantId: "acme", campId: "prod" });
const accepted = bundle.actors.accept({
  identity: {
    tenantId: "acme",
    projectId: "shop",
    actorTypeId: "Cart",
    keySegments: ["user-1"],
    schemaVersion: 1,
  },
  commandId: "cmd-1",
  commandType: "addItem",
  payload: { sku: "hat" },
  expectedRevision: 0,
});
```

## Non-guarantees

No cross-actor transaction, no global actor SQL, no exactly-once external
effects, no namespace-as-sandbox, no `wait: true` between actors, no Celld
resolver in this package.

## Durable topic client boundary

`createRivetDurableTopicClient` is an HTTP client and codec for an independently
hosted Rivet durable-topic actor. It does not itself provide the actor, select a
pool, establish journal ownership or advertise topic support. Use it only when
the actor implementation and deployment have been separately verified against
the durable messaging contract.

The trusted host must authenticate the exact actor name, full actor key, tenant,
instance, semantic digest, fixed limits and actor capability descriptor before
issuing a metadata grant or credentials. It must pin the actor to its exclusive journal and pool and fence
all old owners, including work that continues after a timeout. The client sends
canonical, sorted JSON, with message bytes encoded as canonical padded base64.
Its authorization callback receives the exact request bytes and scope; the
actor must independently verify a locally held capability covering those facts
before and throughout its transaction. The response callback must authenticate
the exact response bytes and current disclosure authority. A client-side check
or a Rivet namespace token alone cannot establish these properties.

```ts
import {
  createRivetDurableTopicClient,
  createRivetDurableTopicMetadataGrant,
} from "@hobo/runtime-rivet";

// `binding` and `actor` come from the host's verified deployment registry.
const metadataGrant = createRivetDurableTopicMetadataGrant();
const messaging = createRivetDurableTopicClient({
  binding,
  metadataGrant,
  verifyTransport: (claim) => host.verifyTopicTransport(claim),
  authorize: (request) => host.issueTopicCapability(request),
  revalidate: (response) => host.verifyTopicResponse(response),
  fetch: (path, init) => actor.fetch(path, init),
});
// Inspect `messaging.actorCapabilities` before relying on an actor feature.
// Unsupported calls still reach the actor for durable rejection.
// On revocation, revoke the metadata grant and the host's operation authority.
```

Topic subscription creation, consumption and nack may write to a dead-letter
topic; the host must independently resolve and authorize that destination,
including any later expiry transfer. Audit reads disclose metadata for the whole
instance and need whole-instance authorization. A replayed consume receipt may
contain an expired or superseded lease: independently verify current lease and
authority before external effects. Invalid mutation data after a valid operation
envelope, timeouts, lost replies and contradictory responses return `unknown`
for that exact operation. Retry only the same operation against the same verified
journal, or use independently authenticated reconciliation evidence. A missing
receipt or audit event alone does not prove noncommit.

The client caps request bodies at 131,072 bytes, response bodies at 262,144
bytes, and responses at 4,096 chunks. The mandatory transport verifier must bind the exact fetch adapter and actor
scope to independently enforced request and response stream and per-chunk
allocation limits before the HTTP library materializes a
chunk; the client sees a chunk only after it has been allocated. The host must
also bound CPU, memory, and total in-flight work across all client objects and
processes. `maxInFlight` applies to one client object only; a timed-out slot
remains occupied until that client's underlying work and cancellation settle.
A same-thread timer cannot interrupt a synchronous or non-yielding callback, so
untrusted work needs an independent worker or process watchdog. Revoking a
metadata grant is irreversible; each regrant needs a fresh grant and binding,
and revocation must be propagated and fenced across the host fleet.
