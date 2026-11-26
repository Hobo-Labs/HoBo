# `@hobo/storage-sqlite` — Architecture Evidence

Portable SQLite EventStore / runtime-journal semantics behind HoBo ports.

## Schema and constraints

- Protobuf boundary records: [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT consumer/provider evidence under [`contracts/`](./contracts).

## Parse, don't validate

Untrusted rows re-enter through codec parsers (`json-v1` / `protobuf-v1`) and
`@hobo/core` `parseEventEnvelope`. Invalid codecs fail closed with
`UNSUPPORTED_CODEC`.

## Event architecture

- **Command** — `commit` / `append` with `expectedSeq` + optional `fenceToken` +
  staged durable effects.
- **Event** — append-only `events` table is source of truth; `streams` holds
  revision + `owner_epoch`.
- **Actor** — fencing via `owner_epoch`; queue/timer/outbox rows stage in the
  same write transaction.
- **Event store** — database-local `global_position` for catch-up and durable
  checkpoints; not part of domain envelope identity.
- **Materialized view / projection** — consumers use `readAll(after)` + durable
  subscription checkpoints.
- **Snapshot** — cache only; never ahead of stream head.
- **Read store** — positioned reads and stream reads over the log.

## Delivery guarantees

- Per-stream optimistic concurrency (`expectedSeq`).
- Fenced single writer per stream (`owner_epoch` / `fenceToken`).
- At-least-once durable subscriptions and outbox dispatch.
- Idempotent effects via keys; **not** exactly-once across external systems.
