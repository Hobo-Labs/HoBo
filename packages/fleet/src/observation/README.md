# Observation (`@hobo/fleet/observation`, lane L03)

Signed observations, fit, one-active eligibility, ranking and claim turns,
fleet views and verdicts, and the reliability ledger (design §6.8). Moved
from `packages/ci/src/mesh/` (`rendezvous.ts`, `reliability.ts`,
`monitor.ts`, `report.ts`); L15 deletes the originals.

| Entry point | What it does |
|---|---|
| `buildObservation(input, signer)` | Local mode (no signer): the observation itself. Authority mode: its protobuf binary signed under `hobo-fleet/observation/v1` with the observer's `SIGN` key. |
| `acceptObservation(keyed, registry, lastIssuedAtMs, nowMs)` | Every rule of §6.8. A refusal names its rule in `error.detail.reason` (`key-mismatch`, `context`, `observer-unknown`, `observer-not-device`, `observer-not-active`, `bundle-invalid`, `bundle-expired`, `key-unknown`, `signature`, `payload`, `member-unknown`, `not-sponsor`, `member-not-active`, `not-in-fleet`, `time-invalid`, `replayed`, `too-far-ahead`, `expired`); the caller counts it once as `hobo_fleet_observation_rejected`. |
| `fitWork(observation, needs)` | Copies of the work that fit, or the first thing lacking. A device that is not `REACHABLE` lacks a `slot`. Absent memory, disk or platform constrain nothing; sandbox tiers are never assumed; `docker` needs an `S3_MICROVM` tier. |
| `failingLongerThan(observation, ms)` | Not `REACHABLE` and `failing_for_ms >= ms`: today's failover threshold. |
| `eligibleForActive(observations, { mode, recoveryPointMs })` | Today's `decideFleet` health tests and reason strings (`unreachable`, `not-ready`, `never-copied`, `lag 21m exceeds rpo 20m`). |
| `rankMembers(digest, candidates)` | Weighted rendezvous over `(WorkDigest, MemberId)`; weight is copies times the reliability weight, clamped to [0.05, 1]. Callers leave out devices below the fleet's `min_agent_version`. |
| `claimTurn(input)` | Rank (capped at `maxRank`) and wait; `waitMs` 0 means claim now; a member not ranked gets rank -1 and an infinite wait. |
| `fleetView(...)` | At most 256 members, active first; availability `LIVE`, `UNHEALTHY` or `LOST`; capacity over every live, active member; `not_after` 120 s after `as_of`. |
| `fleetVerdict(view, label, nowMs)` | `OPEN`, `NO_MEMBER` or `NO_CAPACITY` for live members serving the label; expires at the earlier of 300 s and the view's `not_after`. A truncated view that lists nobody for the label answers from the fleet's capacity. |
| `createReliabilityLedger({ halfLifeMs })` | Decayed delivered and dropped counts from receipts: `STARTED` delivers, `ABANDONED` and `REFUSED` drop (taking back a start), `CANCELLED` counts nothing, each order once. Decayed to the newest receipt recorded. |

`packages/fleet/src/verdict-wire.ts` (`@hobo/fleet/verdict-wire`) parses the
verdict route's protobuf JSON for the route job. It has no imports and loads
with `node --experimental-strip-types` before anything is installed; a
missing, stale, overlong or unreadable verdict is `undefined`.

Tests: `packages/fleet/test/observation/` (`pnpm exec vitest run
packages/fleet/test/observation`). The ranking properties of
`docs/design/ci-relay-mesh.md` "What the tests establish" hold over 6,000
work digests in `ranking.property.test.ts`; `eligibility.test.ts` checks
`eligibleForActive` against `decideFleet` and `routeFleetByBudget` for every
observation of their tests.
