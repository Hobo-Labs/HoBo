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
exercise the pinned upstream engine separately from the HoBo local host, verify
actor state across an engine restart, and fail if the engine or an actor action
fails. Distributed journal coverage includes lease contention, durable appends,
replay, actor sleep and wake. Journal reopen tests cover persisted-state replay
and in-flight commands.

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
- Rivet 3 drops Rivet 2's `@secure-exec` isolate family. The local journal
  host runs no Rivet actor code. The live fixture registers its actor action in
  the fixture process and spawns only the engine binary separately (guard bound
  to 127.0.0.1, admin-token auth); that process boundary is not a security
  sandbox. Untrusted actor code requires a real sandbox before executing with
  credentials.
- The live fixture reserves its engine, peer, metrics and HTTP ports, then
  re-reserves a fresh set (up to three attempts) when a reserved port is
  stolen between reservation and bind; any other failure fails the test with
  the captured engine log.
- The Rivet 3.0.0 engine CLI ships platform packages for darwin (arm64, x64)
  and linux (arm64, x64 — static musl binaries that also run on glibc hosts);
  Rivet 2's win32 package has no 3.0.0 successor. `loadRivetkit()` and the
  local-engine live test reject win32 before native-module loading; Windows
  local-engine paths remain unsupported until upstream ships a binary.
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
