# Architecture — `@hobo/runtime-celld`

## Schema

- Protobuf: `data-models/runtime_celld.proto`
- CUE: `data-models/runtime_celld.cue`
- PACT: `contracts/runtime-celld-boundary.pact.json`

## Parse, don't validate

Parse, don't validate: derived domain types (`CelldRuntimeConfig`,
`CelldDoctorReport`) are produced only by `parseCelldRuntimeConfig`, which
rejects public operator ports, hostile isolation, secret material, filesystem
buckets, and Component Model WASM claims.

## Event architecture

- **Command** — parse fleet config; deploy Worker+DO; increment cell storage.
- **Event** — cell facts stay in HoBo inbox/journal; celld SQLite is the engine.
- **Actor** — grain key → cell name via `actorCompoundKey` (single-writer cell).
- **Event store** — HoBo journal is the semantic boundary; not this package.
- **Materialized view / projection** — folded cell storage (`count` and Worker state).
- **Snapshot** — none required; celld per-cell SQLite is engine-local.
- **Read store** — doctor/fidelity metadata (`overlay`, CAS probe, isolation).

## Explicit non-goals

celld-on-Flux, NATS Object Store as the fleet bucket, hostile multi-tenant scheduling.
