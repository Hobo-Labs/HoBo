# Session Replay local DX path — architecture evidence

Parse, don't validate: journey uses `@hobo/replay` parsers so wire payloads become
**derived domain types** before index/player access.

## Contracts

- Protobuf / CUE: `architecture/replay.proto`, `architecture/replay.cue`
- PACT: `contracts/pacts/replay-tracker-ingest.pact.json`, `replay-player-store.pact.json`

## Event architecture

- **Command** — local `startRecording` / `flush` / `stop` / `summarize` / `open`
- **Events** — `replay.*` lifecycle from dual fixtures
- **Actor** — ReplayService under `station:local`
- **Event store** — metadata-only lifecycle facts (blob refs)
- **Materialized view / projection** — SessionIndex list/get
- **Snapshot** — SessionRecord
- **Read store** — in-memory dual fixtures (air-gap proof path)
