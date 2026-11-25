# Architecture — `@hobo/runtime-rivet`

## Schema and constraints

- Protobuf: [`data-models/runtime_rivet.proto`](./data-models/runtime_rivet.proto)
- CUE: [`data-models/runtime_rivet.cue`](./data-models/runtime_rivet.cue)
- PACT: [`contracts/runtime-rivet-boundary.pact.json`](./contracts/runtime-rivet-boundary.pact.json)

## Parse, don't validate

Parse, don't validate: derived domain types (`RivetRuntimeConfig`,
`RivetDoctorReport`) are produced only by `parseRivetRuntimeConfig`.
`parseLogicalActorIdentity` (core) brands grain keys. SecretRefs are locators;
URL userinfo and plaintext tokens fail closed.

`loadRivetkit` uses dynamic `import("rivetkit")` for ESM and CommonJS hosts.
The pinned RivetKit 3 engine is tested separately; the HoBo journal remains a
local SQLite oracle and remote runtime modes fail closed. Live RivetKit / wasm
tests fail closed (no skip, no timeout-as-pass).

## Event architecture

- **Command** — accept into `hobo_inbox` before ack; claim; fold; `commitCommand`.
- **Event** — append-only `hobo_events` under expected-revision CAS.
- **Actor** — single-writer Rivet placement + fence token (native lease SPI stays native).
- **Event store** — actor-local journal is **not** the global `EventStore`. Outbox publishes outward.
- **Materialized view** — folded grain state; snapshots later.
- **Read store** — doctor/fidelity metadata.

```
Bindle actor() / agent()
        │  ports only
        ▼
Matching prefers rivet when evidence is current
        │
        ▼
@hobo/runtime-rivet
  ├─ ActorHost     → compound key + single-writer
  ├─ Journal       → node:sqlite or future Rivet c.db
  ├─ Inbox         → accept-before-ack
  └─ Outbox        → effects after commit
        │
        ▼
Global EventStore / Streamer / Trails (logical export)
```
