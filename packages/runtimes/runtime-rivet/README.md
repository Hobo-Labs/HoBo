# `@hobo/runtime-rivet`

Optional **Camp runtime** realizing HoBo `actor()` / `agent()` grains on a
HoBo-owned **actor-local journal**. Rivet is a resolver, not a topology noun
and not an authoring model.

| HoBo contract | Realization |
|---|---|
| `ActorHost` / `defineActor` | Rivet placement + compound key |
| Event facts | `hobo_events` + stream-head CAS in actor SQLite |
| Durable mailbox | action-first `hobo_inbox` (not raw Rivet queue) |
| Effects | `hobo_outbox` staged with facts; dispatch after commit |

In-process wasm and native local remain the fallback. Rivet is the preferred
resolver when matching evidence is current.

Published `rivetkit` 2.3.10 `.cjs` uses `import.meta`, so `require("rivetkit")`
throws. Adapters and CJS hosts must `await import("rivetkit")` via
`loadRivetkit()`. Live tests fail closed: missing package, CJS load error,
engine start failure, or a non-`pong` action is a test failure — never a skip.

## Fidelity

- Default `local-sqlite`: `node:sqlite` behind the same journal schema Rivet `c.db` will host.
- `rivetkit` is advertised only after a pinned package + conformance digest exist.
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

## Actor state and leases

The local SQLite actor host stores `ActorHost.state` events in a dedicated journal stream. Handles for the same actor read the same history, including after reopening the database. Lease ownership and its increasing fence token are stored in SQLite; release or expiry allows a new holder, and stale handles cannot append through the actor host. The host uses a 30-second lease by default, with `leaseTtlMs` and `nowMs` options available for its local clock. The state stream is separate from the command inbox stream.

## Event replay

Actor commands append their original payloads so the same fold can rebuild state after a restart. Each command requires its declared `expectedRevision` to match the revision replayed at commit. A stale command receives a durable `failed-terminal` receipt and does not block later commands. The commit receipt is stored with the facts and outbox rows, so a restart can finish a committed command without applying it again.

Folds must be deterministic and free of side effects.

## Outbox delivery

`processNext` accepts an `effects` callback that derives outbox entries from the folded state and event. It must be deterministic and free of side effects. Each entry has a stream-local `effectId`, digest, and JSON payload; reusing an ID with a different digest or payload fails the whole commit.

Call `dispatchRivetOutbox(journal, streamId, deliver)` to deliver pending entries. A successful callback is acknowledged durably; a failed callback leaves its entry pending for retry. Delivery can repeat after a crash or when dispatchers overlap, so destinations should deduplicate by stream and effect ID.

## Non-guarantees

No cross-actor transaction, no global actor SQL, no exactly-once external
effects, no namespace-as-sandbox, no `wait: true` between actors, no Celld
resolver in this package.
