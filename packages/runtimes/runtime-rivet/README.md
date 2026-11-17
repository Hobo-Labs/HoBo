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

Register `rivetDistributedJournalActor` in a RivetKit registry and pass its
client namespace to `createRivetDistributedJournal` with a tenant and Camp.
The returned `actorHost` implements HoBo's asynchronous lease port; `append`
and `read` use the same actor as the lease authority. A request ID is a lease
capability: generate it with a cryptographically secure random generator and
protect it like a credential. If a grant or append returns `OUTCOME_UNKNOWN`,
reconcile using the same request or event ID. A lease only fences operations
inside this journal; external effects need their own independent fence.

The current actor stores at most 1,024 facts, 4 MiB of fact data and 4,096
lease grants per key. It returns `CAPACITY_EXCEEDED` before exceeding a limit;
the host must provision a new independently identified actor and migrate its
state with verified application-specific evidence. Its asynchronous journal
does not yet implement the local host's durable inbox and transactional outbox.

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
