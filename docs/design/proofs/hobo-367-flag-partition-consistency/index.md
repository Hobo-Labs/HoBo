# HOBO-367 Flag Partition Consistency Proof

This executable proof pins the Harness feature-flag partition contract from
[Plan 29](../../contracts-policy-flags.md#plan-29),
[Plan 05](../../reliability-observability-cost.md#plan-05),
[ADR-0040](../../adr/01-architecture-core.md#adr-0040),
[ADR-0044](../../adr/02-identity-security.md#adr-0044),
[ADR-0050](../../adr/03-data-plane.md#adr-0050), and
[ADR-0083](../../adr/02-identity-security.md#adr-0083).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Under an injected partition, evaluation is deterministic per replica and labeled stale | `partitioned evaluator serves last-known ruleset with stale label while healthy peer advances` |
| Replicas at equal `seq` never disagree | `replicas at the same ruleset seq never diverge` |
| Post-partition resync loses no flip and equals full replay | `post-partition resync equals full replay and does not lose the flip` |
| A stale evaluator never reports fresh | freshness assertions in the partitioned and slow-replica tests |
| Kill-switch propagation latency is asserted within its bound | `kill-switch propagation latency stays within the declared bound` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| A flip lands during partition | reconnect from snapshot plus tail reaches the same ruleset as full replay |
| Clock-skewed replica claims a higher `seq` than it holds | `clock-skewed replica cannot report a higher seq than it holds` |
| Slow replica stalls the Streamer path | `slow replica degrades to stale-labeled reads without blocking healthy evaluators` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/flag-partition-consistency-contract`](../../../../src/draft/technical-proofs/flag-partition-consistency-contract/README.md).
It composes the existing HOBO-319 built-in evaluator and HOBO-326 ruleset-sync
draft packages. Sync transport implementation, evaluator internals,
cross-Camp consistency, provider adapters, and policy-gated flag changes remain
out of scope.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\flag-partition-consistency-contract test
```
