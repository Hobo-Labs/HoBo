# SVID Partition Grace Spike

Independent POC for HOBO-266. It records the SVID rotation-under-partition decision before the
production broker HA/cache work in HOBO-287.

## Source Requirements

- [Plan 06: Agent identity & the token broker](../../../../docs/design/ai-native-agent-auth.md#plan-06)
- [ADR-0008](../../../../docs/design/adr/02-identity-security.md#adr-0008)
- [ADR-0047](../../../../docs/design/adr/02-identity-security.md#adr-0047)
- [ADR-0100](../../../../docs/design/adr/02-identity-security.md#adr-0100)
- Prior SVID rotation contract: [`src/draft/technical-proofs/svid-auto-rotation-contract`](../svid-auto-rotation-contract)

## Decision

HoBo should fail open only inside an Identity-signed renewal-grace window that ends no later than the
current SVID `notAfter`. With the standard 15 minute SVID TTL, Identity schedules rotation at 10
minutes and grants at most 5 minutes of partition grace. After that, token renewal and SVID use fail
closed.

The grace is not a client option. It is part of the signed rotation lease, scoped to the existing
tenant/run/agent/scope and usable only for same-or-narrower grants. A workload cannot extend it or
use it to widen scope.

## Prototype Findings

- A partition shorter than the grace window renews from cache under `partition-grace`.
- A partition longer than grace returns `renewal-grace-expired` and emits
  `identity.PartitionGraceExpired`.
- Requested scope widening fails with `scope-widening-requires-identity`.
- A workload-supplied later grace deadline fails with `workload-cannot-extend-renewal-grace`.
- Partition heal rotates exactly once; replay observes the next epoch and reuses it instead of
  double-issuing.

## Handoff To HOBO-287

The production HA broker should implement a signed rotation lease with these fields:

| Field | Requirement |
| --- | --- |
| `rotateAt` | inside the SVID validity window; default at two-thirds TTL |
| `renewalGraceUntil` | no later than current SVID `notAfter` |
| `epoch` | monotonic per run/agent; heal is idempotent by next epoch |
| `scope` | same-or-narrower only while partitioned |
| `signedBy` | Identity-owned, not workload-controlled |

Residual risk: a workload partitioned longer than grace still loses credential continuity. That is
intentional; unbounded stale-credential use is worse than a bounded fail-closed interruption.

## Scope Boundaries

This spike does not implement production broker HA, the credential cache, the happy-path rotation
service, mTLS cert rotation, or the chaos-tier engine. It only pins the grace semantics and provides
executable vectors for HOBO-287.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\svid-partition-grace-spike test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Svid Partition Grace Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
