# HOBO-243 MeteringView Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and [ADR-0039](../../adr/02-identity-security.md#adr-0039).

The branch adds `src/draft/technical-proofs/metering-view-projection-contract`, an independent POC for the M1 MeteringView projection skeleton. It proves usage and cost counters can be rebuilt from the event log, folded incrementally, attributed across the principal hierarchy, and emitted as deterministic rollups without implementing showback, quotas, CreditLedgerView, or billing reconciliation.

## Acceptance Evidence

- Replaying a fixture log twice yields the same snapshot digest.
- Incremental live folding reaches the same digest as rebuild-from-zero.
- `seq`-pinned snapshots exclude later events.
- Counters attribute through tenant, Camp, Bindle, run, agent, and team keys.
- `meter.RollupEmitted` events are derived from the pinned snapshot.

## Adversarial Evidence

- Missing owning principals become explicit attribution gaps and are not charged.
- Counter overflow fails closed before unsafe numeric accumulation.
- Duplicate idempotency keys are ignored with duplicate evidence recorded.
- Period-boundary events bucket deterministically by UTC day.
- Missing `cost.json` unit prices fail closed instead of inventing cost.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\metering-view-projection-contract test
npm.cmd test
```
