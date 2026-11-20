# `@hobo/runtime-rivet`

Optional **Camp runtime** with a HoBo-owned local journal and Rivet-compatible
actor keys. The current host is a local oracle; it does not place actors in a
Rivet engine.

| HoBo contract | Realization |
|---|---|
| `ActorHost` / `defineActor` | Local host + Rivet-compatible compound key |
| Event facts | `hobo_events` + stream-head CAS in local SQLite |
| Durable mailbox | action-first `hobo_inbox` (not raw Rivet queue) |
| Effects | `hobo_outbox` staged with facts; dispatch after commit |

RivetKit, its WASM package, and the Rivet Engine image are pinned to 3.0.0.
`loadRivetkit()` uses dynamic import for ESM and CommonJS hosts. The live tests
exercise the pinned upstream engine separately from the HoBo local host and
fail if the engine or an actor action fails.

## Fidelity

- `local-sqlite` uses `node:sqlite` for the local HoBo journal.
- `runner`, `serverless`, and `managed` modes are rejected until a Rivet-backed
  HoBo host is implemented and verified. A local journal cannot be labeled
  `rivetkit`.
- The 3.0.0 pin does not migrate data from an existing Rivet 2 engine. An
  operator must establish and verify an upstream migration before upgrading
  an existing deployment.
- Rivet 3 drops Rivet 2's `@secure-exec` isolate family. Actor code never
  executes in the HoBo host process: the local journal host runs no Rivet
  actor code, and the live fixture spawns the engine binary as its own
  process (guard bound to 127.0.0.1, admin-token auth), so actor actions run
  inside the engine's workers behind that process boundary.
- The Rivet 3.0.0 engine CLI ships platform packages for darwin (arm64, x64)
  and linux (arm64, x64 — static musl binaries that also run on glibc hosts);
  Rivet 2's win32 package has no 3.0.0 successor. There is no Windows engine
  binary at this pin, so Windows local-engine paths are unsupported until
  upstream ships one.
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
