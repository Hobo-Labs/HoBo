# Session Replay PACT inventory (ADR-0137)

All integration boundaries — **including internal module boundaries** — are
HTTP-shaped via `createReplayHttpSurface` and pinned by consumer/provider PACTs.

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |
|---|---|---|---|---|---|---|---|
| Tracker → Ingest | ReplayTracker | ReplayIngest | HTTP JSON | `pacts/replay-tracker-ingest.pact.json` / `test/pacts/provider-verify.pact.test.ts` | `createReplayHttpSurface` | dual fixtures | active |
| Player → SessionIndex get/list | ReplayPlayer | ReplaySessionIndex | HTTP JSON | `pacts/replay-player-store.pact.json` | same | dual fixtures | active |
| Tracker → Privacy | ReplayTracker | ReplayPrivacy | HTTP JSON | `pacts/replay-privacy.pact.json` | same | none | active |
| Tracker → Policy/Harness | ReplayTracker | ReplayPolicy | HTTP JSON | `pacts/replay-policy.pact.json` | same | env fixtures | active |
| Player → Access/PAM | ReplayPlayer | ReplayAccess | HTTP JSON | `pacts/replay-access.pact.json` | same | none | active |
| Service → Retention/Trails | ReplayService | ReplayRetention | HTTP JSON | `pacts/replay-retention.pact.json` | same | dual fixtures | active |
| Service → Metering/FinOps | ReplayService | ReplayMetering | HTTP JSON | `pacts/replay-metering.pact.json` | same | memory sink | active |
| Evidence → Service | ReplayEvidence | ReplayService | HTTP JSON | `pacts/replay-evidence.pact.json` | same | dual fixtures | active |
| Tracker → Correlation | ReplayTracker | ReplayCorrelation | HTTP JSON | `pacts/replay-correlation.pact.json` | same | none | active |
| Service → Event log | ReplayService | ReplayEventLog | HTTP JSON | `pacts/replay-events.pact.json` | same | none | active |
| Ingest → BlobStore | ReplayIngest | ReplayBlobStore | HTTP JSON | `pacts/replay-blob-store.pact.json` | same | dual fixtures | active |
| Bindle host → HTML inject | BindleWebHost | ReplayHttpSurface | HTTP JSON | `pacts/replay-bindle-host.pact.json` | same | none | active |
| CLI/MCP → Service | HoboReplayCli | ReplayService | HTTP JSON | `pacts/replay-cli-service.pact.json` | same | dual fixtures | active |

Consumer-driven verification: `test/pacts/provider-verify.pact.test.ts` loads every
`*.pact.json` under `contracts/pacts/` and verifies against the live HTTP surface.
Consumer behavior tests: `test/pacts/consumer-boundaries.pact.test.ts`.
