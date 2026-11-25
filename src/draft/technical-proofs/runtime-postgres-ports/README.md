# Runtime Postgres Ports POC

Independent draft POC for **HOBO-617** (`@hobo/runtime-postgres`). Implements the
five Layer-1 runtime ports on PostgreSQL per
[`docs/design/data-plane.md`](../../../../docs/design/data-plane.md) Plan 11 and
[`docs/design/sdk-api.md`](../../../../docs/design/sdk-api.md) Layer 1.

Production target path: `packages/runtimes/runtime-postgres/`. This draft package
promotes the data-plane epic proof fixtures into executable postgres durability tests
without waiting on the S2-01 acceptance record merge.

## Ports

| Port | Postgres mechanism |
|------|-------------------|
| EventStore | `hobo_events` append-only log, optimistic `expectedSeq`, idempotency keys |
| Queue | `hobo_queue_messages` with lease visibility timeout (graphile-worker shape) |
| Clock | runtime-local clock port; `hobo_timers` schema for production timer persistence |
| ActorHost | in-memory fencing with postgres write-through to lease/event tables |
| Streamer | `hobo_stream_chunks`; `pg_notify` on write (LISTEN needs real Postgres) |

## Contract Surface

- `createPostgresDurabilityBackend(options?)` wires all five ports against one pool.
- `createPostgresDurabilityBackendFactory()` adapts the backend for
  `runRuntimePortDurabilitySuite()` from
  `src/draft/technical-proofs/runtime-port-conformance-contract`.
- Tests use **pg-mem** when `DATABASE_URL` is unset; set `DATABASE_URL` for real Postgres
  (`pg` is a declared package dependency for that path).

## Scope Boundaries

**In:**

- Postgres-backed implementations of EventStore, Queue, Clock, ActorHost, Streamer.
- Shared SQL schema migration.
- Runtime-port conformance + checkout replay==live durability proof.
- Protobuf + CUE architecture evidence and PACT boundary.

**Out:**

- Production `packages/runtimes/runtime-postgres/` package layout (S2-02 production slice).
- graphile-worker process integration (queue semantics only).
- Cross-Camp replication, projection host, cloud wiring.

## Verification

```bash
npm --prefix src/draft/technical-proofs/runtime-postgres-ports test
```

## Architecture Evidence

- [`architecture/`](./architecture) — protobuf + CUE
- [`architecture/pacts/`](./architecture/pacts) — PACT boundary
- [`ADR.md`](./ADR.md) — parse-don't-validate and event-flow evidence
