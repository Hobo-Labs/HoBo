# @hobo/replay contracts

Session Replay exposes **every** integration boundary — including internal
module edges — as an HTTP-shaped surface (`createReplayHttpSurface`) so PACT
consumer/provider verification can drive real package code offline.

## Inventory

See [`pact-inventory.md`](./pact-inventory.md) for the full boundary table.

## PACT files

| File | Boundary |
|---|---|
| `pacts/replay-tracker-ingest.pact.json` | Tracker → ingest (mask + kill switch) |
| `pacts/replay-player-store.pact.json` | Player → session index (get/list/station boundary) |
| `pacts/replay-privacy.pact.json` | Tracker → privacy mask |
| `pacts/replay-policy.pact.json` | Tracker → OpenFeature/env policy |
| `pacts/replay-access.pact.json` | Player → PAM/access |
| `pacts/replay-retention.pact.json` | Service → Trails retention recipe |
| `pacts/replay-metering.pact.json` | Service → FinOps metering |
| `pacts/replay-evidence.pact.json` | Evidence pack → service |
| `pacts/replay-correlation.pact.json` | Tracker → correlation |
| `pacts/replay-events.pact.json` | Service → lifecycle event log |
| `pacts/replay-blob-store.pact.json` | Ingest → content-addressed blobs |
| `pacts/replay-bindle-host.pact.json` | Bindle host → HTML bootstrap inject |
| `pacts/replay-cli-service.pact.json` | CLI/MCP → doctor/summarize |

Wire schemas: `../data-models/replay.proto` + `replay.cue`.

## Verification

```bash
pnpm --filter @hobo/replay test
# includes test/pacts/provider-verify.pact.test.ts + consumer-boundaries.pact.test.ts
```

Provider stubs are **not** mocks of external services — they invoke real
`@hobo/replay` modules through the HTTP surface with dual fixtures.
