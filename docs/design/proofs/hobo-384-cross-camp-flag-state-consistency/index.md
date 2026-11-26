# HOBO-384 Cross-Camp Flag-State Consistency Proof

This executable proof pins the Harness feature-flag cross-Camp consistency contract from
[Plan 29](../../contracts-policy-flags.md#plan-29),
[Plan 05](../../reliability-observability-cost.md#plan-05),
[ADR-0040](../../adr/01-architecture-core.md#adr-0040), and
[ADR-0044](../../adr/02-identity-security.md#adr-0044).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Flip in writer Camp propagates to follower Camps within declared staleness bound, labeled stale until caught up | `writer flip propagates to followers within bound and becomes fresh only after catch-up` |
| Follower never reports stale flag as fresh | `follower behind the writer never reports stale flag state as fresh` |
| Active-active-eventual concurrent flips converge per ADR-0040 with no lost update | `active-active concurrent flips converge deterministically without losing either update` |
| Cross-Camp kill-switch propagation latency asserted within bound | `writer flip propagates to followers within bound and becomes fresh only after catch-up` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Follower partitioned from writer serves last-known labeled-stale, never blocks | `partitioned follower serves last-known value with unbounded stale label without blocking` |
| Two Camps flipping same flag concurrently converge deterministically | `active-active concurrent flips converge deterministically without losing either update` |
| Follower must not accept a flip out of writer order | `follower rejects out-of-order writer entries and keeps its monotonic state` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/cross-camp-flag-state-consistency-contract`](../../../../src/draft/technical-proofs/cross-camp-flag-state-consistency-contract/README.md).
It consumes the existing flag-event contract and ADR-0040 topology language. Replication backbone implementation, single-Camp partition behavior, flip governance, and provider adapters remain out of scope.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-camp-flag-state-consistency-contract test
```
