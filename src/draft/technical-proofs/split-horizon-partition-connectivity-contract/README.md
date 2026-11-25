# Split-Horizon Partition Connectivity Contract

Independent proof for HOBO-201.

This package red-teams two fail-open networking paths:

- DNS split-horizon evidence across independent vantages.
- Cross-Yard partition behavior when leased trust freshness cannot be confirmed.

## Contract Surface

- `evaluateSplitHorizonResolution()` blocks promotion when any independent vantage returns a different target, even if most vantages agree, and rejects non-independent vantage evidence before promotion.
- `evaluateTrustLeaseFreshness()` applies the latest trust event by sequence, fails closed when lease freshness cannot be confirmed within the TTL cap, rejects overlong leases, and lets later revocations win over older establishments.
- `routeWithPartitionSafety()` wraps the existing HOBO-151 `routeCrossCampTraffic()` seam and refuses a healthy failover target if the target Yard is unconfirmable during a partition.
- `reconcilePartitionRecovery()` reuses fresh trust evidence to re-run deterministic routing without operator action.

## Scope Boundary

This proof consumes existing DNS-validation, routing-policy, and Junction trust concepts. It does not implement the leased-trust distribution channel, routing-policy realization, DNS adapters, CRDT/data consistency, or concrete tier networking.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\split-horizon-partition-connectivity-contract test
```

The checks cover split-horizon disagreement, DNS vantage independence, healthy-but-unconfirmable failover refusal, TTL-bounded fail-closed partition behavior, overlong lease rejection, deterministic recovery, and superseding trust revocation.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Split Horizon Partition Connectivity Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
