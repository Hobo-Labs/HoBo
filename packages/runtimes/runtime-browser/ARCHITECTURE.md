# `@hobo/runtime-browser` — Architecture Evidence

Browser SQLite WASM adapter for the HoBo DurableEventStore port.

## Schema and constraints

- Protobuf / CUE for browser RPC membrane: [`data-models/`](./data-models).
- PACT evidence: [`contracts/`](./contracts).
- Semantic SQL + migrations: `@hobo/storage-sqlite` (not duplicated here).

## Parse, don't validate

Worker RPC requests parse at the membrane (`parseBrowserStorageRequest`).
SQLite handles never cross into the UI thread or WIT guest.

## Event architecture

Same as `@hobo/storage-sqlite` / runtime-local: append-only log, stream heads,
fencing, positioned reads, durable effects. Browser adds Worker ownership and
OPFS persistence policy.
