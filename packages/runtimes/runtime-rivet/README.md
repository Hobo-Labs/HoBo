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
