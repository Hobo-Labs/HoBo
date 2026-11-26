# Runtime Postgres Ports — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted queue bodies,
event envelopes, and stream chunks are parsed once at the SQL boundary into derived
domain types, and downstream port methods receive those parsed, derived types instead
of re-checking raw input. The CUE constraints bound the same derived types so
malformed input is rejected at parse time rather than passed downstream.

## Event Architecture

The postgres runtime ports implement a small event flow:

- **Command** — append, enqueue, lease acquire, and stream write requests enter the ports.
- **Event** — successful commands append domain events to `hobo_events` or actor event tables.
- **Actor** — ActorHost holds the single-writer lease and fencing token per aggregate key.
- **Event store** — `hobo_events` is the durable append-only source of truth per stream.
- **Materialized view / projection** — EventStore `fold` and ActorHost `read` fold streams into state.
- **Snapshot** — checkout and aggregate reads return snapshot state at the current seq.
- **Read store** — queue message rows and stream chunk tables back query-side durability proofs.

No production projector or cross-Camp replication is implemented here; this POC pins
the command, event, actor, and projection boundaries for the S2-02 production package.
