# Cross-Camp Flag-State Consistency Contract

Independent POC for HOBO-384. It proves the Harness flag-state consistency contract from
[Plan 29](../../../../docs/design/contracts-policy-flags.md#plan-29),
[Plan 05](../../../../docs/design/reliability-observability-cost.md#plan-05),
[ADR-0040](../../../../docs/design/adr/01-architecture-core.md#adr-0040), and
[ADR-0044](../../../../docs/design/adr/02-identity-security.md#adr-0044).

- A feature flag declares a `single-writer-camp` topology with one writer Camp and follower Camps.
- Follower reads consume the writer's replicated flag read-stream and always carry bounded-staleness labels.
- Followers behind the writer serve last-known values as stale, never fresh.
- If the writer heartbeat exceeds the declared TTL, follower reads remain non-blocking and become `partition-suspected`.
- Active-active-eventual concurrent flips converge with a deterministic last-writer/camp-id tiebreak and retain every update in lineage.
- Follower replication is monotonic per writer order and rejects out-of-order entries.

## Scope Boundary

This package does not implement the replication transport, the single-Camp partition engine, flag-flip governance, or provider adapters. It consumes flag events and ADR-0040 topology declarations to prove the cross-Camp state contract.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-camp-flag-state-consistency-contract test
```

The tests cover bounded follower labels, catch-up freshness, stale-not-fresh reads, partition-suspected serving, active-active convergence, kill-switch propagation latency, and writer-order rejection.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cross Camp Flag State Consistency Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
